import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeFileAtomicSync } from "./atomic-file.js";
import { MACHINE_STORE_DIR_NAME } from "./machine-credentials.js";
import { OAUTH_DEVICE_AUTHORIZATION_PATH, OAUTH_TOKEN_PATH } from "./oauth-device-flow.js";
import { normalizeServerBase } from "./token-refresher.js";

/**
 * **RFC 8414** authorization-server metadata discovery + **RFC 7591** Dynamic Client Registration
 * (DCR), with a durable per-authorization-server registration store.
 *
 * ## Why this module exists
 *
 * The ai-game.dev authorization server resolves `client_id` at `/oauth/authorize` by an **exact
 * lookup in its client registry**, and the ONLY writer of that registry is `POST /oauth/register`,
 * which **mints its own** `agd_client_<24-urlsafe>` id and ignores any caller-supplied one. A
 * hardcoded/static client id therefore can never resolve there — the AS answers
 * `HTTP 400 {"error":"invalid_client","error_description":"unknown client_id"}`.
 *
 * That failure is delivered to the **browser**, and RFC 6749 §4.1.2.1 forbids redirecting an
 * unverified `client_id` back to a `redirect_uri` — so the loopback listener never hears anything and
 * the desktop login appears to "time out" minutes later. **The timeout is a symptom; the unregistered
 * client id is the fault.** {@link ../oauth-authcode-flow.authCodeLogin} therefore probes the
 * authorize request before opening a browser (see its doc comment) instead of waiting the timeout out.
 *
 * The **device grant is deliberately untouched**: `/oauth/device_authorization` accepts ANY client id,
 * and the server binds each refresh-token family to the client id used at issue time — moving the
 * device flow onto a DCR-minted id would invalidate every existing CLI login. DCR is scoped to the
 * authorization-code flow only.
 *
 * ## What it does
 *
 * - {@link discoverAuthorizationServer} — `GET /.well-known/oauth-authorization-server` (RFC 8414
 *   §3.1: the well-known segment is inserted between host and issuer path) to locate the
 *   `registration_endpoint` / `authorization_endpoint` / `token_endpoint`. Never throws: on any
 *   failure it falls back to this package's hardcoded paths, so a server without RFC 8414 metadata
 *   keeps working exactly as before.
 * - {@link registerClient} — a one-shot RFC 7591 `POST` that returns the AS-minted `client_id`.
 * - {@link ClientRegistrationStore} — persists that registration **keyed by authorization-server base
 *   URL** (so a dev server and production can never collide) at
 *   `~/.ai-game-dev/oauth-clients.json`, with the same atomic, owner-only write the credential store
 *   uses. Reads are fault-tolerant: a missing or corrupt file simply means "not registered yet".
 * - {@link resolveClientRegistration} — the orchestrator: discover → reuse the stored registration →
 *   otherwise register once and persist. `forceRegister` is the recovery path used exactly once when
 *   the AS reports `invalid_client` (the server GCs unused clients after 30 days, and a client can be
 *   revoked).
 *
 * ## Not secret material
 *
 * A registration here is a **public client** (`token_endpoint_auth_method: "none"` — the only method
 * the AS advertises): there is no client secret, and a `client_id` is not a credential. The file is
 * still written owner-only, and a `client_secret` returned by some other AS is deliberately **not
 * persisted** — using one would require confidential-client auth this flow does not perform.
 */

/** Path (relative to the AS root) of the RFC 8414 authorization-server metadata document. */
export const OAUTH_AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** Path (relative to the AS root) of the RFC 7591 dynamic client registration endpoint. */
export const OAUTH_REGISTRATION_PATH = "/oauth/register";

/** Path (relative to the AS root) of the OAuth 2.1 authorization endpoint. */
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";

/** File name (inside the machine store directory) of the client-registration document. */
export const CLIENT_REGISTRATIONS_FILE_NAME = "oauth-clients.json";

/** Current persisted-document schema version of {@link CLIENT_REGISTRATIONS_FILE_NAME}. */
export const CLIENT_REGISTRATIONS_SCHEMA_VERSION = 1;

/**
 * Fallback `client_name`. This string is shown to the user on the AS consent screen, so it MUST stay
 * a human-readable product name — never a slug like `ai-game-dev-app`.
 */
export const DEFAULT_CLIENT_NAME = "AI Game Dev";

/** RFC 7591 auth method requested for the registration: a public client with no secret. */
export const DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD = "none";

