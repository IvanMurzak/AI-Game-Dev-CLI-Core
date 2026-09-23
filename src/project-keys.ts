import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeFileAtomicSync } from "./atomic-file.js";
import type { MachineCredentialProvider } from "./credential-provider.js";
import { DEFAULT_CLOUD_BASE_URL } from "./enroll.js";
import {
  MACHINE_STORE_DIR_NAME,
  defaultCredentialCodec,
  effectiveFamilies,
  type CredentialCodec,
} from "./machine-credentials.js";
import { decodeJwtSubject } from "./oauth-device-flow.js";

/**
 * **Project keys** (project-keys contract §1/§2/§6) — a NON-expiring, revocable credential strictly
 * bound to ONE project pin, written into third-party AI-agent MCP configs (`Authorization: Bearer
 * agd_pk_…`) so an agent with no MCP OAuth of its own (or whose OAuth is unreliable) still reaches
 * that project's engine on the hosted hub.
 *
 * A key is minted by the server (`POST {issuer}/api/mcp/project-keys`) with the machine credential's
 * access token, and the raw value is returned exactly once — so it is cached locally in
 * `~/.ai-game-dev/project-keys.json`, a file SEPARATE from `credentials.json` (older writers of
 * `credentials.json` rewrite the whole document and would drop anything added to it). The cache has
 * the same at-rest protection as the credential store in each language — DPAPI (CurrentUser, the
 * identical {@link CredentialCodec} envelope the credential store uses, so the C# plugin and this
 * package read each other's files) on Windows, `0600` inside a `0700` directory on POSIX — and is
 * written atomically (temp sibling + rename), preserving every unknown field and entry.
 *
 * {@link getOrMintProjectKey} is the §6 get-or-mint rule: reuse the cached entry for
 * `<issuerOrigin>#<pin>` when it belongs to the signed-in account (`sub`) and the server still
 * accepts it (`GET …/project-keys/current` → 200; a TRANSIENT failure also reuses), otherwise mint,
 * cache, and return a fresh key. {@link regenerateProjectKey} always mints and overwrites the entry.
 * Neither ever throws past the boundary: the result is a discriminated union whose `no-login` arm
 * tells setup-mcp to fall back to the URL-only (native OAuth) config.
 */

/** File name of the project-key cache inside the machine store directory. */
export const PROJECT_KEYS_FILE_NAME = "project-keys.json";

/** Schema version of the project-key cache document. */
export const PROJECT_KEYS_SCHEMA_VERSION = 1;

/** The fixed prefix of every project key (`agd_pk_` + `token_urlsafe(32)`). */
export const PROJECT_KEY_PREFIX = "agd_pk_";

/** The mint endpoint path (POST), relative to the issuer (authorization-server root). */
export const PROJECT_KEYS_API_PATH = "/api/mcp/project-keys";

/** The validate endpoint path (GET, authenticated with the project key itself). */
export const PROJECT_KEYS_CURRENT_API_PATH = `${PROJECT_KEYS_API_PATH}/current`;

/** Network timeout for one mint / validate call (ms). */
export const DEFAULT_PROJECT_KEY_HTTP_TIMEOUT_MS = 15_000;

/** The engines a key may be minted for (contract §2 body `engine`). */
export type ProjectKeyEngine = "unity" | "godot" | "unreal" | "unknown";

const PIN_RE = /^[0-9a-f]{8}$/;

/** One cached key (contract §6). Unknown fields are preserved on read. */
export interface ProjectKeyEntry {
  /** The raw key (`agd_pk_…`). Secret. */
  key: string;
  /** The server-side key id. */
  keyId: string;
  /** The 8-lowercase-hex v2 pin the key is bound to. */
  pin: string;
  /** The issuer (authorization-server root) that minted the key, e.g. `https://ai-game.dev`. */
  issuer: string;
  /** The account (`sub`) the key was minted for. Reuse requires it to match the signed-in account. */
  sub?: string;
  /** The engine the key was minted for. */
  engine?: string;
  /** ISO-8601 mint instant (server-reported). */
  createdAt?: string;
  [key: string]: unknown;
}

