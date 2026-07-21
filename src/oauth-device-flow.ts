import type { MachineCredentials } from "./machine-credentials.js";

/**
 * OAuth 2.1 Device Authorization Grant (RFC 8628) client for the ai-game.dev authorization server —
 * the TypeScript port of the plugin's C# `DeviceAuthService` + `DeviceAuthFlow`
 * (auth-fixes design 02 T1 / 03 Flow B). It POSTs `client_id` + `scope` (form-encoded) to
 * `{base}/oauth/device_authorization`, then redeems the grant at `{base}/oauth/token` with the
 * device-code grant type — yielding an ES256 hub JWT plus a **rotating refresh token**, which the
 * caller persists as full {@link MachineCredentials}. This replaces the legacy `/api/auth/device/*`
 * JSON flow and **never mints a PAT** (personal access tokens remain a manual, human-only tool).
 *
 * The RFC 8628 client-MUSTs (design 02 T1, §3.3 / §3.5) are codified here and unit-tested:
 *   - the caller is handed BOTH the `user_code` AND the `verification_uri` to display (§3.3);
 *   - the poll interval defaults to 5s and honours a larger server `interval` (§3.5);
 *   - a `slow_down` error bumps the interval by 5s (§3.5);
 *   - `authorization_pending` keeps polling; `expired_token` / `access_denied` stop cleanly.
 *
 * MCP conformance (additive): an optional RFC 8707 `resource` indicator is threaded into the
 * device-authorization request AND every token poll — exactly one `resource` per request, so the AS
 * mints single-audience tokens — and `scope=mcp:agent` ({@link MCP_AGENT_SCOPE}) is first-class
 * alongside the default {@link DEFAULT_PLUGIN_SCOPE}.
 *
 * Nothing here touches the machine credential store — a caller writes the returned credentials only
 * on success, so a network failure or a denied/expired grant never corrupts the store (design 03 F4).
 */

/** RFC 8628 `device_authorization` response document. */
export interface DeviceAuthorizeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/**
 * OAuth 2.1 token response for the device-code (and refresh-token) grant. On success it carries the
 * access token + rotating refresh token + `expires_in`; while authorization is pending it carries an
 * RFC 6749 §5.2 `error` (`authorization_pending` / `slow_down` / `access_denied` / `expired_token`).
 */
export interface DeviceTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** Path (relative to the AS root) of the RFC 8628 device-authorization endpoint. */
export const OAUTH_DEVICE_AUTHORIZATION_PATH = "/oauth/device_authorization";

/** Path (relative to the AS root) of the OAuth 2.1 token endpoint. */
export const OAUTH_TOKEN_PATH = "/oauth/token";

/** RFC 8628 device-code grant type redeemed at the token endpoint. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Default scope selecting the MCP-plugin JWT + refresh-token response. */
export const DEFAULT_PLUGIN_SCOPE = "mcp:plugin";

/** First-class agent-plane scope: `scope=mcp:agent` selects an agent-plane token response. */
export const MCP_AGENT_SCOPE = "mcp:agent";

/** RFC 8628 §3.5 default polling interval when the server does not specify one (5 seconds). */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** RFC 8628 §3.5 amount the polling interval grows by on each `slow_down` (5 seconds). */
export const SLOW_DOWN_INCREMENT_MS = 5000;

/** Fallback device-code lifetime (seconds) when the server omits `expires_in`. */
const DEFAULT_DEVICE_CODE_LIFETIME_SECONDS = 900;

/**
 * The device-authorization transport seam. Split from the flow so the RFC 8628 state machine can be
 * exercised against a mocked authorization server with no live network.
 */
export interface DeviceAuthTransport {
  /** `POST /oauth/device_authorization` → device/user code document. */
  requestDeviceCode(signal?: AbortSignal): Promise<DeviceAuthorizeResponse>;
  /** `POST /oauth/token` (device-code grant). Pending/slow-down come back as a soft error body. */
  pollToken(deviceCode: string, signal?: AbortSignal): Promise<DeviceTokenResponse>;
}