/** Grant types requested at registration for the desktop authorization-code login. */
export const DEFAULT_REGISTRATION_GRANT_TYPES: readonly string[] = ["authorization_code", "refresh_token"];

/** Response types requested at registration. */
export const DEFAULT_REGISTRATION_RESPONSE_TYPES: readonly string[] = ["code"];

/** Default per-request network timeout (ms) for discovery and registration. */
export const DEFAULT_DCR_TIMEOUT_MS = 30_000;

/**
 * The subset of RFC 8414 authorization-server metadata this package consumes. Unknown members are
 * preserved (index signature) so a caller can read anything else the AS advertises.
 */
export interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  device_authorization_endpoint?: string;
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
  response_types_supported?: string[];
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  [key: string]: unknown;
}

/** A client registration as minted by the AS (RFC 7591 §3.2.1), in this package's camelCase shape. */
export interface ClientRegistration {
  /** The AS-minted client identifier — the ONLY value `/oauth/authorize` will accept. */
  clientId: string;
  /** Human-readable name shown on the consent screen. */
  clientName?: string;
  /** The redirect URIs the AS recorded. Loopback ports float (RFC 8252 §7.3). */
  redirectUris?: string[];
  grantTypes?: string[];
  responseTypes?: string[];
  tokenEndpointAuthMethod?: string;
  scope?: string;
  /** RFC 7591 `client_id_issued_at` (seconds since epoch), when the AS supplies it. */
  clientIdIssuedAt?: number;
  /** The registration endpoint that minted this id — recorded for diagnostics. */
  registrationEndpoint?: string;
  /** ISO-8601 timestamp of when this client wrote the registration. */
  registeredAt?: string;
}

/**
 * The persistence seam for {@link resolveClientRegistration}. {@link ClientRegistrationStore} is the
 * on-disk implementation; tests (and an App that prefers its own keychain) can substitute any object
 * with these three methods.
 */
export interface ClientRegistrationStoreLike {
  read(serverBaseUrl: string): ClientRegistration | null;
  save(serverBaseUrl: string, registration: ClientRegistration): void;
  delete(serverBaseUrl: string): void;
}

/** The persisted document shape of `~/.ai-game-dev/oauth-clients.json`. */
interface ClientRegistrationDocument {
  version?: number;
  clients?: Record<string, ClientRegistration>;
}

/** Trim a trailing slash so `{base}/oauth/...` resolves cleanly. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The RFC 8414 §3.1 metadata URL for an issuer: the well-known segment is inserted **between the
 * host and the issuer path**, not appended to it (`https://as.example/tenant` →
 * `https://as.example/.well-known/oauth-authorization-server/tenant`). An issuer with no path — the
 * ai-game.dev case — reduces to the familiar `{base}/.well-known/oauth-authorization-server`.
 */
export function authorizationServerMetadataUrl(serverBaseUrl: string): string {
  const base = trimTrailingSlash(serverBaseUrl);
  try {
    const url = new URL(base);
    return `${url.origin}${OAUTH_AS_METADATA_PATH}${trimTrailingSlash(url.pathname)}`;
  } catch {
    return `${base}${OAUTH_AS_METADATA_PATH}`;
  }
}

/** Absolute RFC 7591 registration URL for an AS root (the pre-discovery fallback). */
export function registrationUrl(serverBaseUrl: string): string {
  return `${trimTrailingSlash(serverBaseUrl)}${OAUTH_REGISTRATION_PATH}`;
}

/**
 * This package's hardcoded endpoint layout — the sane fallback when an AS serves no RFC 8414
 * document (or it is unreachable). Identical to the paths every flow used before discovery existed,
 * so falling back is never a regression.
 */
export function fallbackAuthorizationServerMetadata(serverBaseUrl: string): AuthorizationServerMetadata {
  const base = trimTrailingSlash(serverBaseUrl);
  return {
    issuer: base,
    authorization_endpoint: `${base}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${base}${OAUTH_TOKEN_PATH}`,
    registration_endpoint: `${base}${OAUTH_REGISTRATION_PATH}`,
    device_authorization_endpoint: `${base}${OAUTH_DEVICE_AUTHORIZATION_PATH}`,
  };
}

