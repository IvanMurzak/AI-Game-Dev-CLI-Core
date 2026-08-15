import * as fs from "node:fs";
import * as path from "node:path";

import { MachineCredentialLock } from "./credential-lock.js";
import type { EngineAdapter } from "./engine-adapter.js";
import {
  commitFamilyUnderHold,
  runAccountSwitchGuard,
  type RevokeTokenFn,
} from "./login-commit.js";
import type { MachineCredentialStore, MachineTokenFamily } from "./machine-credentials.js";
import { DEFAULT_PLUGIN_SCOPE } from "./oauth-device-flow.js";
import { derivePinV2 } from "./project-identity.js";
import { writeProjectMarker } from "./project-marker.js";
import { pinUrl } from "./routing.js";
import { agentRegistry } from "./agents-registry.js";

/**
 * Agent-driven enrollment (design 06/09 D13) — the engine-agnostic port of the CLIs' `enroll` flow.
 * Redeem a one-time enrollment code (minted by the server's `enroll_engine_plugin` tool from an
 * already-authorized agent session) for a plugin credential, with NO browser hop: plant the credential
 * in the SHARED machine store, record the enrolled server target in the committable project marker, and
 * upsert the `/p/<pin>` routing segment into existing project-local agent configs.
 *
 * Two carry-forwards from the design:
 *   - **v2 pin (defect B5):** the pin is derived with {@link derivePinV2} (the `\`→`/` normalization),
 *     which REPLACES the Unity CLI's local `projectRootForIdentity` `\`→`/` workaround — one algorithm
 *     for every engine, so a Windows `path.resolve` backslash root matches the plugin's forward-slash
 *     hash.
 *   - **serverTarget = AS root (b2 review MED-2):** the marker records
 *     {@link EngineAdapter.loginServerTarget}(redeemed target) — the AS root, NEVER a pinned
 *     `/mcp/p/<pin>` hub URL, so the credential's refresh base is correct.
 */

/** The default hosted authorization-server base. */
export const DEFAULT_CLOUD_BASE_URL = "https://ai-game.dev";

/** Raised on any enrollment-redeem failure. Carries the HTTP status when one was received. */
export class EnrollmentError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "EnrollmentError";
    this.status = status;
  }
}

/** Credential material returned by a successful `/api/auth/enroll/redeem`. */
export interface RedeemedCredential {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  serverTarget?: string;
  subject?: string;
  /**
   * The OAuth client id the credential was minted under (O5/a6 adds `client_id` to the redeem
   * response). Optional-but-preferred: older servers omit it, and the store never INFERS one
   * (04 §1) — absent here means absent in the stored family.
   */
  clientId?: string;
}

export interface RedeemOptions {
  /** Authorization-server base; defaults to {@link DEFAULT_CLOUD_BASE_URL}. */
  baseUrl?: string;
  /** `fetch` injection (tests). */
  fetchImpl?: typeof fetch;
  /** Request timeout (ms); defaults to 30s. */
  timeoutMs?: number;
  /** Injectable clock (ms); defaults to `Date.now`. */
  now?: () => number;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Normalize the redeem response. The AS's JSON key casing is not re-derivable from this repo, so both
 * snake_case and camelCase are accepted defensively; `expires_in` seconds convert to an absolute
 * `expiresAt` ISO timestamp when no explicit `expires_at` is present.
 */
export function normalizeRedeemResponse(data: Record<string, unknown>, now: () => number = Date.now): RedeemedCredential {
  const accessToken = nonEmptyString(data["access_token"]) ?? nonEmptyString(data["accessToken"]);
  const refreshToken = nonEmptyString(data["refresh_token"]) ?? nonEmptyString(data["refreshToken"]);
  const serverTarget =
    nonEmptyString(data["server_target"]) ??
    nonEmptyString(data["serverTarget"]) ??
    nonEmptyString(data["server_url"]) ??
    nonEmptyString(data["serverUrl"]);
  // `sub` is the O5/a6 contract field and is PREFERRED; `subject` is the defensive legacy alias
  // (a6 lands in parallel with this code, so both spellings must stay readable).
  const subject = nonEmptyString(data["sub"]) ?? nonEmptyString(data["subject"]);
  const clientId = nonEmptyString(data["client_id"]) ?? nonEmptyString(data["clientId"]);

  let expiresAt = nonEmptyString(data["expires_at"]) ?? nonEmptyString(data["expiresAt"]);
  const expiresIn = numberOrUndefined(data["expires_in"]) ?? numberOrUndefined(data["expiresIn"]);
  if (!expiresAt && expiresIn !== undefined) {
    expiresAt = new Date(now() + expiresIn * 1000).toISOString();
  }
  return { accessToken, refreshToken, expiresAt, serverTarget, subject, clientId };
}

/**
 * Redeem an enrollment code against `POST <baseUrl>/api/auth/enroll/redeem` with body `{enroll_code}`.
 * The code travels ONLY in the request body (never a query string). A non-2xx surfaces as an actionable
 * {@link EnrollmentError} (invalid/expired/already-used all return a uniform server error).
 */
export async function redeemEnrollmentCode(code: string, opts: RedeemOptions = {}): Promise<RedeemedCredential> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${baseUrl}/api/auth/enroll/redeem`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enroll_code: code }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new EnrollmentError(
      `Could not reach the enrollment server at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new EnrollmentError(
      `Enrollment failed (HTTP ${response.status}). The enrollment code may be invalid, expired, or already ` +
        `used — ask the agent to issue a fresh code and try again.`,
      response.status,
    );
  }

  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new EnrollmentError("Enrollment server returned a malformed (non-JSON) response.");
  }

  const credential = normalizeRedeemResponse(data, opts.now);
  if (!credential.accessToken) {
    throw new EnrollmentError("Enrollment response did not contain an access token.");
  }
  return credential;
}