/** Trim a trailing slash so `{base}/oauth/...` resolves cleanly. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Absolute device-authorization URL for an AS root. */
export function deviceAuthorizationUrl(serverBaseUrl: string): string {
  return `${trimTrailingSlash(serverBaseUrl)}${OAUTH_DEVICE_AUTHORIZATION_PATH}`;
}

/** Absolute token URL for an AS root. */
export function tokenUrl(serverBaseUrl: string): string {
  return `${trimTrailingSlash(serverBaseUrl)}${OAUTH_TOKEN_PATH}`;
}

/** Options for the default fetch-backed transport. */
export interface HttpDeviceAuthTransportOptions {
  serverBaseUrl: string;
  clientId: string;
  scope?: string;
  /**
   * RFC 8707 resource indicator — the MCP resource server the token is minted for (e.g.
   * `https://ai-game.dev/mcp`). When set, exactly ONE `resource` parameter is sent on the
   * device-authorization request AND on every token poll, yielding a single-audience token.
   * Omitted → the legacy wire shape (no `resource`) is preserved.
   */
  resource?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request network timeout (ms). Default 30s. */
  timeoutMs?: number;
}

/**
 * The default {@link DeviceAuthTransport}: form-encoded POSTs to the real OAuth endpoints via
 * `fetch`. `client_id` + `scope` go to `/oauth/device_authorization`; `grant_type=device_code` +
 * `device_code` + `client_id` go to `/oauth/token`. The token endpoint is NOT status-checked —
 * `authorization_pending` / `slow_down` come back as HTTP 400 with an RFC 6749 §5.2 error body the
 * flow inspects.
 */
export class HttpDeviceAuthTransport implements DeviceAuthTransport {
  private readonly _serverBaseUrl: string;
  private readonly _clientId: string;
  private readonly _scope: string;
  private readonly _resource: string | undefined;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;

  constructor(options: HttpDeviceAuthTransportOptions) {
    if (!options.serverBaseUrl?.trim()) {
      throw new Error("serverBaseUrl is required");
    }
    if (!options.clientId?.trim()) {
      throw new Error("clientId is required");
    }
    this._serverBaseUrl = trimTrailingSlash(options.serverBaseUrl.trim());
    this._clientId = options.clientId.trim();
    this._scope = options.scope?.trim() || DEFAULT_PLUGIN_SCOPE;
    this._resource = options.resource?.trim() || undefined;
    this._fetch = options.fetchImpl ?? fetch;
    this._timeoutMs = options.timeoutMs ?? 30_000;
  }

  async requestDeviceCode(signal?: AbortSignal): Promise<DeviceAuthorizeResponse> {
    const body = new URLSearchParams({ client_id: this._clientId, scope: this._scope });
    if (this._resource) {
      // RFC 8707: `set` (not `append`) guarantees exactly ONE resource → a single-audience token.
      body.set("resource", this._resource);
    }
    const response = await this.post(deviceAuthorizationUrl(this._serverBaseUrl), body, signal);
    if (!response.ok) {
      const text = await safeText(response);
      throw new Error(`Device authorization request failed (HTTP ${response.status})${text ? `: ${text}` : ""}`);
    }
    return (await response.json()) as DeviceAuthorizeResponse;
  }

