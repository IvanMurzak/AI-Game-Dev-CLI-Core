import { spawn } from "node:child_process";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { MachineCredentials } from "./machine-credentials.js";
import {
  ClientRegistrationStore,
  DEFAULT_DCR_TIMEOUT_MS,
  OAUTH_AUTHORIZE_PATH,
  resolveClientRegistration,
  type AuthorizationServerMetadata,
  type ClientRegistrationStoreLike,
  type ResolvedClientRegistration,
} from "./oauth-dcr.js";
import {
  DEFAULT_PLUGIN_SCOPE,
  decodeJwtSubject,
  tokenUrl,
  type DeviceTokenResponse,
} from "./oauth-device-flow.js";

/**
 * OAuth 2.1 authorization-code + PKCE login for **native/desktop** clients (RFC 8252 "OAuth 2.0 for
 * Native Apps"). This is the browser-based sibling of {@link ../oauth-device-flow.deviceLogin}: it
 * opens the system browser to the AS `/oauth/authorize` with a **PKCE S256** challenge, catches the
 * redirect on an ephemeral `127.0.0.1` loopback listener (RFC 8252 §7.3 — the IP literal, never a
 * public interface), and exchanges the returned `code` (with the PKCE `code_verifier` and the RFC
 * 8707 `resource` indicator) for the agent-plane token. It yields the SAME {@link MachineCredentials}
 * shape as {@link deviceLogin}, so it feeds the `MachineCredentialProvider` / App keychain path the
 * same way — the two login paths are surface-parallel and interchangeable at the call site.
 *
 * The RFC-MUSTs codified + unit-tested here:
 *   - **PKCE (RFC 7636):** a 43+ char `code_verifier`; the authorize request carries only the S256
 *     `code_challenge` + `code_challenge_method=S256`; the token request carries the raw verifier.
 *   - **CSRF (RFC 6749 §10.12):** an unguessable `state` is sent on the authorize request and the
 *     redirect's `state` is compared for an **exact** match — a mismatch is refused, never exchanged.
 *   - **Loopback (RFC 8252 §7.3 / §8.3):** the listener binds `127.0.0.1` on an **ephemeral** port,
 *     the redirect URI is an exact-match loopback literal, and a non-loopback host is refused.
 *   - **RFC 8707 resource:** exactly ONE `resource` on the authorize request AND the token exchange,
 *     so the AS mints a single-audience token (reusing c1's threading; parity with `deviceLogin`).
 *
 * Injectable seams (mirroring `deviceLogin`) keep the whole flow testable against a mock AS with no
 * live network and no real browser: the browser `openBrowser` opener (default spawns the OS handler —
 * **no Electron dependency**; the App may inject its own), the loopback `listenerFactory`, the token
 * `transport`, the PKCE/`state` random source, the `registrationStore`, and the clock. When no
 * browser can be opened the flow returns a **clear error (never a hang)** so the caller can fall back
 * to `deviceLogin`.
 *
 * ## Client identity: dynamic registration by default (RFC 8414 + RFC 7591)
 *
 * `/oauth/authorize` resolves `client_id` by an exact lookup in the AS's client registry, whose only
 * writer is `POST /oauth/register` — so a **static client id is rejected** (`invalid_client`) unless
 * that exact id was registered out of band. Omit {@link AuthCodeLoginOptions.clientId} (the
 * recommended default) and this flow discovers the AS, reuses this installation's persisted
 * registration, or registers once — see {@link ../oauth-dcr}. Supplying `clientId` explicitly opts
 * OUT of registration and is honoured verbatim, which is what the engine CLIs' `EngineAdapter`
 * clientId path relies on.
 *
 * Because RFC 6749 §4.1.2.1 forbids redirecting an unverified `client_id` back to the `redirect_uri`,
 * an `invalid_client` never reaches the loopback listener — it is rendered in the user's browser
 * while the flow waits out its full timeout. So in dynamic mode the flow **probes the authorization
 * request itself before opening a browser**: a definite 4xx surfaces immediately instead of after a
 * five-minute "timeout", and an `invalid_client` (the AS garbage-collects unused clients after 30
 * days, and a client can be revoked) triggers **exactly one** re-registration + retry — never a loop.
 *
 * Additive + backward-compatible: nothing here touches the credential store — a caller writes the
 * returned credentials only on `ok:true`, so a failure at any stage leaves the store untouched.
 */