/** The plaintext cache document (before at-rest protection). Unknown fields are preserved. */
export interface ProjectKeysDocument {
  version?: number;
  keys?: Record<string, ProjectKeyEntry>;
  [key: string]: unknown;
}

/** Structured read result — an unreadable cache is never treated as empty for WRITING. */
export type ProjectKeyStoreState =
  | { status: "ok"; document: ProjectKeysDocument }
  | { status: "missing" }
  | { status: "unreadable"; reason: string; cause?: unknown };

/** Normalize a pin for lookup/comparison (lowercase, trimmed). */
function normalizePin(pin: string): string {
  return pin.trim().toLowerCase();
}

/** The origin of an issuer URL (`https://ai-game.dev`), or the trimmed input when it is not a URL. */
export function issuerOrigin(issuer: string): string {
  const raw = issuer.trim();
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/** The cache key of an entry: `<issuerOrigin>#<pin>` (contract §6). */
export function projectKeyCacheKey(issuer: string, pin: string): string {
  return `${issuerOrigin(issuer)}#${normalizePin(pin)}`;
}

/**
 * The local project-key cache at `<baseDirectory>/project-keys.json` (default `~/.ai-game-dev/`).
 * The at-rest codec defaults to the platform codec shared with the credential store.
 */
export class ProjectKeyStore {
  private readonly _baseDirectory: string;
  private readonly _codec: CredentialCodec;

  constructor(baseDirectory?: string, codec: CredentialCodec = defaultCredentialCodec) {
    this._baseDirectory = baseDirectory ?? path.join(os.homedir(), MACHINE_STORE_DIR_NAME);
    this._codec = codec;
  }

  /** Absolute path of the store directory. */
  get baseDirectory(): string {
    return this._baseDirectory;
  }

  /** Absolute path of the cache file. */
  get filePath(): string {
    return path.join(this._baseDirectory, PROJECT_KEYS_FILE_NAME);
  }

  /** Read + decrypt + parse the cache. Never throws; never deletes or rewrites the file. */
  readState(): ProjectKeyStoreState {
    let raw: Buffer;
    try {
      if (!fs.existsSync(this.filePath)) return { status: "missing" };
      raw = fs.readFileSync(this.filePath);
    } catch (err) {
      return { status: "unreadable", reason: "reading the project-key cache failed", cause: err };
    }
    if (raw.length === 0) return { status: "missing" };

    let plaintext: string;
    try {
      plaintext = this._codec.decrypt(raw).toString("utf-8");
    } catch (err) {
      return { status: "unreadable", reason: "decrypting the project-key cache failed", cause: err };
    }
    if (plaintext.trim().length === 0) return { status: "missing" };

    try {
      const parsed: unknown = JSON.parse(plaintext);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "unreadable", reason: "the project-key cache is not a JSON object" };
      }
      return { status: "ok", document: parsed as ProjectKeysDocument };
    } catch (err) {
      // SECURITY: the parse error quotes decrypted bytes (key material) — keep it on `cause` only.
      return { status: "unreadable", reason: "parsing the project-key cache failed (corrupted content)", cause: err };
    }
  }

  /** The cached entry for `(issuer, pin)`, or undefined (missing/unreadable cache, or no entry). */
  get(issuer: string, pin: string): ProjectKeyEntry | undefined {
    const state = this.readState();
    if (state.status !== "ok") return undefined;
    const entry = state.document.keys?.[projectKeyCacheKey(issuer, pin)];
    return isUsableEntry(entry) ? entry : undefined;
  }

  /**
   * Insert/replace the entry for `(entry.issuer, entry.pin)` and persist atomically, preserving every
   * other entry and every unknown top-level field. The document is re-read immediately before the
   * write so a concurrent writer's other entries survive. Throws when the existing cache is
   * UNREADABLE (it is never overwritten — a DPAPI failure may be recoverable) or the write fails.
   */
  put(entry: ProjectKeyEntry): void {
    const state = this.readState();
    if (state.status === "unreadable") {
      throw new Error(`refusing to overwrite an unreadable project-key cache: ${state.reason}`);
    }
    const current: ProjectKeysDocument = state.status === "ok" ? state.document : {};
    const keys: Record<string, ProjectKeyEntry> = isPlainObject(current.keys) ? { ...current.keys } : {};
    keys[projectKeyCacheKey(entry.issuer, entry.pin)] = { ...entry, pin: normalizePin(entry.pin) };
    const document: ProjectKeysDocument = {
      ...current,
      version: typeof current.version === "number" ? current.version : PROJECT_KEYS_SCHEMA_VERSION,
      keys,
    };
    const bytes = this._codec.encrypt(Buffer.from(JSON.stringify(document, null, 2), "utf-8"));
    writeFileAtomicSync(this.filePath, bytes);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isUsableEntry(entry: unknown): entry is ProjectKeyEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Partial<ProjectKeyEntry>;
  return typeof e.key === "string" && e.key.startsWith(PROJECT_KEY_PREFIX) && typeof e.pin === "string";
}

