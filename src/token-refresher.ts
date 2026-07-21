import { DEFAULT_PLUGIN_SCOPE, tokenUrl, type DeviceTokenResponse } from "./oauth-device-flow.js";

/**
 * Exchanges a stored refresh token for a fresh access token at `{serverTarget}/oauth/token`
 * (`grant_type=refresh_token`) — the TypeScript port of the plugin's C# `UnityTokenRefresher`
 * (auth-fixes design 03 Flow B). It is the HTTP seam only; the {@link MachineCredentialProvider}
 * owns the machine store and the refresh scheduling.
 *
 * It **fails closed**: any non-success, missing access token, or exception becomes a
 * {@link TokenRefreshResult} failure — never a throw past the boundary, and it never logs token
 * material. A refresh-token family-revoke (rotation-reuse detection on the server) surfaces here as
 * a failure with the server's error, which the provider turns into a clean `login required`.
 */

/** The result of a refresh attempt — a value, never a throw. */
export type TokenRefreshResult =
  | { ok: true; accessToken: string; refreshToken?: string; expiresAt?: string }
  | { ok: false; reason: string };

/** The refresh transport seam (injectable for tests). */
export interface TokenRefresher {
  refresh(
    refreshToken: string,
    serverTarget?: string,
    signal?: AbortSignal,
  ): Promise<TokenRefreshResult>;
}

/**
 * Normalize a stored server target to the AS root: trim a trailing slash and a trailing `/mcp` hub
 * segment so `/oauth/token` resolves on the authorization-server root. Mirrors the C#
 * `UnityTokenRefresher.NormalizeBase`.
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
 * Build the RFC 6749 refresh-token grant form (mirrors `UnityTokenRefresher.BuildRefreshForm`).
 * The optional RFC 8707 `resource` indicator is added as exactly ONE parameter when provided — the
 * SAME single resource the original grant was minted for, so refreshed tokens stay single-audience.
 */
export function buildRefreshForm(
  refreshToken: string,
  clientId: string,
  scope: string,
  resource?: string,
): URLSearchParams {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    scope,
  });
  const trimmed = resource?.trim();
  if (trimmed) {
    form.set("resource", trimmed);
  }
  return form;
}

/** Turn a parsed token response into a {@link TokenRefreshResult} (mirrors `BuildResult`). */
export function buildRefreshResult(
  isSuccessStatus: boolean,
  statusCode: number,
  parsed: DeviceTokenResponse | null,
  now: () => number = Date.now,
): TokenRefreshResult {
  if (parsed == null) {
    return { ok: false, reason: "empty token response" };
  }
  if (!isSuccessStatus || !parsed.access_token) {
    return { ok: false, reason: parsed.error ?? `refresh failed (HTTP ${statusCode})` };
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
  /** Product client id. */
  clientId: string;
  /** Scope; defaults to `mcp:plugin` (pass `mcp:agent` for agent-plane credentials). */
  scope?: string;
  /**
   * RFC 8707 resource indicator — the SAME single resource the original grant carried. When set,
   * exactly ONE `resource` parameter is sent on every refresh request. Omitted → legacy wire shape.
   */
  resource?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request network timeout (ms). Default 20s. */
  timeoutMs?: number;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
}

/** The default {@link TokenRefresher}: a form-encoded `grant_type=refresh_token` POST via `fetch`. */
export class HttpTokenRefresher implements TokenRefresher {
  private readonly _defaultBase: string;
  private readonly _clientId: string;
  private readonly _scope: string;
  private readonly _resource: string | undefined;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;
  private readonly _now: () => number;

  constructor(options: HttpTokenRefresherOptions) {
    this._defaultBase = normalizeServerBase(options.defaultServerBaseUrl) ?? "";
    if (!options.clientId?.trim()) {
      throw new Error("clientId is required");
    }
    this._clientId = options.clientId.trim();
    this._scope = options.scope?.trim() || DEFAULT_PLUGIN_SCOPE;
    this._resource = options.resource?.trim() || undefined;
    this._fetch = options.fetchImpl ?? fetch;
    this._timeoutMs = options.timeoutMs ?? 20_000;
    this._now = options.now ?? Date.now;
  }

  async refresh(
    refreshToken: string,
    serverTarget?: string,
    signal?: AbortSignal,
  ): Promise<TokenRefreshResult> {
    if (!refreshToken) {
      return { ok: false, reason: "no refresh token" };
    }
    const base = normalizeServerBase(serverTarget) ?? this._defaultBase;
    if (!base) {
      return { ok: false, reason: "no server target" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    const onAbort = () => controller.abort();
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
        body: buildRefreshForm(refreshToken, this._clientId, this._scope, this._resource).toString(),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: DeviceTokenResponse | null = null;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text) as DeviceTokenResponse;
        } catch {
          parsed = { error: "invalid token response" };
        }
      }
      return buildRefreshResult(response.ok, response.status, parsed, this._now);
    } catch (err) {
      // Fail closed on any network/abort error — the store is never touched here.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: message };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
}