/**
 * Resolve the enrollment code from `--enroll <code>` (argv) or `--enroll-stdin` (stdin), enforcing
 * mutual exclusion. `readStdin` is invoked ONLY in stdin mode, so the code never lands in argv/history.
 */
export function resolveEnrollCode(
  opts: { enroll?: string; enrollStdin?: boolean },
  readStdin: () => string,
): string {
  if (opts.enroll && opts.enrollStdin) throw new Error("Use either --enroll <code> or --enroll-stdin, not both.");
  if (opts.enrollStdin) {
    const code = readStdin().trim();
    if (!code) throw new Error("No enrollment code received on stdin.");
    return code;
  }
  if (opts.enroll) {
    const code = opts.enroll.trim();
    if (!code) throw new Error("Enrollment code (--enroll) is empty.");
    return code;
  }
  throw new Error("An enrollment code is required: pass --enroll <code> or --enroll-stdin.");
}

export interface PinUpsertResult {
  updatedFiles: string[];
}

/**
 * Upsert the `/p/<pin>` routing segment into every EXISTING project-local JSON agent config that
 * carries the adapter's server entry with a `url` / `serverUrl`. User-global configs (Claude Desktop,
 * Antigravity, Cline, Copilot CLI) are never touched; TOML (Codex) is left to its own configurator.
 * Returns the files actually rewritten.
 */