// ── transport (contract §2) ─────────────────────────────────────────────────────────────────────

/** The body of a mint request (contract §2). */
export interface ProjectKeyMintRequest {
  issuer: string;
  accessToken: string;
  pin: string;
  engine: ProjectKeyEngine;
  machineName: string;
  label?: string;
}

/** A successful mint (contract §2 `201`). */
export interface MintedProjectKey {
  key: string;
  keyId: string;
  pin: string;
  createdAt: string;
}

/** A mint outcome — a value, never a throw. `status` is the HTTP status (0 = network failure). */
export type ProjectKeyMintResult =
  | { ok: true; minted: MintedProjectKey }
  | { ok: false; status: number; reason: string };

/** A validate outcome (`GET …/current`): `invalid` only on an authoritative rejection. */
export type ProjectKeyValidation = "valid" | "invalid" | "transient";

/** The HTTP seam for the mint/validate endpoints (injectable for tests). */
export interface ProjectKeyTransport {
  mint(request: ProjectKeyMintRequest): Promise<ProjectKeyMintResult>;
  validate(issuer: string, key: string, pin: string): Promise<ProjectKeyValidation>;
}

/** Options for {@link HttpProjectKeyTransport}. */
export interface HttpProjectKeyTransportOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The default fetch-backed {@link ProjectKeyTransport}. Never logs key or token material. */
export class HttpProjectKeyTransport implements ProjectKeyTransport {
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;

  constructor(options: HttpProjectKeyTransportOptions = {}) {
    this._fetch = options.fetchImpl ?? fetch;
    this._timeoutMs = options.timeoutMs ?? DEFAULT_PROJECT_KEY_HTTP_TIMEOUT_MS;
  }

