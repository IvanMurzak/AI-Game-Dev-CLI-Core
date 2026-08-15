import { REFRESH_HTTP_TIMEOUT } from "./credential-lock.js";
import { DEFAULT_PLUGIN_SCOPE, tokenUrl } from "./oauth-device-flow.js";
import { normalizeServerBase } from "./token-refresher.js";

/**
 * RFC 8693 token-exchange client (unified-machine-auth 04 §4, O2) — derives the plugin-plane
 * family from a freshly minted agent access token at the existing `/oauth/token` endpoint. The
 * wire shape is FROZEN by the server-side a5 implementation (AGS PR #592) and pinned by tests:
 *
 *  - request: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
 *    `subject_token=<agent ES256 access token>` (PATs are rejected server-side),
 *    `subject_token_type=urn:ietf:params:oauth:token-type:access_token` (exact URN),
 *    `client_id=<own id, ≤64 chars>`, `scope=mcp:plugin` (anything else → `invalid_scope`);
 *  - `audience` / `resource` may be sent ONLY as the exact {@link HUB_AUDIENCE} (`urn:agd:hub`) —
 *    this client sends the exact value when asked and otherwise omits the parameter entirely;
 *  - response keys exactly: `access_token`, `issued_token_type`, `token_type=Bearer`,
 *    `expires_in`, `refresh_token` (RFC 8693 §2.2.1's documented exception), `scope`, `sub`.
 *
 * The derived family is stamped with the presented `client_id` — the exchanging client's OWN id,
 * never a synthetic one (O2/D8). This module is the HTTP seam only: the login-commit helper
 * (`login-commit.ts`) owns the two-lock-hold F1/F2 write sequence around it.
 *
 * It **fails closed**: any non-success, missing access token, invalid input, or exception becomes
 * a {@link TokenExchangeResult} failure — never a throw past the boundary, and it never logs
 * token material.
 */

/** RFC 8693 token-exchange grant type (frozen a5 shape). */
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";

/** RFC 8693 subject-token type for an access token — the EXACT URN the server requires (a5). */
export const TOKEN_TYPE_ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";

/** The ONLY `audience`/`resource` value the exchange endpoint accepts (send exact or omit — a5). */
export const HUB_AUDIENCE = "urn:agd:hub";

/** Server-enforced maximum `client_id` length on the exchange request (a5). */
export const TOKEN_EXCHANGE_MAX_CLIENT_ID_LENGTH = 64;

/** RFC 8693 token-exchange response document (frozen a5 keys) + RFC 6749 §5.2 error shape. */
export interface TokenExchangeResponse {
  access_token?: string;
  issued_token_type?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  sub?: string;
  error?: string;
  error_description?: string;
}

/** One exchange request: the fresh agent access token + the exchanging client's own id. */
export interface TokenExchangeRequest {
  /** A FRESH agent-plane ES256 access token (the `subject_token`; PATs are rejected server-side). */
  subjectToken: string;
  /** The exchanging client's OWN OAuth client id (≤64 chars) — stamped onto the derived family. */
  clientId: string;
  /** The credential's server target (AS root or `/mcp` hub URL — normalized before use). */
  serverTarget?: string;
  /**
   * Optional RFC 8693 `audience`. The server accepts ONLY the exact {@link HUB_AUDIENCE}; any
   * other value fails closed here before the network. Omit (default) to let the server default.
   */
  audience?: string;
  /** Cancellation. */
  signal?: AbortSignal;
}

/** The result of an exchange attempt — a value, never a throw. */
export type TokenExchangeResult =
  | {
      ok: true;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
      scope?: string;
      sub?: string;
      issuedTokenType?: string;
      tokenType?: string;
    }
  | { ok: false; reason: string };

/** The exchange transport seam (injectable for tests and for the login-commit helper). */
export interface TokenExchangeClient {
  exchange(request: TokenExchangeRequest): Promise<TokenExchangeResult>;
}

/**
 * Build the frozen a5 exchange form: exactly `grant_type` + `subject_token` +
 * `subject_token_type` + `client_id` + `scope=mcp:plugin`, plus `audience` ONLY when provided
 * (callers must pass the exact {@link HUB_AUDIENCE}). Nothing else is ever added.
 */