export { OAUTH_AUTHORIZE_PATH };

/** RFC 6749 §4.1.3 grant type redeemed at the token endpoint for an authorization code. */
export const AUTHORIZATION_CODE_GRANT_TYPE = "authorization_code";

/** RFC 7636 code-challenge method — SHA-256. Plain (`plain`) is intentionally NOT supported. */
export const PKCE_CODE_CHALLENGE_METHOD = "S256";

/** The loopback interface the redirect listener binds (RFC 8252 §7.3 — the IP literal, not `localhost`). */
export const DEFAULT_LOOPBACK_HOST = "127.0.0.1";

/** Default path the loopback redirect URI targets. */
export const DEFAULT_CALLBACK_PATH = "/callback";

/** Default wait (ms) for the browser round-trip before the listener times out (5 minutes). */
export const DEFAULT_AUTHCODE_TIMEOUT_MS = 300_000;

/** A minimal page shown in the user's browser once the redirect is captured. */
const SUCCESS_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Sign-in complete</title></head>" +
  "<body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4rem\">" +
  "<h1>Sign-in complete</h1><p>You can close this window and return to the terminal.</p></body></html>";

/** Trim a trailing slash so `{base}/oauth/...` resolves cleanly. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Absolute authorization URL for an AS root. */
export function authorizeUrl(serverBaseUrl: string): string {
  return `${trimTrailingSlash(serverBaseUrl)}${OAUTH_AUTHORIZE_PATH}`;
}

/** Source of cryptographic randomness; injectable so tests can pin verifier/state values. */
export type RandomBytesFn = (size: number) => Buffer;

/**
 * Generate a PKCE `code_verifier` (RFC 7636 §4.1): 32 random bytes → 43-char base64url, comfortably
 * inside the required 43–128 char range and using only the unreserved `[A-Za-z0-9-._~]` set.
 */
export function generateCodeVerifier(randomBytes: RandomBytesFn = cryptoRandomBytes): string {
  return randomBytes(32).toString("base64url");
}

/** Derive the PKCE S256 `code_challenge` from a verifier (RFC 7636 §4.2): base64url(SHA-256(verifier)). */
export function deriveCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

/** Generate an unguessable `state` for CSRF protection (RFC 6749 §10.12): 16 random bytes → base64url. */
export function generateState(randomBytes: RandomBytesFn = cryptoRandomBytes): string {
  return randomBytes(16).toString("base64url");
}

/** Parameters for {@link buildAuthorizeUrl}. */
export interface BuildAuthorizeUrlParams {
  serverBaseUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  /** RFC 8707 resource indicator; when set, exactly ONE `resource` is added to the authorize URL. */
  resource?: string;
  /**
   * Absolute authorization endpoint discovered via RFC 8414, overriding `{serverBaseUrl}/oauth/authorize`.
   * Omitted → this package's hardcoded path (the pre-discovery behaviour).
   */
  authorizeEndpoint?: string;
}

/**
 * Build the `/oauth/authorize` URL for the authorization-code + PKCE (S256) flow. Pure and
 * deterministic given its inputs, so the exact query shape (PKCE, `state`, `resource`) is unit
 * testable without a listener or a browser.
 */
export function buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string {
  const url = new URL(params.authorizeEndpoint?.trim() || authorizeUrl(params.serverBaseUrl));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", PKCE_CODE_CHALLENGE_METHOD);
  if (params.resource?.trim()) {
    // RFC 8707: `set` (not `append`) guarantees exactly ONE resource → a single-audience token.
    url.searchParams.set("resource", params.resource.trim());
  }
  return url.toString();
}