/** Options for {@link discoverAuthorizationServer}. */
export interface DiscoverAuthorizationServerOptions {
  /** The AS root (e.g. `https://ai-game.dev`) — NOT the `/mcp` hub URL. */
  serverBaseUrl: string;
  /** Injectable `fetch` for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request network timeout (ms). Default 30s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The outcome of {@link discoverAuthorizationServer} — always a usable metadata document. */
export interface DiscoveredAuthorizationServer {
  /** Discovered members merged over {@link fallbackAuthorizationServerMetadata}. */
  metadata: AuthorizationServerMetadata;
  /** True when a well-known document was actually fetched and parsed; false when falling back. */
  discovered: boolean;
}

/**
 * Fetch the RFC 8414 metadata document for an AS. **Never throws and never rejects**: a 404, a
 * non-JSON body, a network error, an abort, or a document whose `issuer` contradicts the AS it was
 * fetched for (RFC 8414 §3.3 — see {@link issuerMatches}) all resolve to the hardcoded
 * {@link fallbackAuthorizationServerMetadata} with `discovered: false`, so discovery can only ever
 * improve on the status quo. A partial document is merged OVER the fallback, so a metadata doc that
 * omits (say) `registration_endpoint` still yields a usable one — and an endpoint the document
 * advertises as something this package cannot dereference (a relative URI, a non-string, a
 * non-HTTP scheme) is dropped the same way an omitted one is (see {@link dropUnusableEndpoints}).
 */
export async function discoverAuthorizationServer(
  options: DiscoverAuthorizationServerOptions,
): Promise<DiscoveredAuthorizationServer> {
  const fallback = fallbackAuthorizationServerMetadata(options.serverBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(authorizationServerMetadataUrl(options.serverBaseUrl), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal,
        }),
      options.timeoutMs ?? DEFAULT_DCR_TIMEOUT_MS,
      options.signal,
    );
    if (!response.ok) {
      return { metadata: fallback, discovered: false };
    }
    const document = (await response.json()) as unknown;
    if (!isRecord(document)) {
      return { metadata: fallback, discovered: false };
    }
    if (!issuerMatches(document, options.serverBaseUrl)) {
      return { metadata: fallback, discovered: false };
    }
    return {
      metadata: { ...fallback, ...dropUnusableEndpoints(dropEmptyValues(document)) },
      discovered: true,
    };
  } catch {
    // Discovery is best-effort by design; the fallback paths are what shipped before it existed.
    return { metadata: fallback, discovered: false };
  }
}

/** Raised when the AS refuses (or bungles) an RFC 7591 registration. */
export class ClientRegistrationError extends Error {
  /** HTTP status of the registration response, when there was one. */
  readonly status: number | undefined;
  /** The RFC 6749 §5.2-style `error` code from the response body, when present. */
  readonly errorCode: string | undefined;

  constructor(message: string, details: { status?: number; errorCode?: string } = {}) {
    super(message);
    this.name = "ClientRegistrationError";
    this.status = details.status;
    this.errorCode = details.errorCode;
  }
}