export function upsertProjectPinIntoConfigs(projectRoot: string, pin: string, serverName: string): PinUpsertResult {
  const resolvedProject = path.resolve(projectRoot);
  const updatedFiles: string[] = [];

  for (const agent of agentRegistry) {
    if (agent.configFormat !== "json") continue;
    const configPath = agent.getConfigPath(resolvedProject);
    const relative = path.relative(resolvedProject, configPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue; // project-scoped only
    if (!fs.existsSync(configPath)) continue;

    let root: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      root = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    const body = root[agent.bodyPath];
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const entry = (body as Record<string, unknown>)[serverName];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;

    const entryRecord = entry as Record<string, unknown>;
    let changed = false;
    for (const key of ["url", "serverUrl"]) {
      const current = entryRecord[key];
      if (typeof current === "string" && current.length > 0) {
        const pinned = pinUrl(current, pin);
        if (pinned !== current) {
          entryRecord[key] = pinned;
          changed = true;
        }
      }
    }
    if (changed) {
      fs.writeFileSync(configPath, JSON.stringify(root, null, 2) + "\n");
      updatedFiles.push(configPath);
    }
  }

  return { updatedFiles };
}

export interface RunEnrollOptions {
  code: string;
  projectPath: string;
  adapter: EngineAdapter;
  store: MachineCredentialStore;
  /** The 04 §2 cross-process store lock; defaults to one on the store's own directory. */
  lock?: MachineCredentialLock;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /**
   * D6/F7 account-switch confirmation (review fix B1): called when the redeemed credential's
   * `sub` differs from the store's subject. ABSENT ⇒ a mismatch is DECLINED (fail closed — on a
   * CI runner an unconfirmable switch must abort, `--yes`-gated on the CLIs).
   */
  confirmAccountSwitch?: (info: {
    storedSubject: string;
    newSubject: string;
  }) => boolean | Promise<boolean>;
  /** Injectable best-effort revoker; defaults to RFC 7009 against the redeemed serverTarget. */
  revokeToken?: RevokeTokenFn;
  onWarning?: (message: string) => void;
}

export type RunEnrollResult =
  /** Redeem + store commit + project marker + pin upsert all completed. */
  | {
      status: "enrolled";
      serverTarget: string;
      pin: string;
      credentialPath: string;
      markerPath: string;
      pinnedConfigs: string[];
    }
  /**
   * D6/F7 decline (review fix B1): the machine is authorized as a DIFFERENT account and the
   * switch was not confirmed. The just-redeemed family was revoked best-effort; the store, the
   * project marker, and the agent configs are all untouched.
   */
  | { status: "switch-declined"; storedSubject: string; newSubject: string }
  /** The store's subject changed between the guard evaluation and the write hold (B2b); retry. */
  | { status: "aborted"; reason: "guard-premise-changed" };

/**
 * Execute the full enrollment side effect: redeem → persist the plugin credential to the SHARED machine
 * store → write the project marker with the AS-root server target (MED-2) → upsert the v2 pin (B5 fix)
 * into existing project-local configs. On a redeem failure NOTHING is written.
 *
 * The persist is a **plugin-family write under the 04 §2 lock** (enroll is the browser-less
 * tools-only mint path — F10): `families.plugin` (+ v1 mirror) carries the redeemed tokens, the
 * response's `client_id` when the server provides one (O5/a6 — never inferred), and
 * `scope=mcp:plugin`; any OTHER family already on the machine (e.g. an agent family) is
 * preserved. `subject` is written from the response's `sub` and simply omitted when unknown.
 * `replaceUnreadable` stays set — enrolling IS an explicit re-authorization, so it may replace
 * an unreadable store (04 §1; the pre-v2 bare-write path had the same semantic).
 *
 * **The D6/F7 account-switch guard applies here too (review fix B1).** Post-a6 the redeem
 * response carries `sub`; redeeming a code for account B on a machine authorized as A is an
 * account switch, and without the guard it would silently produce a mixed-account store
 * (subject B beside A's agent family). The persist routes through the SAME guard primitive as
 * every other login surface: mismatch ⇒ confirm-required; decline (or no confirm callback —
 * fail closed) ⇒ revoke the just-redeemed family best-effort and abort with NOTHING written
 * (no store write, no project marker, no pin upsert); confirm ⇒ revoke A's families and
 * REPLACE the store (single-account, D6). Pre-a6 servers return no `sub` — nothing to compare,
 * today's merge behavior is kept (F7.3).
 */
export async function runEnroll(opts: RunEnrollOptions): Promise<RunEnrollResult> {
  const credential = await redeemEnrollmentCode(opts.code, {
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
  });

  // MED-2: record the AS ROOT, never a pinned hub URL — this is the credential's refresh base.
  const rawTarget = credential.serverTarget ?? opts.baseUrl ?? DEFAULT_CLOUD_BASE_URL;
  const serverTarget = opts.adapter.loginServerTarget(rawTarget);

  // B1: the same D6/F7 guard every login surface runs, BEFORE any write. The revocation id is
  // the redeemed family's own client id when the server names one, else the adapter's (F6.2).
  const guard = await runAccountSwitchGuard({
    store: opts.store,
    clientId: credential.clientId ?? opts.adapter.clientId,
    credentials: {
      accessToken: credential.accessToken,
      ...(credential.refreshToken !== undefined ? { refreshToken: credential.refreshToken } : {}),
      ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
      serverTarget,
      ...(credential.subject !== undefined ? { subject: credential.subject } : {}),
    },
    confirmAccountSwitch: opts.confirmAccountSwitch,
    revokeToken: opts.revokeToken,
    fetchImpl: opts.fetchImpl,
    onWarning: opts.onWarning,
  });
  if (guard.kind === "declined") {
    return {
      status: "switch-declined",
      storedSubject: guard.storedSubject,
      newSubject: guard.newSubject,
    };
  }

  const pluginFamily: MachineTokenFamily = {
    accessToken: credential.accessToken,
    ...(credential.refreshToken !== undefined ? { refreshToken: credential.refreshToken } : {}),
    ...(credential.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
    ...(credential.clientId !== undefined ? { clientId: credential.clientId } : {}),
    scope: DEFAULT_PLUGIN_SCOPE,
  };
  const lock = opts.lock ?? new MachineCredentialLock(opts.store.baseDirectory);
  const hold = await commitFamilyUnderHold({
    store: opts.store,
    lock,
    name: "plugin",
    family: pluginFamily,
    serverTarget,
    subject: credential.subject,
    guard,
  });
  if (!hold.committed) {
    opts.onWarning?.(
      "Enrollment aborted: the machine's stored account changed while the enrollment was being confirmed; retry to re-evaluate.",
    );
    return { status: "aborted", reason: "guard-premise-changed" };
  }

  const markerPath = writeProjectMarker(opts.projectPath, { serverTarget });

  // v2 pin (B5): one normalization for every engine — no per-CLI `\`→`/` workaround.
  const pin = derivePinV2(path.resolve(opts.projectPath));
  const { updatedFiles } = upsertProjectPinIntoConfigs(opts.projectPath, pin, opts.adapter.serverName);

  return {
    status: "enrolled",
    serverTarget,
    pin,
    credentialPath: opts.store.credentialsPath,
    markerPath,
    pinnedConfigs: updatedFiles,
  };
}