  async mint(request: ProjectKeyMintRequest): Promise<ProjectKeyMintResult> {
    const body: Record<string, string> = {
      project_pin: normalizePin(request.pin),
      engine: request.engine,
      machine_name: request.machineName,
    };
    if (request.label) body["label"] = request.label;
    let response: Response;
    try {
      response = await this._fetch(`${issuerOrigin(request.issuer)}${PROJECT_KEYS_API_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch (err) {
      return { ok: false, status: 0, reason: `network error: ${err instanceof Error ? err.name : "unknown"}` };
    }
    const json = await readJson(response);
    if (response.status !== 201 && response.status !== 200) {
      const error = typeof json?.["error"] === "string" ? json["error"] : typeof json?.["detail"] === "string" ? json["detail"] : "";
      return { ok: false, status: response.status, reason: `HTTP ${response.status}${error ? ` ${error}` : ""}` };
    }
    const key = json?.["key"];
    const keyId = json?.["key_id"];
    const pin = json?.["project_pin"];
    if (typeof key !== "string" || !key.startsWith(PROJECT_KEY_PREFIX) || (typeof keyId !== "string" && typeof keyId !== "number")) {
      return { ok: false, status: response.status, reason: "malformed mint response" };
    }
    if (typeof pin !== "string" || normalizePin(pin) !== normalizePin(request.pin)) {
      return { ok: false, status: response.status, reason: "mint response is bound to a different project pin" };
    }
    const createdAt = typeof json?.["created_at"] === "string" ? (json["created_at"] as string) : new Date().toISOString();
    return { ok: true, minted: { key, keyId: String(keyId), pin: normalizePin(pin), createdAt } };
  }

  async validate(issuer: string, key: string, pin: string): Promise<ProjectKeyValidation> {
    let response: Response;
    try {
      response = await this._fetch(`${issuerOrigin(issuer)}${PROJECT_KEYS_CURRENT_API_PATH}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this._timeoutMs),
      });
    } catch {
      return "transient";
    }
    if (response.status === 401) return "invalid";
    if (response.status !== 200) return "transient";
    const json = await readJson(response);
    if (!json) return "transient";
    if (json["active"] === false) return "invalid";
    if (typeof json["project_pin"] === "string" && normalizePin(json["project_pin"]) !== normalizePin(pin)) {
      return "invalid";
    }
    return "valid";
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── get-or-mint (contract §6) ────────────────────────────────────────────────────────────────────

/** Inputs to {@link getOrMintProjectKey} / {@link regenerateProjectKey}. */
export interface GetOrMintProjectKeyOptions {
  /** The v2 routing pin (8 hex). */
  pin: string;
  /** The engine the key is for. */
  engine: ProjectKeyEngine;
  /** The issuer (authorization-server root), e.g. `https://ai-game.dev`. */
  issuer: string;
  /** Display machine name; defaults to `os.hostname()`. */
  machineName?: string;
  /** Optional display label (e.g. the project folder path). */
  label?: string;
  /** The machine credential provider (agent/plugin family access token). */
  credentials: MachineCredentialProvider;
  /** The local cache; defaults to `~/.ai-game-dev/project-keys.json`. */
  store?: ProjectKeyStore;
  /** The HTTP seam; defaults to {@link HttpProjectKeyTransport}. */
  transport?: ProjectKeyTransport;
}

/**
 * The outcome of get-or-mint:
 *  - `ok` — a usable key; `source` says whether it was `reused` from the cache or freshly `minted`.
 *    `warnings` carries non-fatal notes (e.g. the cache could not be written).
 *  - `no-login` — no usable machine credential for this issuer: fall back to the URL-only config.
 *  - `error` — minting failed (network, server rejection); fall back to the URL-only config.
 */
export type ProjectKeyResult =
  | { kind: "ok"; key: string; keyId: string; pin: string; source: "reused" | "minted"; warnings: string[] }
  | { kind: "no-login"; reason: string }
  | { kind: "error"; reason: string };

/** Get-or-mint a project key for `(issuer, pin)` per contract §6. Never throws. */
export async function getOrMintProjectKey(options: GetOrMintProjectKeyOptions): Promise<ProjectKeyResult> {
  return resolveProjectKey(options, false);
}

/** Mint a fresh key for `(issuer, pin)`, overwrite the cache entry, and return it. Never throws. */
export async function regenerateProjectKey(options: GetOrMintProjectKeyOptions): Promise<ProjectKeyResult> {
  return resolveProjectKey(options, true);
}