/** Options for {@link registerClient}. */
export interface RegisterClientOptions {
  /** Absolute registration endpoint (from discovery, or {@link registrationUrl}). */
  registrationEndpoint: string;
  /**
   * The redirect URIs to register. For a native app these are **portless** loopback URIs
   * (`http://127.0.0.1/callback`): RFC 8252 §7.3 lets the port float at authorize time, so ONE
   * registration serves every launch's random ephemeral port. Scheme/host/path/query must still
   * match exactly.
   */
  redirectUris: string[];
  /** Human-readable name shown on the consent screen. Defaults to {@link DEFAULT_CLIENT_NAME}. */
  clientName?: string;
  grantTypes?: readonly string[];
  responseTypes?: readonly string[];
  tokenEndpointAuthMethod?: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Register this installation as a new OAuth client (RFC 7591 §3.1) and return the AS-minted
 * identity. Throws {@link ClientRegistrationError} on any non-2xx response or a body without a
 * usable `client_id` — the caller decides whether that is fatal.
 */
export async function registerClient(options: RegisterClientOptions): Promise<ClientRegistration> {
  if (!options.registrationEndpoint?.trim()) {
    throw new ClientRegistrationError("registrationEndpoint is required");
  }
  if (!options.redirectUris?.length) {
    throw new ClientRegistrationError("at least one redirect URI is required");
  }

  const clientName = options.clientName?.trim() || DEFAULT_CLIENT_NAME;
  const tokenEndpointAuthMethod = options.tokenEndpointAuthMethod?.trim() || DEFAULT_TOKEN_ENDPOINT_AUTH_METHOD;
  const grantTypes = [...(options.grantTypes ?? DEFAULT_REGISTRATION_GRANT_TYPES)];
  const responseTypes = [...(options.responseTypes ?? DEFAULT_REGISTRATION_RESPONSE_TYPES)];
  const scope = options.scope?.trim();

  const body: Record<string, unknown> = {
    client_name: clientName,
    redirect_uris: options.redirectUris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: tokenEndpointAuthMethod,
  };
  if (scope) {
    body.scope = scope;
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await withTimeout(
      (signal) =>
        fetchImpl(options.registrationEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      options.timeoutMs ?? DEFAULT_DCR_TIMEOUT_MS,
      options.signal,
    );
  } catch (err) {
    throw new ClientRegistrationError(
      `Could not reach the client registration endpoint: ${describeError(err)}`,
    );
  }

  const document = await readJsonBody(response);

  if (!response.ok) {
    const errorCode = stringOrUndefined(document?.error);
    const description = stringOrUndefined(document?.error_description);
    throw new ClientRegistrationError(
      `Client registration failed (HTTP ${response.status})${description ? `: ${description}` : errorCode ? `: ${errorCode}` : ""}`,
      { status: response.status, errorCode },
    );
  }

  const clientId = stringOrUndefined(document?.client_id);
  if (!clientId) {
    throw new ClientRegistrationError("Client registration response did not include a client_id", {
      status: response.status,
    });
  }

  const registration: ClientRegistration = {
    clientId,
    clientName: stringOrUndefined(document?.client_name) ?? clientName,
    redirectUris: stringArrayOrUndefined(document?.redirect_uris) ?? [...options.redirectUris],
    grantTypes: stringArrayOrUndefined(document?.grant_types) ?? grantTypes,
    responseTypes: stringArrayOrUndefined(document?.response_types) ?? responseTypes,
    tokenEndpointAuthMethod:
      stringOrUndefined(document?.token_endpoint_auth_method) ?? tokenEndpointAuthMethod,
    registrationEndpoint: options.registrationEndpoint,
    registeredAt: new Date().toISOString(),
  };
  const issuedAt = document?.client_id_issued_at;
  if (typeof issuedAt === "number" && Number.isFinite(issuedAt)) {
    registration.clientIdIssuedAt = issuedAt;
  }
  if (scope) {
    registration.scope = scope;
  }
  // NOTE: a `client_secret` (if some AS returns one despite `token_endpoint_auth_method: none`) is
  // deliberately NOT persisted — this flow never performs client authentication, and storing a
  // secret would demand the credential store's at-rest protection rather than this plain document.
  return registration;
}

/**
 * Normalize an AS base URL into the store key: the AS root (a trailing `/mcp` hub segment stripped),
 * lowercased scheme + host + port. This is what keeps a local dev server
 * (`http://localhost:8000`) and production (`https://ai-game.dev`) in separate slots.
 */
export function registrationStoreKey(serverBaseUrl: string): string {
  const base = normalizeServerBase(serverBaseUrl);
  if (!base) {
    throw new Error("serverBaseUrl is required");
  }
  try {
    const url = new URL(base);
    return `${url.protocol}//${url.host}${trimTrailingSlash(url.pathname)}`;
  } catch {
    return base.toLowerCase();
  }
}

/**
 * The durable client-registration store: `~/.ai-game-dev/oauth-clients.json`, one entry per
 * authorization server. Pass an explicit `baseDirectory` in tests. Writes are atomic and owner-only
 * (shared with the credential store); reads never throw — a missing, empty, or corrupt document
 * simply reads as "nothing registered", which makes the next login re-register instead of failing.
 */
export class ClientRegistrationStore implements ClientRegistrationStoreLike {
  private readonly _baseDirectory: string;

  constructor(baseDirectory?: string) {
    this._baseDirectory = baseDirectory ?? path.join(os.homedir(), MACHINE_STORE_DIR_NAME);
  }

  /** Absolute path of the store directory. */
  get baseDirectory(): string {
    return this._baseDirectory;
  }

  /** Absolute path of the registration document. */
  get registrationsPath(): string {
    return path.join(this._baseDirectory, CLIENT_REGISTRATIONS_FILE_NAME);
  }

  /** Every stored registration, keyed by {@link registrationStoreKey}. Never throws. */
  readAll(): Record<string, ClientRegistration> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registrationsPath, "utf-8");
    } catch {
      return {};
    }
    if (!raw.trim()) {
      return {};
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      // A corrupt document must never break sign-in: treat it as empty and re-register.
      return {};
    }
    if (!isRecord(document)) {
      return {};
    }
    const clients = (document as ClientRegistrationDocument).clients;
    if (!isRecord(clients)) {
      return {};
    }
    const result: Record<string, ClientRegistration> = {};
    for (const [key, value] of Object.entries(clients)) {
      if (isRecord(value) && stringOrUndefined(value.clientId)) {
        result[key] = value as unknown as ClientRegistration;
      }
    }
    return result;
  }

  /** The registration for one AS, or null when this installation has not registered there yet. */
  read(serverBaseUrl: string): ClientRegistration | null {
    return this.readAll()[registrationStoreKey(serverBaseUrl)] ?? null;
  }

  /** Persist (or replace) the registration for one AS, leaving every other AS entry intact. */
  save(serverBaseUrl: string, registration: ClientRegistration): void {
    const clients = this.readAll();
    clients[registrationStoreKey(serverBaseUrl)] = registration;
    this.writeAll(clients);
  }

  /** Forget the registration for one AS (the `invalid_client` recovery path). */
  delete(serverBaseUrl: string): void {
    const clients = this.readAll();
    const key = registrationStoreKey(serverBaseUrl);
    if (!(key in clients)) {
      return;
    }
    delete clients[key];
    this.writeAll(clients);
  }

  private writeAll(clients: Record<string, ClientRegistration>): void {
    const document: ClientRegistrationDocument = {
      version: CLIENT_REGISTRATIONS_SCHEMA_VERSION,
      clients,
    };
    writeFileAtomicSync(this.registrationsPath, Buffer.from(JSON.stringify(document, null, 2), "utf-8"));
  }
}