/** True for a loopback host literal the listener is allowed to bind (127.0.0.0/8 or IPv6 `::1`). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "");
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "::1";
}

/** Render a loopback host for use inside a URL authority (an IPv6 literal must be bracketed). */
function loopbackHostForUrl(host: string): string {
  return host.includes(":") ? `[${host.replace(/^\[|\]$/g, "")}]` : host;
}

/** The OAuth parameters carried on a captured loopback redirect. */
export interface LoopbackRedirect {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

/** A single-use loopback HTTP listener that captures exactly one authorization redirect. */
export interface LoopbackListener {
  /** The exact `http://127.0.0.1:{port}{path}` redirect URI the AS must call back. */
  readonly redirectUri: string;
  /** The ephemeral port the listener bound. */
  readonly port: number;
  /** Resolve with the redirect params; reject with a timeout (`LoopbackTimeoutError`) / abort. */
  waitForRedirect(): Promise<LoopbackRedirect>;
  /** Idempotently stop the listener and drop any lingering sockets. */
  close(): void;
}

/** Creates a {@link LoopbackListener}; injectable so the flow runs with a fake in tests. */
export type LoopbackListenerFactory = (options: {
  host: string;
  path: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<LoopbackListener>;

/** Error the loopback listener rejects with when the browser round-trip exceeds the timeout. */
export class LoopbackTimeoutError extends Error {
  constructor(message = "Timed out waiting for the browser sign-in redirect.") {
    super(message);
    this.name = "LoopbackTimeoutError";
  }
}

/**
 * The default {@link LoopbackListenerFactory}: an in-process `node:http` server bound to the loopback
 * interface on an ephemeral port. The request handler is attached BEFORE `listen` resolves, so a
 * redirect that arrives before `waitForRedirect` is awaited is never lost (no race). Only the exact
 * callback path is accepted; any other path is answered `404` so a stray probe cannot satisfy the
 * flow. `Connection: close` + connection tracking ensure {@link LoopbackListener.close} tears the
 * server down promptly (no lingering keep-alive socket keeps the process/test alive).
 */
export const createLoopbackListener: LoopbackListenerFactory = async ({ host, path, timeoutMs, signal }) => {
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing to bind a non-loopback redirect host: ${host}`);
  }

  const server: Server = createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  let settled = false;
  let resolveRedirect!: (redirect: LoopbackRedirect) => void;
  let rejectRedirect!: (err: Error) => void;
  const redirectPromise = new Promise<LoopbackRedirect>((resolve, reject) => {
    resolveRedirect = resolve;
    rejectRedirect = reject;
  });

  const hostForUrl = loopbackHostForUrl(host);

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", `http://${hostForUrl}`);
    if (requestUrl.pathname !== path) {
      res.statusCode = 404;
      res.setHeader("Connection", "close");
      res.end("Not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Connection", "close");
    res.end(SUCCESS_HTML);
    if (!settled) {
      settled = true;
      resolveRedirect({
        code: requestUrl.searchParams.get("code") ?? undefined,
        state: requestUrl.searchParams.get("state") ?? undefined,
        error: requestUrl.searchParams.get("error") ?? undefined,
        errorDescription: requestUrl.searchParams.get("error_description") ?? undefined,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://${hostForUrl}:${port}${path}`;

  const close = (): void => {
    try {
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* best-effort */
    }
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        /* best-effort */
      }
    }
    sockets.clear();
    try {
      server.close();
    } catch {
      /* already closing */
    }
  };

  return {
    redirectUri,
    port,
    waitForRedirect: () => {
      if (signal?.aborted) {
        return Promise.reject(abortError());
      }
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          rejectRedirect(new LoopbackTimeoutError());
        }
      }, timeoutMs);
      const onAbort = () => {
        if (!settled) {
          settled = true;
          rejectRedirect(abortError());
        }
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      return redirectPromise.finally(() => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      });
    },
    close,
  };
};

/**
 * Open a URL in the OS-default browser with NO Electron / third-party dependency: `cmd /c start` on
 * Windows, `open` on macOS, `xdg-open` on Linux. On a headless Linux host (no `DISPLAY` /
 * `WAYLAND_DISPLAY`) it throws synchronously with a clear message rather than spawning into the void,
 * so the caller gets an immediate error and can fall back to device-code login. The App may inject
 * its own opener via {@link AuthCodeLoginOptions.openBrowser}.
 */
export function defaultBrowserOpener(url: string): void {
  const platform = process.platform;
  if (platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error("no graphical browser is available (headless environment)");
  }
  let command: string;
  let args: string[];
  if (platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
  // A late ENOENT can't be surfaced synchronously; swallow it so it never crashes the process (the
  // loopback timeout is the ultimate no-hang guarantee for a browser that never actually opened).
  child.on("error", () => {});
  child.unref();
}

/** OAuth 2.1 token response for the authorization-code (and error) grant. Same shape as the device grant. */
export type AuthCodeTokenResponse = DeviceTokenResponse;

/** Parameters for a single {@link AuthCodeTransport.exchangeCode} call. */
export interface ExchangeCodeParams {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  signal?: AbortSignal;
}

/**
 * The token-exchange transport seam. Split from the flow so the code→token step can be exercised
 * against a mocked authorization server with no live network.
 */
export interface AuthCodeTransport {
  /** `POST /oauth/token` with `grant_type=authorization_code` + PKCE verifier (+ RFC 8707 resource). */
  exchangeCode(params: ExchangeCodeParams): Promise<AuthCodeTokenResponse>;
}

/** Options for the default fetch-backed {@link HttpAuthCodeTransport}. */
export interface HttpAuthCodeTransportOptions {
  serverBaseUrl: string;
  clientId: string;
  /**
   * RFC 8707 resource indicator — when set, exactly ONE `resource` is sent on the token exchange,
   * yielding a single-audience token. Omitted → the legacy wire shape (no `resource`).
   */
  resource?: string;
  /**
   * Absolute token endpoint discovered via RFC 8414, overriding `{serverBaseUrl}/oauth/token`.
   * Omitted → this package's hardcoded path (the pre-discovery behaviour).
   */
  tokenEndpoint?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request network timeout (ms). Default 30s. */
  timeoutMs?: number;
}

/**
 * The default {@link AuthCodeTransport}: a form-encoded `POST` to `/oauth/token` via `fetch` with
 * `grant_type=authorization_code`, the `code`, the `redirect_uri` (which the AS re-verifies), the
 * `client_id`, the PKCE `code_verifier`, and — when configured — exactly ONE RFC 8707 `resource`.
 */
export class HttpAuthCodeTransport implements AuthCodeTransport {
  private readonly _serverBaseUrl: string;
  private readonly _clientId: string;
  private readonly _resource: string | undefined;
  private readonly _tokenEndpoint: string;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;

  constructor(options: HttpAuthCodeTransportOptions) {
    if (!options.serverBaseUrl?.trim()) {
      throw new Error("serverBaseUrl is required");
    }
    if (!options.clientId?.trim()) {
      throw new Error("clientId is required");
    }
    this._serverBaseUrl = trimTrailingSlash(options.serverBaseUrl.trim());
    this._clientId = options.clientId.trim();
    this._resource = options.resource?.trim() || undefined;
    this._tokenEndpoint = options.tokenEndpoint?.trim() || tokenUrl(this._serverBaseUrl);
    this._fetch = options.fetchImpl ?? fetch;
    this._timeoutMs = options.timeoutMs ?? 30_000;
  }

  async exchangeCode({ code, codeVerifier, redirectUri, signal }: ExchangeCodeParams): Promise<AuthCodeTokenResponse> {
    const body = new URLSearchParams({
      grant_type: AUTHORIZATION_CODE_GRANT_TYPE,
      code,
      redirect_uri: redirectUri,
      client_id: this._clientId,
      code_verifier: codeVerifier,
    });
    if (this._resource) {
      body.set("resource", this._resource);
    }
    // Intentionally NOT ok-checked: an invalid_grant (bad code / PKCE mismatch) is HTTP 400 with a
    // JSON error body the flow inspects.
    const response = await this.post(this._tokenEndpoint, body, signal);
    return (await parseTokenResponse(response)) satisfies AuthCodeTokenResponse;
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

/** Callbacks + injectable seams for {@link authCodeLogin}. */
export interface AuthCodeLoginOptions {
  /** The AS root (e.g. `https://ai-game.dev`) — NOT the `/mcp` hub URL. Used to build the transport. */
  serverBaseUrl: string;
  /**
   * A **statically registered** client id, which opts OUT of dynamic client registration and is sent
   * verbatim (the engine CLIs' `EngineAdapter.clientId` path). **Omit it** — the recommended default
   * for a desktop app — and the flow performs RFC 8414 discovery + RFC 7591 registration instead,
   * reusing this installation's persisted `client_id`. A hardcoded id the AS never registered is
   * rejected with `invalid_client`, which is exactly the bug DCR exists to prevent.
   */
  clientId?: string;
  /**
   * Human-readable product name registered as the client's `client_name` — **the user sees it on the
   * consent screen**. Defaults to `AI Game Dev`. Only used in dynamic-registration mode.
   */
  clientName?: string;
  /**
   * Persistence seam for the dynamic registration; defaults to the on-disk
   * {@link ../oauth-dcr.ClientRegistrationStore} (`~/.ai-game-dev/oauth-clients.json`, keyed by AS
   * base URL). Only used in dynamic-registration mode.
   */
  registrationStore?: ClientRegistrationStoreLike;
  /**
   * Pre-fetched RFC 8414 metadata. In dynamic-registration mode it also skips this flow's own
   * discovery call; in BOTH modes its `authorization_endpoint` / `token_endpoint` override this
   * package's hardcoded paths, so a caller supplying a static `clientId` can still point the flow at
   * an already-discovered AS.
   */
  metadata?: AuthorizationServerMetadata;
  /**
   * Per-request network timeout (ms) for discovery / registration / the authorize probe. Default 30s.
   * Distinct from {@link timeoutMs}, which bounds the human browser round-trip.
   */
  networkTimeoutMs?: number;
  /** Scope; defaults to `mcp:plugin`. Pass `MCP_AGENT_SCOPE` (`mcp:agent`) for the agent plane. */
  scope?: string;
  /**
   * RFC 8707 resource indicator threaded into BOTH the authorize URL and the token exchange (exactly
   * ONE `resource` each → single-audience tokens). Omitted → legacy wire shape. Ignored when a custom
   * `transport` is supplied (the transport owns its token-request wire shape).
   */
  resource?: string;
  /** Injectable `fetch` for the default transport (mock-AS tests). Ignored when `transport` is supplied. */
  fetchImpl?: typeof fetch;
  /**
   * The server target recorded on the resulting credential (hosted vs local). Defaults to
   * `serverBaseUrl`. Kept distinct so a caller can record the hub URL if it prefers.
   */
  serverTarget?: string;
  /** Loopback host to bind; defaults to `127.0.0.1`. A non-loopback host is refused. */
  loopbackHost?: string;
  /** Redirect callback path; defaults to `/callback`. */
  callbackPath?: string;
  /** Max wait (ms) for the browser redirect before timing out; defaults to 5 minutes. */
  timeoutMs?: number;
  /**
   * Open the authorize URL in a browser. Defaults to {@link defaultBrowserOpener}. If this throws
   * (e.g. headless), the flow returns a clear `no_browser` error — never a hang.
   */
  openBrowser?: (url: string) => void;
  /** Optional: observe the exact authorize URL the flow built (e.g. to print a manual fallback). */
  onAuthorizeUrl?: (url: string) => void;
  /** Injectable loopback listener factory; defaults to {@link createLoopbackListener}. */
  listenerFactory?: LoopbackListenerFactory;
  /** Injectable token-exchange transport; defaults to {@link HttpAuthCodeTransport}. */
  transport?: AuthCodeTransport;
  /** Injectable randomness for the PKCE verifier + `state`; defaults to `crypto.randomBytes`. */
  randomBytes?: RandomBytesFn;
  /** Force a specific PKCE `code_verifier` (tests / golden vectors). Default: generated. */
  codeVerifier?: string;
  /** Force a specific `state` (tests). Default: generated. */
  state?: string;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. For deterministic `expiresAt`. */
  now?: () => number;
  /** Cancellation. */
  signal?: AbortSignal;
}

/** The outcome of {@link authCodeLogin}. Failures are values, not throws (network errors included). */
export type AuthCodeLoginResult =
  | { ok: true; credentials: MachineCredentials }
  | {
      ok: false;
      reason: "state_mismatch" | "timeout" | "no_browser" | "denied" | "error" | "cancelled";
      message: string;
    };

/**
 * Run the RFC 8252 authorization-code + PKCE (S256) desktop login end to end and return full
 * {@link MachineCredentials} on success. The caller persists them (this function never writes the
 * store), so an early failure leaves the store untouched. Surface-parallel to `deviceLogin`.
 */
export async function authCodeLogin(options: AuthCodeLoginOptions): Promise<AuthCodeLoginResult> {
  const scope = options.scope?.trim() || DEFAULT_PLUGIN_SCOPE;
  const serverTarget = options.serverTarget ?? options.serverBaseUrl;
  const host = options.loopbackHost ?? DEFAULT_LOOPBACK_HOST;
  const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTHCODE_TIMEOUT_MS;
  const openBrowser = options.openBrowser ?? defaultBrowserOpener;
  const listenerFactory = options.listenerFactory ?? createLoopbackListener;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const networkTimeoutMs = options.networkTimeoutMs ?? DEFAULT_DCR_TIMEOUT_MS;
  const staticClientId = options.clientId?.trim();
  // Dynamic (RFC 7591) mode is the default; an explicit `clientId` opts out and is used verbatim.
  const dynamic = !staticClientId;

  if (!isLoopbackHost(host)) {
    return {
      ok: false,
      reason: "error",
      message: `Refusing a non-loopback redirect host: ${host}. Native-app redirects MUST target 127.0.0.1 (RFC 8252 §7.3).`,
    };
  }

  if (signal?.aborted) {
    return { ok: false, reason: "cancelled", message: "Sign-in cancelled." };
  }

  const codeVerifier = options.codeVerifier ?? generateCodeVerifier(options.randomBytes);
  const codeChallenge = deriveCodeChallenge(codeVerifier);
  const state = options.state ?? generateState(options.randomBytes);

  let listener: LoopbackListener | undefined;
  try {
    listener = await listenerFactory({ host, path: callbackPath, timeoutMs, signal });
    const redirectUri = listener.redirectUri;

    // RFC 8252 §7.3: register the PORTLESS loopback URI. The AS matches scheme/host/path/query
    // exactly and lets ONLY the port float, so one registration serves every launch's random port.
    const registrationRedirectUri = `http://${loopbackHostForUrl(host)}${callbackPath}`;
    const registrationStore = dynamic
      ? (options.registrationStore ?? new ClientRegistrationStore())
      : undefined;

    let metadata: AuthorizationServerMetadata | undefined = options.metadata;
    let clientId: string;

    const resolveClient = (forceRegister: boolean): Promise<ResolvedClientRegistration> =>
      resolveClientRegistration({
        serverBaseUrl: options.serverBaseUrl,
        redirectUris: [registrationRedirectUri],
        clientName: options.clientName,
        scope,
        metadata,
        store: registrationStore,
        fetchImpl: options.fetchImpl,
        timeoutMs: networkTimeoutMs,
        signal,
        forceRegister,
      });

    if (staticClientId) {
      clientId = staticClientId;
    } else {
      const resolved = await resolveClient(false);
      clientId = resolved.clientId;
      metadata = resolved.metadata;
    }

    const buildUrl = (): string =>
      buildAuthorizeUrl({
        serverBaseUrl: options.serverBaseUrl,
        clientId,
        redirectUri,
        scope,
        state,
        codeChallenge,
        resource: options.resource,
        authorizeEndpoint: metadata?.authorization_endpoint,
      });

    let url = buildUrl();

    if (dynamic) {
      // The AS answers an unknown client_id to the BROWSER and never redirects (RFC 6749 §4.1.2.1),
      // so probing here is the only way to see `invalid_client` at all — otherwise it surfaces as a
      // five-minute "timeout". Bounded: at most ONE re-registration, then we accept the verdict.
      let probe = await probeAuthorizeRequest(url, options.fetchImpl, networkTimeoutMs, signal);
      if (!probe.ok && probe.error === "invalid_client") {
        const reRegistered = await resolveClient(true);
        clientId = reRegistered.clientId;
        metadata = reRegistered.metadata;
        url = buildUrl();
        probe = await probeAuthorizeRequest(url, options.fetchImpl, networkTimeoutMs, signal);
      }
      if (!probe.ok) {
        return {
          ok: false,
          reason: probe.error === "access_denied" ? "denied" : "error",
          message: describeAuthorizeRejection(probe),
        };
      }
    }

    // Re-check cancellation before touching the user's desktop. The authorize probe **fails open on
    // every transport error — the `AbortError` raised by an aborting `signal` included** — so a
    // sign-in cancelled while the probe was in flight would otherwise still pop a browser window
    // here, moments before `waitForRedirect` reported the cancellation.
    if (signal?.aborted) {
      return { ok: false, reason: "cancelled", message: "Sign-in cancelled." };
    }

    options.onAuthorizeUrl?.(url);

    // Open the browser BEFORE awaiting the redirect. A failure here is a clear error, not a hang.
    try {
      openBrowser(url);
    } catch (err) {
      return {
        ok: false,
        reason: "no_browser",
        message: `Cannot open a browser for sign-in (${describeError(err)}). Try device-code login instead.`,
      };
    }

    const redirect = await listener.waitForRedirect();

    // CSRF (RFC 6749 §10.12): the redirect's state MUST exactly match what we sent.
    if (!redirect.state || redirect.state !== state) {
      return {
        ok: false,
        reason: "state_mismatch",
        message: "Authorization response `state` did not match; possible CSRF. Sign-in refused.",
      };
    }

    if (redirect.error) {
      return {
        ok: false,
        reason: redirect.error === "access_denied" ? "denied" : "error",
        message: redirect.errorDescription ?? `Authorization failed: ${redirect.error}`,
      };
    }

    if (!redirect.code) {
      return { ok: false, reason: "error", message: "Authorization response did not include a code." };
    }

    const transport =
      options.transport ??
      new HttpAuthCodeTransport({
        serverBaseUrl: options.serverBaseUrl,
        clientId,
        resource: options.resource,
        tokenEndpoint: metadata?.token_endpoint,
        fetchImpl: options.fetchImpl,
      });

    const token = await transport.exchangeCode({ code: redirect.code, codeVerifier, redirectUri, signal });

    if (token.access_token) {
      return { ok: true, credentials: buildCredentials(token, serverTarget, now) };
    }

    if (token.error === "invalid_client" && registrationStore) {
      // The registration was revoked or garbage-collected between the probe and the exchange. The
      // authorization code is bound to the now-dead client, so retrying here is pointless — drop the
      // registration so the NEXT sign-in registers fresh, and say so plainly.
      try {
        registrationStore.delete(options.serverBaseUrl);
      } catch {
        /* best-effort: a stale entry costs one more invalid_client round, never correctness */
      }
      return {
        ok: false,
        reason: "error",
        message:
          token.error_description ??
          "This installation's client registration is no longer valid. Please sign in again.",
      };
    }

    return {
      ok: false,
      reason: token.error === "access_denied" ? "denied" : "error",
      message: token.error_description ?? `Token exchange failed${token.error ? `: ${token.error}` : "."}`,
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      return { ok: false, reason: "cancelled", message: "Sign-in cancelled." };
    }
    if (err instanceof LoopbackTimeoutError) {
      return { ok: false, reason: "timeout", message: err.message };
    }
    return { ok: false, reason: "error", message: describeNetworkError(err) };
  } finally {
    listener?.close();
  }
}

/** The verdict of {@link probeAuthorizeRequest}. */
interface AuthorizeProbeResult {
  /** True when the AS accepted the authorization request (any non-4xx/5xx outcome). */
  ok: boolean;
  status?: number;
  /** RFC 6749 §5.2 error code parsed from a rejection body (e.g. `invalid_client`). */
  error?: string;
  errorDescription?: string;
}

/**
 * Ask the AS whether it will accept this authorization request BEFORE a browser is opened.
 *
 * The redirect is followed manually so the probe costs a single request and never fetches the
 * consent page. A 2xx/3xx means "accepted" — the browser is then pointed at the same authorize URL,
 * which mints its own short-lived authorization request; the probe's own request record simply
 * expires unused.
 *
 * **Fails open on transport errors**: if the probe itself cannot run (no `fetch`, a proxy that
 * refuses it, an environment without `redirect: "manual"`), the flow proceeds exactly as it would
 * have without a probe. Only a definitive HTTP rejection stops a sign-in.
 */
async function probeAuthorizeRequest(
  url: string,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<AuthorizeProbeResult> {
  const doFetch = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status < 400) {
      return { ok: true, status: response.status };
    }
    const text = await response.text().catch(() => "");
    let error: string | undefined;
    let errorDescription: string | undefined;
    if (text.trim()) {
      try {
        const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
        if (typeof body.error === "string") error = body.error;
        if (typeof body.error_description === "string") errorDescription = body.error_description;
      } catch {
        /* a non-JSON error page still tells us the request was rejected */
      }
    }
    return { ok: false, status: response.status, error, errorDescription };
  } catch {
    // Fail open: a probe we could not run must never block a sign-in that would have worked.
    return { ok: true };
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

/** Turn a rejected authorize probe into a message that names the real fault, not a timeout. */
function describeAuthorizeRejection(probe: AuthorizeProbeResult): string {
  if (probe.error === "invalid_client") {
    return (
      "The authorization server rejected this application's client registration " +
      "(invalid_client), even after re-registering. Sign-in cannot continue." +
      (probe.errorDescription ? ` Server said: ${probe.errorDescription}` : "")
    );
  }
  if (probe.errorDescription) {
    return `The authorization server refused the sign-in request: ${probe.errorDescription}`;
  }
  if (probe.error) {
    return `The authorization server refused the sign-in request: ${probe.error}`;
  }
  return `The authorization server refused the sign-in request (HTTP ${probe.status ?? "error"}).`;
}

/** Build the full credential document from a successful token response (parity with `deviceLogin`). */
function buildCredentials(
  token: AuthCodeTokenResponse,
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

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeNetworkError(err: unknown): string {
  const message = describeError(err);
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return `Cannot reach the authorization server: ${message}`;
  }
  return `Authentication failed: ${message}`;
}

async function parseTokenResponse(response: Response): Promise<AuthCodeTokenResponse> {
  const text = await safeText(response);
  if (!text) {
    if (response.ok) return {};
    return { error: "error", error_description: `Token endpoint returned HTTP ${response.status}` };
  }
  try {
    return JSON.parse(text) as AuthCodeTokenResponse;
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