  async pollToken(deviceCode: string, signal?: AbortSignal): Promise<DeviceTokenResponse> {
    const body = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: deviceCode,
      client_id: this._clientId,
    });
    if (this._resource) {
      body.set("resource", this._resource);
    }
    // Intentionally NOT ok-checked: pending / slow_down are HTTP 400 with a JSON error body.
    const response = await this.post(tokenUrl(this._serverBaseUrl), body, signal);
    return (await parseTokenResponse(response)) satisfies DeviceTokenResponse;
  }

  private async post(url: string, body: URLSearchParams, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      return await this._fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Callbacks + injectable seams for {@link deviceLogin}. */
export interface DeviceLoginOptions {
  /** The AS root (e.g. `https://ai-game.dev`) — NOT the `/mcp` hub URL. Used to build the transport. */
  serverBaseUrl: string;
  /** Product client id (`unity-mcp-cli` / `unreal-mcp-cli` / `godot-cli`). Required. */
  clientId: string;
  /** Scope; defaults to `mcp:plugin`. Pass {@link MCP_AGENT_SCOPE} (`mcp:agent`) for the agent plane. */
  scope?: string;
  /**
   * RFC 8707 resource indicator threaded into the default transport: exactly ONE `resource` on the
   * device-authorization request AND every token poll (single-audience tokens). Omitted → legacy
   * wire shape. Ignored when a custom `transport` is supplied (the transport owns its wire shape).
   */
  resource?: string;
  /** Injectable `fetch` for the default transport (mock-AS tests). Ignored when `transport` is supplied. */
  fetchImpl?: typeof fetch;
  /**
   * The server target recorded on the resulting credential (hosted vs local). Defaults to
   * `serverBaseUrl`. Kept distinct so a caller can record the hub URL if it prefers.
   */
  serverTarget?: string;
  /**
   * REQUIRED (RFC 8628 §3.3): display the `user_code` AND the `verification_uri` to the user. The
   * flow calls this exactly once, before polling begins.
   */
  onUserCode: (userCode: string, verificationUri: string, response: DeviceAuthorizeResponse) => void;
  /** Optional: called once when polling starts (e.g. to show a spinner). */
  onPolling?: () => void;
  /** Optional: open the verification URL in a browser (`verification_uri_complete` when present). */
  openBrowser?: (url: string) => void;
  /** Injectable transport; defaults to {@link HttpDeviceAuthTransport}. */
  transport?: DeviceAuthTransport;
  /** Injectable delay (ms); defaults to a cancellable `setTimeout`. For tests. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. For deadline tests. */
  now?: () => number;
  /** Default poll interval floor (ms); defaults to {@link DEFAULT_POLL_INTERVAL_MS}. */
  defaultPollIntervalMs?: number;
  /** Cancellation. */
  signal?: AbortSignal;
}

/** The outcome of {@link deviceLogin}. Failures are values, not throws (network errors included). */
export type DeviceLoginResult =
  | { ok: true; credentials: MachineCredentials }
  | { ok: false; reason: "expired" | "denied" | "error" | "cancelled"; message: string };

/**
 * Run the RFC 8628 device-authorization flow end to end and return full {@link MachineCredentials}
 * on success. The caller persists them (this function never writes the store), so an early failure
 * leaves the store untouched (design 03 F4).
 */
export async function deviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const scope = options.scope?.trim() || DEFAULT_PLUGIN_SCOPE;
  const serverTarget = options.serverTarget ?? options.serverBaseUrl;
  const transport =
    options.transport ??
    new HttpDeviceAuthTransport({
      serverBaseUrl: options.serverBaseUrl,
      clientId: options.clientId,
      scope,
      resource: options.resource,
      fetchImpl: options.fetchImpl,
    });
  const delay = options.delay ?? cancellableDelay;
  const now = options.now ?? Date.now;
  const signal = options.signal;

  try {
    if (signal?.aborted) {
      return { ok: false, reason: "cancelled", message: "Sign-in cancelled." };
    }

    const auth = await transport.requestDeviceCode(signal);

    // RFC 8628 §3.3: the user MUST be shown BOTH the user code and the verification URI.
    options.onUserCode(auth.user_code, auth.verification_uri, auth);

    // §3.3.1: prefer verification_uri_complete for the browser (it carries the code); fall back to
    // the plain URI. The plain URI is always what the user is asked to read/verify.
    const browserUrl = auth.verification_uri_complete?.trim() || auth.verification_uri;
    if (browserUrl && options.openBrowser) {
      try {
        options.openBrowser(browserUrl);
      } catch {
        /* opening a browser is best-effort; the user can navigate manually */
      }
    }

    options.onPolling?.();

    // §3.5: honour the server interval, floored at the default (5s); slow_down bumps it by 5s.
    const floorMs = options.defaultPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    let intervalMs = Math.max((auth.interval ?? 0) * 1000, floorMs);

    const lifetimeSeconds = auth.expires_in > 0 ? auth.expires_in : DEFAULT_DEVICE_CODE_LIFETIME_SECONDS;
    const deadline = now() + lifetimeSeconds * 1000;

    while (now() < deadline) {
      await delay(intervalMs, signal);
      if (signal?.aborted) {
        return { ok: false, reason: "cancelled", message: "Sign-in cancelled." };
      }
      if (now() >= deadline) break;

      const token = await transport.pollToken(auth.device_code, signal);

      if (token.access_token) {
        return { ok: true, credentials: buildCredentials(token, serverTarget, now) };
      }

      switch (token.error) {
        case "access_denied":
          return {
            ok: false,
            reason: "denied",
            message: token.error_description ?? "Authorization was denied.",
          };
        case "expired_token":
          return {
            ok: false,
            reason: "expired",
            message: token.error_description ?? "Device code expired. Please try again.",
          };
        case "slow_down":
          intervalMs += SLOW_DOWN_INCREMENT_MS;
          break;
        case "authorization_pending":
        case undefined:
        case "":
          break; // keep polling
        default:
          return {
            ok: false,
            reason: "error",
            message: token.error_description ?? `Authorization failed: ${token.error}`,
          };
      }
    }

    return { ok: false, reason: "expired", message: "Device code expired. Please try again." };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      return { ok: false, reason: "cancelled", message: "Sign-in cancelled." };
    }
    return { ok: false, reason: "error", message: describeNetworkError(err) };
  }
}

