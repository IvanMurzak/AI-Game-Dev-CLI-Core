import { CredentialLockBusyError, MachineCredentialLock } from "./credential-lock.js";
import {
  MachineCredentialStoreUnreadableError,
  effectiveFamilies,
  type MachineCredentials,
  type MachineCredentialStore,
  type MachineTokenFamily,
} from "./machine-credentials.js";
import type { TokenRefresher } from "./token-refresher.js";

/**
 * `MachineCredentialProvider` — **the single TypeScript entry point for machine-credential access
 * and refresh** (unified-machine-auth 02/04). The three engine CLIs (d2/e2/f2, W2) and the desktop
 * App (W3) consume credentials EXCLUSIVELY through this class; nothing else re-implements refresh.
 * It owns the family-aware machine store view, the cross-process lock, and the 04 §3 refresh rules:
 *
 *  1. **Proactive** refresh inside the expiry skew (60 s) via {@link getAccessToken}; **reactive**
 *     refresh on a hub 401 via {@link refresh}. Both run the 04 §2 critical section under the
 *     {@link MachineCredentialLock}: acquire → **re-read the store** (double-checked — a peer that
 *     already refreshed is adopted without a network call) → refresh (≤15 s) → write → release.
 *  2. The refresh request presents the **family's stored `clientId`** (04 §1/D8). The component
 *     default (`defaultClientId` option) is used ONLY when the family stores none — the
 *     `families.legacy` case (§3.7, status-quo behavior) — never over a stored id.
 *  3. `scope`/`resource` are omitted entirely (P0-3; enforced by the {@link TokenRefresher} seam,
 *     which does not even carry them).
 *  4. A rotation response missing `refresh_token` keeps the previous one.
 *  5. `invalid_grant` → the lock is released and the store re-read once more (a racer may have won
 *     legitimately — its rotation is adopted); if the family is genuinely dead: the provider marks
 *     it signed-out for this process, emits ONE structured telemetry event
 *     ({@link CredentialTelemetryEvent}), never deletes the store or any other family, and never
 *     loops.
 *  6. Rate discipline: at most one network refresh attempt per family per skew window per
 *     provider (one provider per CLI process).
 *  7. `families.legacy` refreshes with the component-default `clientId` and, on success, is
 *     written back as a v2 document's `families.legacy` (+ the v1 mirror while it is the sole
 *     plugin-plane credential) — F11.1 adoption under the lock.
 *
 * Failure honesty (04 §1 / c1 review A3): a store that turns **unreadable** during refresh is
 * busy/transient — the provider NEVER overwrites or deletes it; only an explicit re-auth flow
 * (login-commit.ts) may replace it. Lock-budget exhaustion surfaces as
 * {@link CredentialLockBusyError} ("busy — retry"), never as a lock-free refresh (D9) and never
 * as a spurious "sign in again".
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

/** The two consumable credential planes (02): CLIs/plugins use `plugin`, the App uses `agent`. */
export type CredentialPlane = "agent" | "plugin";

/** A concrete store family a refresh operates on (the `plugin` plane falls back to `legacy`). */
export type CredentialFamilyName = "agent" | "plugin" | "legacy";

/**
 * Structured telemetry event (04 §3 rule 5). Carries NO token material. Exactly one
 * `family-dead` event is emitted per family death per provider.
 */
export interface CredentialTelemetryEvent {
  type: "family-dead";
  family: CredentialFamilyName;
  /** The server error that killed the family (e.g. `invalid_grant`). Never token material. */
  reason: string;
}

export interface MachineCredentialProviderOptions {
  /** Proactive-refresh skew (ms); defaults to {@link DEFAULT_REFRESH_SKEW_MS}. */
  refreshSkewMs?: number;
  /** Injectable clock (ms since epoch); defaults to `Date.now`. For deterministic expiry tests. */
  clock?: () => number;
  /** Optional structured warning sink (never receives token material). */
  onWarning?: (message: string) => void;
  /**
   * The cross-process store lock (04 §2). Defaults to a {@link MachineCredentialLock} on the
   * store's own directory — pass one only to share an instance or to tune TEST-ONLY timings.
   */
  lock?: MachineCredentialLock;
  /**
   * The component's own OAuth client id (`unity-mcp-cli` / `unreal-mcp-cli` / `godot-cli` / the
   * App's DCR id). Used ONLY for families that store no `clientId` — `families.legacy` (§3.7) and
   * transitional enroll-minted plugin families from servers that predate a6. A **stored**
   * `clientId` always wins (04 §3 rule 2); this is never presented over one.
   */
  defaultClientId?: string;
  /** Structured telemetry sink (04 §3 rule 5); defaults to a no-op. Never receives token material. */
  onTelemetry?: (event: CredentialTelemetryEvent) => void;
}

