import type { MachineCredentials, MachineCredentialStore } from "./machine-credentials.js";
import type { TokenRefresher } from "./token-refresher.js";

/**
 * The CLI-side account credential provider — the TypeScript port of the plugin's C#
 * `PluginCredentialProvider` proactive/reactive refresh loop (auth-fixes design 03 Flow B / 06),
 * adapted to a short-lived CLI process. It owns the machine-store-backed credential and is the
 * source of the access token a cloud command presents. Two behaviours:
 *
 *   - **Proactive refresh:** {@link getAccessToken} refreshes the token before its expiry (within a
 *     skew window) so a valid JWT is always presented. A proactive refresh that fails while the
 *     current token is still valid returns the current token (don't break the user for a transient
 *     hiccup); if the token is already expired it raises {@link LoginRequiredError}.
 *   - **Reactive refresh:** {@link refresh} (driven by a hub 401) mints a new token and rotates the
 *     store. A refresh-token expiry or a family-revoke (rotation-reuse detection) surfaces here as a
 *     failed refresh, which becomes a clean {@link LoginRequiredError} — the CLI's `login required`.
 *
 * The token-endpoint HTTP exchange is delegated to an injected {@link TokenRefresher}; this class
 * never talks to the network directly and never logs token material. It also never mints a PAT.
 */

/**
 * Raised when the CLI has no usable credential and the user must sign in again — an expired/revoked
 * refresh family, a missing credential, or an unrecoverable refresh failure. Adapters translate this
 * into the user-facing `login required` message.
 */
export class LoginRequiredError extends Error {
  constructor(reason?: string) {
    super(reason && reason.trim() ? `login required: ${reason}` : "login required");
    this.name = "LoginRequiredError";
  }
}

/** Default proactive-refresh skew: refresh once the token is within 60s of expiry. */
export const DEFAULT_REFRESH_SKEW_MS = 60_000;

export interface MachineCredentialProviderOptions {
  /** Proactive-refresh skew (ms); defaults to {@link DEFAULT_REFRESH_SKEW_MS}. */
  refreshSkewMs?: number;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. For deterministic expiry tests. */
  clock?: () => number;
  /** Optional structured warning sink (never receives token material). */
  onWarning?: (message: string) => void;
}

export class MachineCredentialProvider {
  private readonly _store: MachineCredentialStore;
  private readonly _refresher: TokenRefresher;
  private readonly _skewMs: number;
  private readonly _clock: () => number;
  private readonly _onWarning: (message: string) => void;

  constructor(
    store: MachineCredentialStore,
    refresher: TokenRefresher,
    options: MachineCredentialProviderOptions = {},
  ) {
    this._store = store;
    this._refresher = refresher;
    this._skewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this._clock = options.clock ?? Date.now;
    this._onWarning = options.onWarning ?? (() => {});
  }

  /** The underlying store (for callers that need identity fields / sign-out). */
  get store(): MachineCredentialStore {
    return this._store;
  }

  /** True when a usable (access-token-bearing) credential is present on disk. */
  isSignedIn(): boolean {
    return this.safeRead()?.accessToken != null;
  }

  /**
   * Return a valid access token, proactively refreshing first when it is within the skew window of
   * expiry. Throws {@link LoginRequiredError} when signed out, or when the token is expired and
   * cannot be refreshed. A proactive refresh that fails while the token is still valid returns the
   * current token.
   */
  async getAccessToken(options: { signal?: AbortSignal } = {}): Promise<string> {
    const current = this.safeRead();
    if (!current?.accessToken) {
      throw new LoginRequiredError("not signed in");
    }

    if (!this.shouldRefresh(current)) {
      return current.accessToken;
    }

    const refreshed = await this.tryRefresh(current, options.signal);
    if (refreshed?.accessToken) {
      return refreshed.accessToken;
    }

    // Refresh failed. If the current token has already expired it is useless → login required.
    if (this.isExpired(current)) {
      throw new LoginRequiredError(this._lastFailureReason);
    }
    // Still valid — a transient proactive-refresh failure must not break the command.
    return current.accessToken;
  }

  /**
   * Reactively refresh now (driven by a hub 401). Returns the rotated credentials on success;
   * throws {@link LoginRequiredError} when refresh is impossible or the server rejected it
   * (expiry / family-revoke).
   */
  async refresh(options: { signal?: AbortSignal } = {}): Promise<MachineCredentials> {
    const current = this.safeRead();
    if (!current?.refreshToken) {
      throw new LoginRequiredError("no refresh token");
    }
    const refreshed = await this.tryRefresh(current, options.signal);
    if (!refreshed?.accessToken) {
      throw new LoginRequiredError(this._lastFailureReason);
    }
    return refreshed;
  }

  private _lastFailureReason: string | undefined;

  /**
   * Perform one refresh + rotate. Returns the rotated credentials, or null on failure (with the
   * reason stashed in {@link _lastFailureReason}). NEVER touches the store on failure — the refresh
   * HTTP exchange happens first and the store is only written on success (design 03 F4).
   */
  private async tryRefresh(
    current: MachineCredentials,
    signal?: AbortSignal,
  ): Promise<MachineCredentials | null> {
    this._lastFailureReason = undefined;

    if (!current.refreshToken) {
      this._lastFailureReason = "no refresh token";
      return null;
    }

    let result;
    try {
      result = await this._refresher.refresh(current.refreshToken, current.serverTarget, signal);
    } catch (err) {
      // Defensive: a well-behaved refresher fails closed, but never let a throw corrupt anything.
      this._lastFailureReason = err instanceof Error ? err.message : String(err);
      this._onWarning(`Token refresh error (${this._lastFailureReason}); sign-in required.`);
      return null;
    }

    if (!result.ok || !result.accessToken) {
      this._lastFailureReason = result.ok ? "empty access token" : result.reason;
      this._onWarning(`Account credential refresh failed (${this._lastFailureReason}); sign-in required.`);
      return null;
    }

    // Preserve the previous refresh token when the server did not rotate one (matches C#).
    const refreshToken = result.refreshToken ?? current.refreshToken;

    try {
      // rotate() preserves serverTarget / subject / unknown fields and writes atomically.
      return this._store.rotate(result.accessToken, refreshToken, result.expiresAt);
    } catch (err) {
      // Keep the refreshed token in memory even if the disk write failed — the command can proceed.
      // The atomic write leaves any existing good file intact on failure (design 03 F4).
      this._onWarning(
        `Persisting refreshed credential failed (${err instanceof Error ? err.message : String(err)}); using in-memory token.`,
      );
      return {
        ...current,
        accessToken: result.accessToken,
        refreshToken,
        expiresAt: result.expiresAt,
      };
    }
  }

  private shouldRefresh(credentials: MachineCredentials): boolean {
    const expiresAtMs = this.parseExpiry(credentials.expiresAt);
    // Unknown expiry — recover reactively on server rejection instead of guessing.
    if (expiresAtMs == null) return false;
    return expiresAtMs - this._clock() <= this._skewMs;
  }

  private isExpired(credentials: MachineCredentials): boolean {
    const expiresAtMs = this.parseExpiry(credentials.expiresAt);
    if (expiresAtMs == null) return false;
    return expiresAtMs <= this._clock();
  }

  private parseExpiry(expiresAt: string | undefined): number | null {
    if (!expiresAt) return null;
    const ms = Date.parse(expiresAt);
    return Number.isNaN(ms) ? null : ms;
  }

  private safeRead(): MachineCredentials | null {
    try {
      return this._store.read();
    } catch (err) {
      this._onWarning(`Reading the machine credential store failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