/** Options for {@link resolveClientRegistration}. */
export interface ResolveClientRegistrationOptions {
  /** The AS root (e.g. `https://ai-game.dev`). */
  serverBaseUrl: string;
  /** The portless loopback redirect URIs to register / to validate a cached registration against. */
  redirectUris: string[];
  /** Human-readable consent-screen name. Defaults to {@link DEFAULT_CLIENT_NAME}. */
  clientName?: string;
  scope?: string;
  grantTypes?: readonly string[];
  responseTypes?: readonly string[];
  /** Pre-discovered metadata; when omitted, {@link discoverAuthorizationServer} runs. */
  metadata?: AuthorizationServerMetadata;
  /** Persistence seam; defaults to the on-disk {@link ClientRegistrationStore}. */
  store?: ClientRegistrationStoreLike;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Discard any cached registration and mint a fresh one. This is the **bounded** recovery path the
   * login flow takes exactly once after the AS reports `invalid_client` (30-day GC of unused clients,
   * or a revocation) — never a loop.
   */
  forceRegister?: boolean;
}

/** The resolved client identity the authorization-code flow will present. */
export interface ResolvedClientRegistration {
  /** The AS-minted client id to send to `/oauth/authorize` and `/oauth/token`. */
  clientId: string;
  registration: ClientRegistration;
  /** The metadata used (discovered or fallback), so the caller can reuse the discovered endpoints. */
  metadata: AuthorizationServerMetadata;
  /** True when the registration was reused from the store (no network registration happened). */
  reused: boolean;
}

/**
 * Discover the AS, then reuse this installation's stored registration — or mint and persist one.
 *
 * A stored registration is reused only when it still covers every required redirect URI; otherwise
 * (a changed callback path or loopback host) it is replaced, because the AS matches
 * scheme/host/path/query exactly and only lets the PORT float.
 *
 * Persisting is **best-effort**: a read-only or full home directory degrades to "register again next
 * launch" rather than failing a sign-in that would otherwise succeed.
 */