async function resolveProjectKey(options: GetOrMintProjectKeyOptions, forceMint: boolean): Promise<ProjectKeyResult> {
  try {
    const pin = normalizePin(options.pin);
    if (!PIN_RE.test(pin)) return { kind: "error", reason: `invalid project pin "${options.pin}"` };
    const store = options.store ?? new ProjectKeyStore(options.credentials.store.baseDirectory);
    const transport = options.transport ?? new HttpProjectKeyTransport();

    const login = currentLogin(options.credentials, options.issuer);
    if (login.kind === "no-login") return login;

    // Reuse needs only the account identity + the key's own validity — never the access token, so
    // a near-expiry machine token does not trigger a refresh round-trip here.
    if (!forceMint) {
      const cached = store.get(options.issuer, pin);
      if (cached && login.sub !== undefined && cached.sub === login.sub) {
        const verdict = await transport.validate(options.issuer, cached.key, pin);
        if (verdict !== "invalid") {
          return { kind: "ok", key: cached.key, keyId: cached.keyId, pin, source: "reused", warnings: [] };
        }
      }
    }

    let accessToken: string;
    try {
      accessToken = await options.credentials.getAccessToken({ family: "plugin" });
    } catch (err) {
      return { kind: "no-login", reason: err instanceof Error ? err.message : String(err) };
    }
    const request: ProjectKeyMintRequest = {
      issuer: options.issuer,
      accessToken,
      pin,
      engine: options.engine,
      machineName: options.machineName ?? os.hostname(),
      label: options.label,
    };
    let minted = await transport.mint(request);
    if (!minted.ok && minted.status === 401) {
      // Reactive: the access token was rejected — refresh once and retry with the rotated token.
      const refreshed = await options.credentials.refresh({ family: "plugin" }).catch(() => null);
      if (refreshed?.accessToken) minted = await transport.mint({ ...request, accessToken: refreshed.accessToken });
    }
    if (!minted.ok) return { kind: "error", reason: `minting a project key failed: ${minted.reason}` };

    const warnings: string[] = [];
    try {
      // The read-merge-write runs under the machine store lock (credentials.lock — shared with the
      // C# plugin), so two concurrent writers cannot drop each other's entries.
      await options.credentials.lock.withLock(() => store.put({
        key: minted.minted.key,
        keyId: minted.minted.keyId,
        pin,
        issuer: issuerOrigin(options.issuer),
        sub: login.sub,
        engine: options.engine,
        createdAt: minted.minted.createdAt,
      }));
    } catch (err) {
      warnings.push(
        `The project key was minted but could not be cached (${err instanceof Error ? err.message : String(err)}); ` +
          "the next setup will mint another one.",
      );
    }
    return { kind: "ok", key: minted.minted.key, keyId: minted.minted.keyId, pin, source: "minted", warnings };
  } catch (err) {
    return { kind: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

type LoginState = { kind: "ok"; sub: string | undefined } | { kind: "no-login"; reason: string };

/**
 * The signed-in account for `issuer`, from ONE read of the machine store. The credential must have
 * been issued BY this issuer (its `serverTarget` origin; absent ⇒ the hosted default) — presenting
 * another server's access token here would leak it, so a mismatch is `no-login`. The account `sub`
 * is the stored `subject`, else the `sub` claim of the agent/plugin/legacy access token.
 */
function currentLogin(credentials: MachineCredentialProvider, issuer: string): LoginState {
  let document;
  try {
    document = credentials.store.read();
  } catch {
    return { kind: "no-login", reason: "the machine credential store is unreadable — sign in again" };
  }
  if (!document) return { kind: "no-login", reason: "not signed in" };
  const target = typeof document.serverTarget === "string" && document.serverTarget ? document.serverTarget : DEFAULT_CLOUD_BASE_URL;
  if (issuerOrigin(target) !== issuerOrigin(issuer)) {
    return { kind: "no-login", reason: `the machine credential belongs to ${issuerOrigin(target)}, not ${issuerOrigin(issuer)}` };
  }
  const families = effectiveFamilies(document);
  const token = (families.agent ?? families.plugin ?? families.legacy)?.accessToken;
  if (!token) return { kind: "no-login", reason: "not signed in" };
  const sub = (typeof document.subject === "string" && document.subject) || decodeJwtSubject(token);
  return { kind: "ok", sub: sub || undefined };
}
