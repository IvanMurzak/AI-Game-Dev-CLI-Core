import { REFRESH_HTTP_TIMEOUT } from "./credential-lock.js";
import { describeErrorWithCause } from "./network-error.js";
import { tokenUrl, type DeviceTokenResponse } from "./oauth-device-flow.js";

/**
 * Exchanges a stored refresh token for a fresh access token at `{serverTarget}/oauth/token`
 * (`grant_type=refresh_token`) — the shared TypeScript refresher of unified-machine-auth 04 §3.
 * It is the HTTP seam only; the {@link MachineCredentialProvider} owns the machine store, the
 * cross-process lock, and the refresh scheduling.
 *
 * The 04 §3 wire rules are load-bearing and pinned by tests:
 *
 *  - **The request presents the family's stored `clientId`** (rule 2), carried per-request in
 *    {@link TokenRefreshRequest} — this class has NO client id of its own, so a component default
 *    can never leak into another family's refresh (the production `client_id mismatch` metric,
 *    mirror of probe Q1).
 *  - **`scope` and `resource` are omitted ENTIRELY** (rule 3). The server falls back to the stored
 *    grant; sending a component default would permanently narrow an agent family to that scope
 *    (P0-3 — Unity's legacy refresher did exactly this). O11 may later reintroduce `resource`
 *    with the canonical value; that is a deliberate follow-up, never a default here.
 *  - The network timeout defaults to {@link REFRESH_HTTP_TIMEOUT} (15 s) — the 04 §2 lock-protocol
 *    constant, explicitly set so a live lock holder inside one HTTP call can never be declared
 *    stale (`REFRESH_HTTP_TIMEOUT < LOCK_STALE_MS`).
 *
 * It **fails closed**: any non-success, missing access token, or exception becomes a
 * {@link TokenRefreshResult} failure — never a throw past the boundary, and it never logs token
 * material. A refresh-token family-revoke (rotation-reuse detection on the server) surfaces here as
 * a failure with the server's error (`invalid_grant`), which the provider turns into a clean
 * `login required`.
 */

/**
 * The result of a refresh attempt — a value, never a throw. A failure carries the OAuth `error`
 * code as `reason`, the server's `error_description` (when sent) as `description`, and
 * `transient: true` when the outcome says nothing about the token itself (network error, timeout,
 * 5xx/429/408, an unparseable body) — the provider retries those promptly so a lost-response
 * retry lands inside the server's rotation grace window instead of after it.
 */
export type TokenRefreshResult =
  | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { ok: false; reason: string; description?: string; transient?: boolean };

/**
 * True when the server refused the refresh ONLY because the presented `client_id` is not the one
 * the refresh token was minted under. The AS checks this on a live, unrevoked, unexpired token and
 * writes nothing (AI-Game-Dev-Server `grant_refresh_token`), so the token is still good for its
 * real mint client — this is NOT a dead family.
 */
export function isClientIdMismatch(result: TokenRefreshResult): boolean {
  return !result.ok && result.reason === "invalid_grant" && isClientIdMismatchText(result.description);
}

/** True when a server description / recorded reason names a client-id mismatch. */
export function isClientIdMismatchText(text: string | undefined): boolean {
  return text !== undefined && /client_id does not match/i.test(text);
}

/** The body could not be parsed as JSON (an HTML proxy/error page) — never a verdict on the token. */
const INVALID_TOKEN_RESPONSE = "invalid token response";

/** HTTP statuses whose failure says nothing about the presented token (retry, never "dead"). */
function isTransientStatus(statusCode: number): boolean {
  return statusCode >= 500 || statusCode === 429 || statusCode === 408;
}

/**
 * One refresh request (04 §3): the family's rotating refresh token plus the **stored `clientId`
 * of that family** — for `families.legacy` (mint client unknown by definition) the caller passes
 * its component-default id (§3.7, status-quo behavior). `scope`/`resource` are deliberately NOT
 * part of this shape (rule 3).
 */
export interface TokenRefreshRequest {
  /** The family's current rotating refresh token. */
  refreshToken: string;
  /** The OAuth client id the family was minted under (stored per family — 04 §1/D8). */
  clientId: string;
  /** The credential's server target (AS root or `/mcp` hub URL — normalized before use). */
  serverTarget?: string;
  /** Cancellation. */
  signal?: AbortSignal;
}

/** The refresh transport seam (injectable for tests). */
export interface TokenRefresher {
  refresh(request: TokenRefreshRequest): Promise<TokenRefreshResult>;
}

/**
 * Normalize a stored server target to the AS root: trim a trailing slash and a trailing `/mcp` hub
 * segment so `/oauth/token` resolves on the authorization-server root. Mirrors the C#
 * `HttpTokenRefresher.NormalizeBase`.
 */
