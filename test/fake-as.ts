import * as crypto from "node:crypto";
import * as http from "node:http";

/**
 * The local fake authorization server for the mixed-language refresh concurrency suite
 * (unified-machine-auth 04 §5 "Concurrency — real processes, not threads", task x2).
 *
 * It implements the `/oauth/token` `grant_type=refresh_token` endpoint with refresh-token
 * ROTATION, reuse ⇒ FAMILY REVOCATION, and the D10 30 s rotation grace window, mirroring the
 * merged reference implementation in AI-Game-Dev-Server
 * `backend/src/services/oauth_token_service.py` (dev @ 585b954286e283db2567584be4cfde08da9879bd).
 * In-memory maps replace Postgres (refresh-token rows) and Redis (the grace cache). Line-by-line
 * mapping (reference line numbers in the file above):
 *
 *   - `grant_refresh_token` validation ladder ......... :777-816  → `handleRefreshGrant`
 *       client_id required :778-779; refresh_token required :780-781; row lookup by SHA-256
 *       hash :783-790; unknown token ⇒ invalid_grant :791-792; REUSE DETECTION on a revoked
 *       row :794-811 (grace carve-out :804-808, family revoke + "refresh token reuse detected;
 *       token family revoked" :809-811); expiry :813-814; client_id mismatch :815-816.
 *   - scope narrow-only / resource audience ........... :820-834  → simplified equality checks
 *       (the real pin-normalization of `_audience_key` is not modelled: the 04 §3 clients omit
 *       `scope` and `resource` entirely, so these branches exist only to stay faithful to the
 *       failure shape if a test ever sends them).
 *   - rotation (revoke predecessor, mint successor
 *     in the SAME family, cache the grace record) ..... :838-853  → the rotate block
 *   - `_revoke_family` ................................ :337-360  → `revokeFamily`
 *   - `_store_rotation_grace` ......................... :454-481  → `storeRotationGrace`
 *       (keyed by the PREDECESSOR's token hash, TTL = the window)
 *   - `_try_rotation_grace` ........................... :484-567  → `tryRotationGrace`
 *       window>0 :499-501; authoritative window check on the predecessor row's revoked-at
 *       stamp :502-508 (the cache TTL is never the window authority); same client only
 *       :509-512; cache lookup :513-523; successor row must be ALIVE and in the same family —
 *       the ONE check that refuses both older generations and revoked families :524-545; same
 *       scope :548-550; same audience :551-552; a grace hit performs NO writes :396-398/:558-567.
 *
 * Deliberately NOT modelled (out of grant-semantics scope for a test double):
 *   - the AEAD sealing of the grace cache (:400-451) — at-rest hardening of the Redis transport,
 *     not grant semantics;
 *   - accounts (`_load_active_user`, :553-557) and ES256 signing (`_require_signing`, :777);
 *   - `expires_in` on a grace hit is derived from the ORIGINAL successor expiry (:396-398 "the
 *     window can never extend the family's lifetime") but clamped to ≥ 1 s because both real
 *     clients treat a missing/zero `expires_in` as "unknown expiry — never proactively refresh";
 *     the clamp affects client-side refresh SCHEDULING only, never the grant decision.
 *
 * The server binds 127.0.0.1 on an EPHEMERAL port picked at runtime (never a fixed default —
 * parallel suites on one CI host must not collide).
 */

export interface FakeAuthorizationServerOptions {
  /** D10 window in ms. 0 disables the grace window entirely (the plant-1 mutation). */
  graceWindowMs?: number;
  /** Lifetime of minted access tokens, in WHOLE seconds (`expires_in` is an integer per RFC
   * 6749 §4.2.2 and the C# parser reads it with `GetInt64()`). */
  accessTokenTtlSeconds?: number;
  /** Artificial delay before each token-endpoint request is processed — widens the client-side
   * race window so the lockless plants collide quickly and deterministically. */
  responseDelayMs?: number;
}

export interface MintedFamily {
  familyId: string;
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 absolute expiry of the access token. */
  expiresAt: string;
  clientId: string;
  scope: string;
}

export interface FakeAsCounters {
  /** Every POST /oauth/token refresh-grant request that reached the handler. */
  refreshCalls: number;
  /** Successful rotations (a predecessor revoked, a successor minted). */
  rotations: number;
  /** D10 idempotent replays answered from the grace cache (NO rotation performed). */
  graceHits: number;
  /** Reuse-triggered family revocation EVENTS (`_revoke_family` calls from the reuse branch). */
  familyRevokes: number;
}