/** Build the full credential document from a successful token response. */
function buildCredentials(
  token: DeviceTokenResponse,
  serverTarget: string,
  now: () => number,
): MachineCredentials {
  const credentials: MachineCredentials = {
    accessToken: token.access_token,
    serverTarget,
  };
  if (token.refresh_token) {
    credentials.refreshToken = token.refresh_token;
  }
  if (typeof token.expires_in === "number" && token.expires_in > 0) {
    credentials.expiresAt = new Date(now() + token.expires_in * 1000).toISOString();
  }
  const subject = decodeJwtSubject(token.access_token);
  if (subject) {
    credentials.subject = subject;
  }
  return credentials;
}

/**
 * Best-effort extraction of the `sub` claim from a JWT for the diagnostic `subject` field. This does
 * NOT verify the signature (that is the server's job on every request) — it only reads the already
 * server-issued token to record which account it resolves to. Returns undefined on any malformed
 * input.
 */
export function decodeJwtSubject(accessToken: string | undefined): string | undefined {
  if (!accessToken) return undefined;
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  const payloadSegment = parts[1];
  if (!payloadSegment) return undefined;
  try {
    const json = Buffer.from(base64UrlToBase64(payloadSegment), "base64").toString("utf-8");
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlToBase64(segment: string): string {
  const replaced = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = replaced.length % 4;
  return padding === 0 ? replaced : replaced + "=".repeat(4 - padding);
}

/** A cancellable `setTimeout`-backed delay that rejects (AbortError) if the signal fires. */
function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function describeNetworkError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return `Cannot reach the authorization server: ${message}`;
  }
  return `Authentication failed: ${message}`;
}

async function parseTokenResponse(response: Response): Promise<DeviceTokenResponse> {
  const text = await safeText(response);
  if (!text) {
    if (response.ok) return {};
    return { error: "error", error_description: `Token endpoint returned HTTP ${response.status}` };
  }
  try {
    return JSON.parse(text) as DeviceTokenResponse;
  } catch {
    return {
      error: "error",
      error_description: `Unexpected non-JSON response from the token endpoint (HTTP ${response.status})`,
    };
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