export function buildTokenExchangeForm(
  subjectToken: string,
  clientId: string,
  audience?: string,
): URLSearchParams {
  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: subjectToken,
    subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
    client_id: clientId,
    scope: DEFAULT_PLUGIN_SCOPE,
  });
  if (audience !== undefined) {
    form.set("audience", audience);
  }
  return form;
}

/** Turn a parsed exchange response into a {@link TokenExchangeResult}. */
export function buildTokenExchangeResult(
  isSuccessStatus: boolean,
  statusCode: number,
  parsed: TokenExchangeResponse | null,
  now: () => number = Date.now,
): TokenExchangeResult {
  if (parsed == null) {
    return { ok: false, reason: "empty token-exchange response" };
  }
  if (!isSuccessStatus || !parsed.access_token) {
    return { ok: false, reason: parsed.error ?? `token exchange failed (HTTP ${statusCode})` };
  }
  const result: TokenExchangeResult = { ok: true, accessToken: parsed.access_token };
  if (parsed.refresh_token) {
    result.refreshToken = parsed.refresh_token;
  }
  if (typeof parsed.expires_in === "number" && parsed.expires_in > 0) {
    result.expiresAt = new Date(now() + parsed.expires_in * 1000).toISOString();
  }
  if (parsed.scope) {
    result.scope = parsed.scope;
  }
  if (parsed.sub) {
    result.sub = parsed.sub;
  }
  if (parsed.issued_token_type) {
    result.issuedTokenType = parsed.issued_token_type;
  }
  if (parsed.token_type) {
    result.tokenType = parsed.token_type;
  }
  return result;
}

/** Options for the default fetch-backed exchange client. */
export interface HttpTokenExchangeClientOptions {
  /** The AS root used when a request carries no `serverTarget`. */
  defaultServerBaseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request network timeout (ms). Defaults to {@link REFRESH_HTTP_TIMEOUT} (15 s). */
  timeoutMs?: number;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. */
  now?: () => number;
}

/** The default {@link TokenExchangeClient}: a form-encoded POST to `{base}/oauth/token`. */
export class HttpTokenExchangeClient implements TokenExchangeClient {
  private readonly _defaultBase: string;
  private readonly _fetch: typeof fetch;
  private readonly _timeoutMs: number;
  private readonly _now: () => number;

  constructor(options: HttpTokenExchangeClientOptions) {
    this._defaultBase = normalizeServerBase(options.defaultServerBaseUrl) ?? "";
    this._fetch = options.fetchImpl ?? fetch;
    this._timeoutMs = options.timeoutMs ?? REFRESH_HTTP_TIMEOUT;
    this._now = options.now ?? Date.now;
  }

  async exchange(request: TokenExchangeRequest): Promise<TokenExchangeResult> {
    if (!request.subjectToken) {
      return { ok: false, reason: "no subject token" };
    }
    const clientId = request.clientId?.trim();
    if (!clientId) {
      return { ok: false, reason: "no client id" };
    }
    if (clientId.length > TOKEN_EXCHANGE_MAX_CLIENT_ID_LENGTH) {
      return {
        ok: false,
        reason: `client id exceeds ${TOKEN_EXCHANGE_MAX_CLIENT_ID_LENGTH} characters`,
      };
    }
    if (request.audience !== undefined && request.audience !== HUB_AUDIENCE) {
      // a5: audience/resource ONLY as the exact URN — anything else is rejected server-side, so
      // fail closed here instead of burning a doomed network round trip.
      return { ok: false, reason: `audience must be exactly ${HUB_AUDIENCE} or omitted` };
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
        body: buildTokenExchangeForm(request.subjectToken, clientId, request.audience).toString(),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: TokenExchangeResponse | null = null;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text) as TokenExchangeResponse;
        } catch {
          parsed = { error: "invalid token-exchange response" };
        }
      }
      return buildTokenExchangeResult(response.ok, response.status, parsed, this._now);
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