export async function resolveClientRegistration(
  options: ResolveClientRegistrationOptions,
): Promise<ResolvedClientRegistration> {
  const store = options.store ?? new ClientRegistrationStore();
  const metadata =
    options.metadata ??
    (
      await discoverAuthorizationServer({
        serverBaseUrl: options.serverBaseUrl,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      })
    ).metadata;

  if (!options.forceRegister) {
    const cached = readQuietly(store, options.serverBaseUrl);
    if (cached && coversRedirectUris(cached, options.redirectUris)) {
      return { clientId: cached.clientId, registration: cached, metadata, reused: true };
    }
  }

  const registration = await registerClient({
    registrationEndpoint: metadata.registration_endpoint ?? registrationUrl(options.serverBaseUrl),
    redirectUris: options.redirectUris,
    clientName: options.clientName,
    grantTypes: options.grantTypes,
    responseTypes: options.responseTypes,
    scope: options.scope,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  try {
    store.save(options.serverBaseUrl, registration);
  } catch {
    // Best-effort: an unwritable store costs a re-registration next launch, never this sign-in.
  }

  return { clientId: registration.clientId, registration, metadata, reused: false };
}

/** True when a stored registration still covers every redirect URI the flow needs. */
function coversRedirectUris(registration: ClientRegistration, required: string[]): boolean {
  if (!registration.clientId?.trim()) {
    return false;
  }
  const recorded = registration.redirectUris;
  if (!recorded?.length) {
    // Nothing recorded to contradict — trust the id and let the AS be the judge.
    return true;
  }
  return required.every((uri) => recorded.includes(uri));
}

/** Read from an injected store without letting a store fault break sign-in. */
function readQuietly(
  store: ClientRegistrationStoreLike,
  serverBaseUrl: string,
): ClientRegistration | null {
  try {
    return store.read(serverBaseUrl);
  } catch {
    return null;
  }
}

/** Run `operation` under its own timeout, honouring an outer abort signal. */
async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch {
    return null;
  }
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * **RFC 8414 §3.3**: the `issuer` a metadata document returns MUST be identical to the issuer whose
 * well-known URL was used to retrieve it, and if it is not, "the data contained in the response MUST
 * NOT be used". That matters concretely here: the document's `token_endpoint` is where the
 * authorization code and the PKCE `code_verifier` get POSTed, so a document claiming to speak for a
 * different issuer must never be allowed to redirect them.
 *
 * A document that OMITS `issuer` entirely is treated as unverifiable-but-usable rather than hostile —
 * matching this module's existing tolerance for partial documents, whose omitted members simply fall
 * back to the hardcoded paths. But a `issuer` that is PRESENT and unusable (a number, an object, an
 * empty string) is a MISMATCH, never a free pass: treating malformed as absent would let any document
 * bypass this check outright by sending a non-string `issuer`, which is exactly what a document
 * substituting its own endpoints would do.
 */
function issuerMatches(document: Record<string, unknown>, serverBaseUrl: string): boolean {
  const raw = document.issuer;
  if (raw === undefined || raw === null) {
    return true;
  }
  const issuer = stringOrUndefined(raw);
  if (!issuer) {
    return false;
  }
  return canonicalIssuer(issuer) === canonicalIssuer(serverBaseUrl);
}

/** Canonical form for an issuer comparison: lowercased scheme + host, trailing slash insignificant. */
function canonicalIssuer(value: string): string {
  const trimmed = trimTrailingSlash(value.trim());
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${trimTrailingSlash(url.pathname)}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/**
 * The metadata members this package later dereferences as a URL — `new URL(...)` for the authorize
 * request, or a `fetch` target for registration / the token exchange.
 */
const URL_VALUED_METADATA_MEMBERS = [
  "authorization_endpoint",
  "token_endpoint",
  "registration_endpoint",
  "device_authorization_endpoint",
] as const;

/**
 * Drop any URL-valued member the AS advertised as something this package cannot dereference, so the
 * hardcoded fallback for that member survives instead.
 *
 * Without this, a single malformed member takes the WHOLE sign-in down rather than degrading: a
 * relative `"/oauth/authorize"` or a non-string makes `new URL()` / `.trim()` throw deep inside
 * {@link ../oauth-authcode-flow.authCodeLogin}, which surfaces as an opaque
 * `Authentication failed: Invalid URL` — for a login that the fallback paths would have completed.
 * That directly contradicts this module's contract that discovery "can only ever improve on the
 * status quo", so an unusable value is treated exactly like an absent one.
 */
function dropUnusableEndpoints(document: Record<string, unknown>): Record<string, unknown> {
  const result = { ...document };
  for (const member of URL_VALUED_METADATA_MEMBERS) {
    if (member in result && !isAbsoluteHttpUrl(result[member])) {
      delete result[member];
    }
  }
  return result;
}

/** True for an absolute `http(s)` URL — the only endpoint shape this package can actually use. */
function isAbsoluteHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Drop null/undefined/empty-string members so a partial document cannot blank a fallback value. */
function dropEmptyValues(document: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    result[key] = value;
  }
  return result;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === "string");
  return strings.length > 0 ? strings : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