export function normalizeServerBase(serverTarget: string | undefined | null): string | null {
  if (!serverTarget || !serverTarget.trim()) {
    return null;
  }
  let s = serverTarget.trim().replace(/\/+$/, "");
  if (/\/mcp$/i.test(s)) {
    s = s.slice(0, s.length - "/mcp".length);
  }
  return s;
}

/**
 * Build the RFC 6749 refresh-token grant form (04 §3): exactly `grant_type` + `refresh_token` +
 * `client_id`, nothing else. `scope` and `resource` are omitted ENTIRELY (rule 3) — the server
 * falls back to the stored grant, and a component-default `scope` here would permanently narrow
 * an agent family (P0-3).
 */
export function buildRefreshForm(refreshToken: string, clientId: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

/** Turn a parsed token response into a {@link TokenRefreshResult} (mirrors the C# `BuildResult`). */
export function buildRefreshResult(
  isSuccessStatus: boolean,
  statusCode: number,
  parsed: DeviceTokenResponse | null,
  now: () => number = Date.now,
): TokenRefreshResult {
  if (parsed == null) {
    // An empty body on an error status (a bare 502 from a proxy) says nothing about the token.
    return { ok: false, reason: "empty token response", ...(!isSuccessStatus && { transient: true }) };
  }
  if (!isSuccessStatus || !parsed.access_token) {
    const failure: TokenRefreshResult = {
      ok: false,
      reason: parsed.error ?? `refresh failed (HTTP ${statusCode})`,
    };
    if (typeof parsed.error_description === "string" && parsed.error_description.trim()) {
      failure.description = parsed.error_description.trim();
    }
    // A definitive OAuth error code on a 4xx is a verdict on the token; a 5xx/429/408 or a
    // non-OAuth body (no `error` code, an HTML page) is not.
    if (
      !isSuccessStatus &&
      (isTransientStatus(statusCode) ||
        parsed.error === undefined ||
        parsed.error === INVALID_TOKEN_RESPONSE ||
        parsed.error === "temporarily_unavailable")
    ) {
      failure.transient = true;
    }
    return failure;
  }
  const result: TokenRefreshResult = { ok: true, accessToken: parsed.access_token };
  if (parsed.refresh_token) {
    result.refreshToken = parsed.refresh_token;
  }
  if (typeof parsed.expires_in === "number" && parsed.expires_in > 0) {
    result.expiresAt = new Date(now() + parsed.expires_in * 1000).toISOString();
  }
  return result;
}

/** Options for the default fetch-backed refresher. */
export interface HttpTokenRefresherOptions {
  /** The AS root used when a credential carries no `serverTarget`. */
  defaultServerBaseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Per-request network timeout (ms). Defaults to {@link REFRESH_HTTP_TIMEOUT} (15 s) — the 04 §2
   * ordered lock constant (`REFRESH_HTTP_TIMEOUT < LOCK_STALE_MS < ACQUIRE_BUDGET`). Overriding it
   * above `LOCK_STALE_MS` in shipping code breaks the cross-language ordering invariant.
   */
  timeoutMs?: number;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
}

/** The default {@link TokenRefresher}: a form-encoded `grant_type=refresh_token` POST via `fetch`. */
export class HttpTokenRefresher implements TokenRefresher {
  private readonly _defaultBase: string;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;
  private readonly _now: () => number;

  constructor(options: HttpTokenRefresherOptions) {
    this._defaultBase = normalizeServerBase(options.defaultServerBaseUrl) ?? "";
    this._fetch = options.fetchImpl ?? fetch;
    this._timeoutMs = options.timeoutMs ?? REFRESH_HTTP_TIMEOUT;
    this._now = options.now ?? Date.now;
  }

  async refresh(request: TokenRefreshRequest): Promise<TokenRefreshResult> {
    if (!request.refreshToken) {
      return { ok: false, reason: "no refresh token" };
    }
    if (!request.clientId?.trim()) {
      // Fail closed rather than guessing an id: presenting a component default for a family that
      // stored one is exactly the cross-mint bug 04 §3 rule 2 exists to prevent.
      return { ok: false, reason: "no client id" };
    }
    const base = normalizeServerBase(request.serverTarget) ?? this._defaultBase;
    if (!base) {
      return { ok: false, reason: "no server target" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    const onAbort = () => controller.abort();
    const signal = request.signal;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const response = await this._fetch(tokenUrl(base), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: buildRefreshForm(request.refreshToken, request.clientId.trim()).toString(),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: DeviceTokenResponse | null = null;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text) as DeviceTokenResponse;
        } catch {
          parsed = { error: INVALID_TOKEN_RESPONSE };
        }
      }
      return buildRefreshResult(response.ok, response.status, parsed, this._now);
    } catch (err) {
      // Fail closed on any network/abort error — the store is never touched here. Transient unless
      // the CALLER cancelled (a deliberate abort must not be retried behind its back).
      return { ok: false, reason: describeErrorWithCause(err), transient: !signal?.aborted };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
}
