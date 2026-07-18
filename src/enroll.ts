import * as fs from "node:fs";
import * as path from "node:path";

import type { EngineAdapter } from "./engine-adapter.js";
import type { MachineCredentialStore } from "./machine-credentials.js";
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
  const subject = nonEmptyString(data["subject"]) ?? nonEmptyString(data["sub"]);

  let expiresAt = nonEmptyString(data["expires_at"]) ?? nonEmptyString(data["expiresAt"]);
  const expiresIn = numberOrUndefined(data["expires_in"]) ?? numberOrUndefined(data["expiresIn"]);
  if (!expiresAt && expiresIn !== undefined) {
    expiresAt = new Date(now() + expiresIn * 1000).toISOString();
  }
  return { accessToken, refreshToken, expiresAt, serverTarget, subject };
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
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RunEnrollResult {
  serverTarget: string;
  pin: string;
  credentialPath: string;
  markerPath: string;
  pinnedConfigs: string[];
}

/**
 * Execute the full enrollment side effect: redeem → persist the plugin credential to the SHARED machine
 * store → write the project marker with the AS-root server target (MED-2) → upsert the v2 pin (B5 fix)
 * into existing project-local configs. On a redeem failure NOTHING is written.
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

  opts.store.write({
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    serverTarget,
    subject: credential.subject,
  });

  const markerPath = writeProjectMarker(opts.projectPath, { serverTarget });

  // v2 pin (B5): one normalization for every engine — no per-CLI `\`→`/` workaround.
  const pin = derivePinV2(path.resolve(opts.projectPath));
  const { updatedFiles } = upsertProjectPinIntoConfigs(opts.projectPath, pin, opts.adapter.serverName);

  return {
    serverTarget,
    pin,
    credentialPath: opts.store.credentialsPath,
    markerPath,
    pinnedConfigs: updatedFiles,
  };
}