interface TokenRow {
  hash: string;
  familyId: string;
  clientId: string;
  scope: string;
  resource: string | null;
  generation: number;
  expiresAtMs: number; // refresh-token expiry (long — 30 d in production)
  revokedAtMs: number | null;
}

interface GraceRecord {
  successorHash: string;
  accessToken: string;
  expiresAtMs: number; // ACCESS-token absolute expiry of the cached successor pair
  rawRefresh: string;
  scope: string;
  cachedAtMs: number; // the Redis-TTL surrogate (authority stays the predecessor's revokedAtMs)
}

interface HeldRotation {
  /** Resolves the moment a rotation is COMMITTED at the AS while its response is withheld —
   * the exact "between AS commit and response delivery" instant the lost-response plant kills
   * the client in. Carries the committed successor pair for by-value idempotency assertions. */
  committed: Promise<{ accessToken: string; refreshToken: string; rotatedAtMs: number }>;
  /** Destroy the withheld response socket — the response is now lost forever. */
  abandon: () => void;
}

const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 d (config.py:374)

function sha256Hex(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

function randomToken(prefix: string, generation: number): string {
  return `${prefix}-g${generation}-${crypto.randomBytes(24).toString("base64url")}`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export class FakeAuthorizationServer {
  private readonly _graceWindowMs: number;
  private readonly _accessTokenTtlSeconds: number;
  private readonly _responseDelayMs: number;

  private readonly _rows = new Map<string, TokenRow>();
  private readonly _graceCache = new Map<string, GraceRecord>();

  private _server: http.Server | null = null;
  private _port = 0;

  private _refreshCalls = 0;
  private _rotations = 0;
  private _graceHits = 0;
  private _familyRevokes = 0;

  private _hold: {
    fired: boolean;
    resolve: (value: { accessToken: string; refreshToken: string; rotatedAtMs: number }) => void;
    responses: http.ServerResponse[];
  } | null = null;

  constructor(options: FakeAuthorizationServerOptions = {}) {
    this._graceWindowMs = options.graceWindowMs ?? 30_000;
    this._accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 2;
    this._responseDelayMs = options.responseDelayMs ?? 0;
  }

  get port(): number {
    return this._port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get counters(): FakeAsCounters {
    return {
      refreshCalls: this._refreshCalls,
      rotations: this._rotations,
      graceHits: this._graceHits,
      familyRevokes: this._familyRevokes,
    };
  }

  /** The family's current live (non-revoked) refresh-token hash, for end-state assertions. */
  liveRefreshTokenHash(familyId: string): string | null {
    for (const row of this._rows.values()) {
      if (row.familyId === familyId && row.revokedAtMs === null) {
        return row.hash;
      }
    }
    return null;
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => {
      void this.route(req, res);
    });
    this._server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Ephemeral port (suite contract): the OS picks; a fixed default would collide across
      // parallel workers/suites on one CI host.
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake AS failed to bind an ephemeral port");
    }
    this._port = address.port;
    return this._port;
  }

  async close(): Promise<void> {
    const server = this._server;
    if (server === null) return;
    this._server = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /**
   * Seed a NEW refresh family (the suite's stand-in for the device-flow / token-exchange mint —
   * `_issue_grant` with `family_id=None`, :439-452) and return the raw pair for the store seed.
   */
  mintFamily(options: { clientId: string; scope?: string; resource?: string | null }): MintedFamily {
    const familyId = crypto.randomUUID();
    const scope = options.scope ?? "mcp:plugin";
    const resource = options.resource ?? null;
    const now = Date.now();
    const refreshToken = randomToken("rt", 0);
    const accessToken = randomToken("at", 0);
    this._rows.set(sha256Hex(refreshToken), {
      hash: sha256Hex(refreshToken),
      familyId,
      clientId: options.clientId,
      scope,
      resource,
      generation: 0,
      expiresAtMs: now + REFRESH_TOKEN_LIFETIME_MS,
      revokedAtMs: null,
    });
    return {
      familyId,
      accessToken,
      refreshToken,
      expiresAt: new Date(now + this._accessTokenTtlSeconds * 1000).toISOString(),
      clientId: options.clientId,
      scope,
    };
  }

  /** Arm the one-shot lost-response hook: the NEXT rotation commits, then its response is
   * withheld until {@link HeldRotation.abandon} destroys the socket. */
  holdNextRotation(): HeldRotation {
    let resolve!: (value: { accessToken: string; refreshToken: string; rotatedAtMs: number }) => void;
    const committed = new Promise<{ accessToken: string; refreshToken: string; rotatedAtMs: number }>(
      (res) => {
        resolve = res;
      },
    );
    const hold = { fired: false, resolve, responses: [] as http.ServerResponse[] };
    this._hold = hold;
    return {
      committed,
      abandon: () => {
        for (const response of hold.responses.splice(0)) {
          response.socket?.destroy();
        }
      },
    };
  }

  // ── HTTP plumbing ─────────────────────────────────────────────────────────────────────────────

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "POST" && req.url === "/oauth/token") {
        const body = await this.readBody(req);
        await this.handleTokenRequest(new URLSearchParams(body), res);
        return;
      }
      this.respondJson(res, 404, { error: "not_found", error_description: `no route for ${req.method} ${req.url}` });
    } catch (err) {
      this.respondJson(res, 500, {
        error: "server_error",
        error_description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private respondJson(res: http.ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  }

  private tokenError(res: http.ServerResponse, status: number, error: string, description: string): void {
    // TokenError rendering (:100-109): {"error", "error_description"} with the status code.
    this.respondJson(res, status, { error, error_description: description });
  }

  // ── The refresh grant (mirror of grant_refresh_token, :767-854) ───────────────────────────────

  private async handleTokenRequest(form: URLSearchParams, res: http.ServerResponse): Promise<void> {
    if (form.get("grant_type") !== "refresh_token") {
      this.tokenError(res, 400, "unsupported_grant_type", "only refresh_token is implemented by the fake AS");
      return;
    }
    this._refreshCalls += 1;

    if (this._responseDelayMs > 0) {
      // Serialization delay: widens the window in which a raced peer's request is in flight.
      await new Promise((resolve) => setTimeout(resolve, this._responseDelayMs));
    }

    const clientId = form.get("client_id");
    if (!clientId) {
      this.tokenError(res, 400, "invalid_request", "client_id is required"); // :778-779
      return;
    }
    const rawToken = form.get("refresh_token");
    if (!rawToken) {
      this.tokenError(res, 400, "invalid_request", "refresh_token is required"); // :780-781
      return;
    }

    const row = this._rows.get(sha256Hex(rawToken)); // :783-790
    if (row === undefined) {
      this.tokenError(res, 400, "invalid_grant", "unknown or invalid refresh token"); // :791-792
      return;
    }

    const now = Date.now();

    // ── REUSE DETECTION (:794-811) ──────────────────────────────────────────────────────────
    if (row.revokedAtMs !== null) {
      const grace = this.tryRotationGrace(row, clientId, form.get("scope"), form.get("resource"), now); // :804-806
      if (grace !== null) {
        this._graceHits += 1; // :807-808 — the cached successor pair, by value; NO writes
        this.respondJson(res, 200, {
          access_token: grace.accessToken,
          token_type: "Bearer",
          // Original successor expiry (:396-398), clamped ≥ 1 s (see the header note).
          expires_in: Math.max(1, Math.ceil((grace.expiresAtMs - now) / 1000)),
          refresh_token: grace.rawRefresh,
          scope: grace.scope,
        });
        return;
      }
      this.revokeFamily(row.familyId, now); // :809-810 (_revoke_family :337-360)
      this._familyRevokes += 1;
      this.tokenError(res, 400, "invalid_grant", "refresh token reuse detected; token family revoked"); // :811
      return;
    }

    if (row.expiresAtMs < now) {
      this.tokenError(res, 400, "invalid_grant", "refresh token has expired"); // :813-814
      return;
    }
    if (row.clientId !== clientId) {
      this.tokenError(res, 400, "invalid_grant", "client_id does not match the refresh token"); // :815-816
      return;
    }

    // Scope may only NARROW on refresh (:820-828). The 04 §3 clients omit scope entirely.
    const requestedScope = form.get("scope");
    let effectiveScope = row.scope;
    if (requestedScope) {
      const granted = new Set(row.scope.split(" ").filter(Boolean));
      const requested = requestedScope.split(" ").filter(Boolean);
      if (!requested.every((entry) => granted.has(entry))) {
        this.tokenError(res, 400, "invalid_scope", "requested scope exceeds the granted scope");
        return;
      }
      effectiveScope = requested.sort().join(" ") || row.scope;
    }
    // Resource may not change the audience (:829-834; pin normalization not modelled).
    const requestedResource = form.get("resource");
    if (requestedResource && stripTrailingSlash(row.resource ?? "") !== stripTrailingSlash(requestedResource)) {
      this.tokenError(res, 400, "invalid_target", "resource does not match the granted audience");
      return;
    }

    // ── Rotate (:838-853): revoke the presented token, mint a successor in the SAME family. ──
    const predecessorHash = row.hash; // :839
    row.revokedAtMs = now; // :840
    const generation = row.generation + 1;
    const successorRefresh = randomToken("rt", generation);
    const successorAccess = randomToken("at", generation);
    const accessExpiresAtMs = now + this._accessTokenTtlSeconds * 1000;
    this._rows.set(sha256Hex(successorRefresh), {
      hash: sha256Hex(successorRefresh),
      familyId: row.familyId,
      clientId,
      scope: effectiveScope,
      resource: row.resource,
      generation,
      expiresAtMs: now + REFRESH_TOKEN_LIFETIME_MS, // re-stamp per rotation (:300)
      revokedAtMs: null,
    });
    this._rotations += 1;
    this.storeRotationGrace(predecessorHash, {
      successorHash: sha256Hex(successorRefresh),
      accessToken: successorAccess,
      expiresAtMs: accessExpiresAtMs,
      rawRefresh: successorRefresh,
      scope: effectiveScope,
      cachedAtMs: now,
    }); // :851-853

    // Lost-response hook (plant 3): the rotation above is COMMITTED; withhold the response.
    const hold = this._hold;
    if (hold !== null && !hold.fired) {
      hold.fired = true;
      hold.responses.push(res);
      hold.resolve({ accessToken: successorAccess, refreshToken: successorRefresh, rotatedAtMs: now });
      return; // the response is never written — only abandon() releases the socket
    }

    this.respondJson(res, 200, {
      access_token: successorAccess,
      token_type: "Bearer",
      expires_in: this._accessTokenTtlSeconds,
      refresh_token: successorRefresh,
      scope: effectiveScope,
    });
  }

  // ── D10 grace machinery ───────────────────────────────────────────────────────────────────────

  /** Mirror of `_store_rotation_grace` (:454-481): best-effort cache of the successor pair under
   * the predecessor's hash, TTL = the window. A disabled window (≤ 0) stores nothing (:466-468). */
  private storeRotationGrace(predecessorHash: string, record: GraceRecord): void {
    if (this._graceWindowMs <= 0) {
      return;
    }
    this._graceCache.set(predecessorHash, record);
  }

  /** Mirror of `_try_rotation_grace` (:484-567). Returns the cached successor pair iff every
   * refusal rung passes; null falls back to reuse ⇒ family revoke exactly as before D10. */
  private tryRotationGrace(
    row: TokenRow,
    clientId: string,
    scope: string | null,
    resource: string | null,
    now: number,
  ): GraceRecord | null {
    if (this._graceWindowMs <= 0) return null; // :499-501
    if (row.revokedAtMs === null) return null; // :504-506
    // Authoritative window check: rotation stamps the predecessor's revoked-at (:502-508).
    if (now - row.revokedAtMs > this._graceWindowMs) return null;
    if (row.clientId !== clientId) return null; // :509-512
    const record = this._graceCache.get(row.hash); // :513-523 (Redis lookup)
    if (record === undefined) return null;
    if (now > record.cachedAtMs + this._graceWindowMs) return null; // the Redis TTL surrogate
    // Direct-predecessor-of-current-head + family liveness in ONE check (:524-545): the cached
    // successor row must still be ALIVE — a further rotation (older generation) or a family
    // revocation both revoke it, so both refuse grace here.
    const successor = this._rows.get(record.successorHash);
    if (successor === undefined || successor.revokedAtMs !== null) return null; // :542
    if (successor.familyId !== row.familyId) return null; // :544-545
    if (scope) {
      const requested = new Set(scope.split(" ").filter(Boolean));
      const stored = new Set(record.scope.split(" ").filter(Boolean));
      if (requested.size !== stored.size || ![...requested].every((entry) => stored.has(entry))) {
        return null; // :548-550
      }
    }
    if (resource && stripTrailingSlash(row.resource ?? "") !== stripTrailingSlash(resource)) {
      return null; // :551-552
    }
    return record; // a grace hit performs NO writes (:396-398, :558-567)
  }

  /** Mirror of `_revoke_family` (:337-360): revoke every still-active token in the family. */
  private revokeFamily(familyId: string, now: number): void {
    for (const row of this._rows.values()) {
      if (row.familyId === familyId && row.revokedAtMs === null) {
        row.revokedAtMs = now;
      }
    }
  }
}