/** Internal outcome of one family-refresh attempt. */
type RefreshOutcome =
  | { kind: "refreshed"; family: MachineTokenFamily; document: MachineCredentials | null }
  | { kind: "adopted"; family: MachineTokenFamily; document: MachineCredentials | null }
  | { kind: "invalid-grant"; reason: string; presentedRefreshToken: string }
  | { kind: "dead"; reason: string }
  | { kind: "busy"; error: CredentialLockBusyError }
  | { kind: "unreadable"; error: MachineCredentialStoreUnreadableError }
  | { kind: "failed"; reason: string };

export class MachineCredentialProvider {
  private readonly _store: MachineCredentialStore;
  private readonly _refresher: TokenRefresher;
  private readonly _skewMs: number;
  private readonly _clock: () => number;
  private readonly _onWarning: (message: string) => void;
  private readonly _lock: MachineCredentialLock;
  private readonly _defaultClientId: string | undefined;
  private readonly _onTelemetry: (event: CredentialTelemetryEvent) => void;

  /** Rate discipline (04 §3 rule 6): last network-attempt instant per family. */
  private readonly _lastAttemptAt = new Map<CredentialFamilyName, number>();
  /** Families this process observed dying (rule 5): family → {reason, the dead refresh token}. */
  private readonly _deadFamilies = new Map<
    CredentialFamilyName,
    { reason: string; refreshToken: string | undefined }
  >();
  private _lastFailureReason: string | undefined;

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
    this._lock =
      options.lock ??
      new MachineCredentialLock(store.baseDirectory, { onWarning: this._onWarning });
    this._defaultClientId = options.defaultClientId;
    this._onTelemetry = options.onTelemetry ?? (() => {});
  }

  /** The underlying store (for callers that need identity fields / sign-out). */
  get store(): MachineCredentialStore {
    return this._store;
  }

  /** The cross-process lock guarding this provider's store writes (04 §2). */
  get lock(): MachineCredentialLock {
    return this._lock;
  }

  /**
   * True when a usable (access-token-bearing) credential is present on disk for `plane`
   * (default: the plugin plane, which falls back to `families.legacy`). Never throws — an
   * unreadable store reads as signed-out here (04 §1: surface "sign in required").
   */
  isSignedIn(plane: CredentialPlane = "plugin"): boolean {
    const current = this.safeRead();
    if (!current) return false;
    return this.resolvePlane(current, plane)?.family.accessToken != null;
  }

  /**
   * Return a valid access token for `options.family` (default `plugin`; the plugin plane falls
   * back to `families.legacy` — an adopted v1 credential IS the plugin-plane credential),
   * proactively refreshing under the lock when it is within the skew window of expiry.
   *
   * Throws {@link LoginRequiredError} when signed out or when the token is expired and the family
   * is dead / the refresh failed; {@link CredentialLockBusyError} when the token is expired and
   * the lock stayed contended (retry later — NOT a sign-in problem); and
   * {@link MachineCredentialStoreUnreadableError} when the token is expired and the store is
   * unreadable (04 §1 "sign in required (store unreadable)" — the file is never touched).
   * A refresh failure while the current token is still valid returns the current token.
   */
  async getAccessToken(
    options: { family?: CredentialPlane; signal?: AbortSignal } = {},
  ): Promise<string> {
    const plane = options.family ?? "plugin";
    const current = this.readOrThrowLoginRequired();
    const resolved = current === null ? null : this.resolvePlane(current, plane);
    if (!resolved?.family.accessToken) {
      throw new LoginRequiredError("not signed in");
    }

    if (!this.shouldRefresh(resolved.family)) {
      return resolved.family.accessToken;
    }

    const outcome = await this.refreshFamily(resolved.name, resolved.family, options.signal);
    if ((outcome.kind === "refreshed" || outcome.kind === "adopted") && outcome.family.accessToken) {
      return outcome.family.accessToken;
    }

    // Refresh did not produce a token. A still-valid current token must not break the command
    // (transient hiccup, busy lock, or even a just-declared-dead family whose access token has
    // seconds left — the hub will 401 it if it was revoked, landing in the reactive path).
    if (!this.isExpired(resolved.family)) {
      return resolved.family.accessToken;
    }
    throw this.failureToError(outcome);
  }

  /**
   * Reactively refresh now (driven by a hub 401) for `options.family` (default `plugin`).
   * Returns the machine-store document holding the rotated family on success; throws
   * {@link LoginRequiredError} when refresh is impossible or the family is dead (expiry /
   * family-revoke), {@link CredentialLockBusyError} on a contended lock (retry later), and
   * {@link MachineCredentialStoreUnreadableError} on an unreadable store.
   */
  async refresh(
    options: { family?: CredentialPlane; signal?: AbortSignal } = {},
  ): Promise<MachineCredentials> {
    const plane = options.family ?? "plugin";
    const current = this.readOrThrowLoginRequired();
    const resolved = current === null ? null : this.resolvePlane(current, plane);
    if (current === null || !resolved?.family.refreshToken) {
      throw new LoginRequiredError("no refresh token");
    }

    const outcome = await this.refreshFamily(resolved.name, resolved.family, options.signal);
    if (outcome.kind === "refreshed" || outcome.kind === "adopted") {
      return outcome.document ?? this.inMemoryDocument(current, resolved.name, outcome.family);
    }
    throw this.failureToError(outcome);
  }

  // ── refresh machinery ─────────────────────────────────────────────────────────────────────────

  /**
   * One full family-refresh attempt: dead-family memo → rate discipline → lock → critical section
   * (re-read → decide → network → write) → post-failure re-read for `invalid_grant` (F3.5).
   */
  private async refreshFamily(
    name: CredentialFamilyName,
    snapshot: MachineTokenFamily,
    signal?: AbortSignal,
  ): Promise<RefreshOutcome> {
    // Rule 5, "never loop": a family this process saw die stays dead — unless the credential was
    // replaced since (a fresh login by another surface), which re-arms the family.
    const dead = this._deadFamilies.get(name);
    if (dead !== undefined) {
      if (dead.refreshToken === snapshot.refreshToken) {
        return { kind: "dead", reason: dead.reason };
      }
      this._deadFamilies.delete(name);
    }

    // Rule 6: at most one network attempt per family per skew window per provider/process.
    const last = this._lastAttemptAt.get(name);
    if (last !== undefined && this._clock() - last < this._skewMs) {
      return {
        kind: "failed",
        reason:
          this._lastFailureReason ??
          "refresh already attempted for this family within the current skew window",
      };
    }

    let outcome: RefreshOutcome;
    try {
      outcome = await this._lock.withLock(() => this.criticalSection(name, snapshot, signal));
    } catch (err) {
      if (err instanceof CredentialLockBusyError) {
        this._onWarning(
          `Credential refresh is busy (${name} family): another process holds the store lock; retry later.`,
        );
        return { kind: "busy", error: err };
      }
      throw err;
    }

    if (outcome.kind !== "invalid-grant") {
      return outcome;
    }

    // F3.5: lock released — re-read ONCE more; a racer (an old, non-lock-honoring client) may
    // have rotated legitimately while our doomed request was in flight.
    const reRead = this.safeReadState();
    if (reRead?.status === "ok") {
      const family = effectiveFamilies(reRead.credentials)[name];
      if (
        family?.refreshToken !== undefined &&
        family.refreshToken !== outcome.presentedRefreshToken
      ) {
        return { kind: "adopted", family, document: reRead.credentials };
      }
    }

    // Genuinely dead: mark signed-out for this process, ONE telemetry event, never delete
    // anything (another family in the file may still be alive), never loop.
    this.markFamilyDead(name, outcome.reason, outcome.presentedRefreshToken);
    return { kind: "dead", reason: outcome.reason };
  }

  /**
   * The 04 §2 critical section, entered ONLY while holding the lock: re-read store → decide
   * (adopt a peer's refresh without a network call when possible) → network refresh presenting
   * the stored `clientId` → write the rotated family (same lock hold — c1 review A1).
   */
  private async criticalSection(
    name: CredentialFamilyName,
    snapshot: MachineTokenFamily,
    signal?: AbortSignal,
  ): Promise<RefreshOutcome> {
    const state = this.safeReadState();
    if (state === null) {
      return { kind: "failed", reason: "reading the machine credential store failed" };
    }
    if (state.status === "unreadable") {
      // c1 review A3: unreadable mid-refresh is busy/transient — NEVER a signal to overwrite.
      return {
        kind: "unreadable",
        error: new MachineCredentialStoreUnreadableError(state.reason, state.cause),
      };
    }
    const document = state.status === "ok" ? state.credentials : null;
    const family = document === null ? undefined : effectiveFamilies(document)[name];

    // Double-checked refresh: adopt a PEER's rotation observed on the under-lock re-read. The
    // re-read family must actually DIFFER from our snapshot — re-adopting the very token the
    // caller just saw fail (a reactive 401) would bounce the same rejected token back to the hub.
    if (family?.accessToken && family.accessToken !== snapshot.accessToken) {
      if (!this.shouldRefresh(family) || this.parseExpiry(family.expiresAt) === null) {
        // Fresh beyond the skew — or rotated with unknown expiry (recover reactively if needed).
        return { kind: "adopted", family, document };
      }
    }

    const refreshToken = family?.refreshToken;
    if (family === undefined || refreshToken === undefined || refreshToken === "") {
      this._lastFailureReason = "no refresh token";
      return { kind: "failed", reason: "no refresh token" };
    }

    // 04 §3 rule 2: the family's STORED clientId — the component default is only the §3.7
    // fallback for families that store none (legacy / pre-a6 enroll), never an override.
    const storedClientId =
      typeof family.clientId === "string" && family.clientId.trim() ? family.clientId.trim() : undefined;
    const clientId = storedClientId ?? this._defaultClientId;
    if (!clientId) {
      this._lastFailureReason = "no client id available for refresh";
      return {
        kind: "failed",
        reason:
          "no client id available for refresh (the family stores none and no component default is configured)",
      };
    }

    this._lastAttemptAt.set(name, this._clock());
    let result;
    try {
      result = await this._refresher.refresh({
        refreshToken,
        clientId,
        serverTarget: document?.serverTarget,
        signal,
      });
    } catch (err) {
      // Defensive: a well-behaved refresher fails closed, but never let a throw corrupt anything.
      this._lastFailureReason = err instanceof Error ? err.message : String(err);
      this._onWarning(`Token refresh error (${this._lastFailureReason}).`);
      return { kind: "failed", reason: this._lastFailureReason };
    }

    if (!result.ok || !result.accessToken) {
      const reason = result.ok ? "empty access token" : result.reason;
      this._lastFailureReason = reason;
      if (!result.ok && reason === "invalid_grant") {
        return { kind: "invalid-grant", reason, presentedRefreshToken: refreshToken };
      }
      this._onWarning(`Account credential refresh failed (${reason}).`);
      return { kind: "failed", reason };
    }

    // Rule 4: preserve the previous refresh token when the server did not rotate one.
    const rotated: MachineTokenFamily = {
      ...family,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? refreshToken,
      expiresAt: result.expiresAt,
    };

    try {
      // Same lock hold (c1 review A1): the read-modify-write cycle is entirely inside the lock.
      // For `legacy` this rewrites a v1 document as v2 `families.legacy` (+ mirror while it is
      // the sole plugin-plane credential) — §3.7 / F11.1.
      const written = this._store.writeFamily(name, rotated);
      return { kind: "refreshed", family: rotated, document: written };
    } catch (err) {
      if (err instanceof MachineCredentialStoreUnreadableError) {
        // A3: something corrupted the store under us (a non-lock-honoring writer) — never
        // overwrite it. Keep the fresh token in memory so the command can proceed.
        this._onWarning(
          "Persisting the refreshed credential was skipped: the store became unreadable (never overwritten); using the in-memory token.",
        );
        return { kind: "refreshed", family: rotated, document: null };
      }
      // Disk-write failure: the atomic write left any existing good file intact. The command
      // can proceed on the in-memory token.
      this._onWarning(
        `Persisting refreshed credential failed (${err instanceof Error ? err.message : String(err)}); using in-memory token.`,
      );
      return { kind: "refreshed", family: rotated, document: null };
    }
  }

  /** Mark a family dead (rule 5): memoized, exactly ONE structured telemetry event, one warning. */
  private markFamilyDead(
    name: CredentialFamilyName,
    reason: string,
    refreshToken: string | undefined,
  ): void {
    if (this._deadFamilies.has(name)) {
      return;
    }
    this._deadFamilies.set(name, { reason, refreshToken });
    this._onTelemetry({ type: "family-dead", family: name, reason });
    this._onWarning(
      `Account credential family '${name}' is no longer valid (${reason}); sign-in required. Other families are untouched.`,
    );
  }

  private failureToError(outcome: RefreshOutcome): Error {
    switch (outcome.kind) {
      case "busy":
        return outcome.error;
      case "unreadable":
        return outcome.error;
      case "dead":
        return new LoginRequiredError(outcome.reason);
      case "failed":
        return new LoginRequiredError(outcome.reason);
      default:
        return new LoginRequiredError(this._lastFailureReason);
    }
  }

  // ── store access / family resolution ─────────────────────────────────────────────────────────

  /** Resolve the concrete family serving `plane` (plugin → `plugin` then `legacy`; agent → `agent`). */
  private resolvePlane(
    credentials: MachineCredentials,
    plane: CredentialPlane,
  ): { name: CredentialFamilyName; family: MachineTokenFamily } | null {
    const families = effectiveFamilies(credentials);
    if (plane === "agent") {
      return families.agent ? { name: "agent", family: families.agent } : null;
    }
    if (families.plugin) {
      return { name: "plugin", family: families.plugin };
    }
    if (families.legacy) {
      return { name: "legacy", family: families.legacy };
    }
    return null;
  }

  /** Read for the entry points: unreadable → distinct "sign in required (store unreadable)". */
  private readOrThrowLoginRequired(): MachineCredentials | null {
    const state = this.safeReadState();
    if (state === null) {
      throw new LoginRequiredError("reading the machine credential store failed");
    }
    if (state.status === "unreadable") {
      // 04 §1: a distinct signed-out state; the file is NEVER deleted or overwritten here.
      this._onWarning(`Machine credential store is unreadable: ${state.reason}`);
      throw new LoginRequiredError(`machine credential store unreadable (${state.reason})`);
    }
    return state.status === "ok" ? state.credentials : null;
  }

  private safeRead(): MachineCredentials | null {
    const state = this.safeReadState();
    return state?.status === "ok" ? state.credentials : null;
  }

  private safeReadState(): ReturnType<MachineCredentialStore["readState"]> | null {
    try {
      return this._store.readState();
    } catch (err) {
      this._onWarning(
        `Reading the machine credential store failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Build the in-memory fallback document when a rotated family could not be persisted. */
  private inMemoryDocument(
    current: MachineCredentials,
    name: CredentialFamilyName,
    family: MachineTokenFamily,
  ): MachineCredentials {
    return {
      ...current,
      families: { ...effectiveFamilies(current), [name]: family },
    };
  }

  // ── expiry math ───────────────────────────────────────────────────────────────────────────────

  private shouldRefresh(family: MachineTokenFamily): boolean {
    const expiresAtMs = this.parseExpiry(family.expiresAt);
    // Unknown expiry — recover reactively on server rejection instead of guessing.
    if (expiresAtMs == null) return false;
    return expiresAtMs - this._clock() <= this._skewMs;
  }

  private isExpired(family: MachineTokenFamily): boolean {
    const expiresAtMs = this.parseExpiry(family.expiresAt);
    if (expiresAtMs == null) return false;
    return expiresAtMs <= this._clock();
  }

  private parseExpiry(expiresAt: string | undefined): number | null {
    if (!expiresAt) return null;
    const ms = Date.parse(expiresAt);
    return Number.isNaN(ms) ? null : ms;
  }
}
