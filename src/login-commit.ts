import { MachineCredentialLock } from "./credential-lock.js";
import {
  MachineCredentialStoreUnreadableError,
  applyV1CompatMirror,
  documentSchemaVersion,
  effectiveFamilies,
  type MachineCredentials,
  type MachineCredentialStore,
  type MachineTokenFamily,
} from "./machine-credentials.js";
import { DEFAULT_PLUGIN_SCOPE, MCP_AGENT_SCOPE } from "./oauth-device-flow.js";
import { normalizeServerBase } from "./token-refresher.js";
import type { TokenExchangeClient } from "./token-exchange.js";

/**
 * Login-surface commit plumbing (unified-machine-auth 03 F1/F2/F6/F7/F10, 04 §4) — the shared
 * machinery every TypeScript login surface (the three CLIs, the App) uses to turn a successful
 * mint into machine-store state. Owns three invariants no surface may re-implement:
 *
 *  - **The two-lock-hold commit sequence (F1.3/F1.4):** commit the agent family under a FIRST
 *    lock hold, perform the RFC 8693 token exchange with the lock RELEASED, then write the
 *    derived plugin family (+ v1 mirror) under a SECOND hold. Two holds by design: a failed
 *    exchange leaves a valid, committed agent family and the surface reports
 *    "partially authorized, retrying" ({@link CommitAgentLoginResult} `partial`) — it retries
 *    the derivation alone via {@link derivePluginFamily}.
 *  - **The account-switch guard (D6/F7):** before ANY write, the new mint's `subject` is compared
 *    with the store's. A mismatch requires explicit confirmation; **decline revokes the
 *    just-minted family (best effort, RFC 7009) and aborts with the store untouched** — no orphan
 *    device row. Confirm revokes the old account's families (best effort) and REPLACES the store
 *    (single-account store, D6). Missing subjects (pre-O5 servers) compare as "proceed" — F7.3.
 *  - **Tools-only mode (O10/F10, `--tools-only`):** {@link commitToolsOnlyLogin} commits a
 *    `scope=mcp:plugin` mint as a plugin family ONLY — the store then holds no agent family, so
 *    App pickup is impossible by design and the runner appears as its own revocable device group.
 *
 * Plus the machine-wide sign-out ({@link signOutMachineWide}, F6/D5) and the RFC 7009 revocation
 * seam ({@link revokeTokenBestEffort}). Nothing here logs token material.
 */

/** Path (relative to the AS root) of the RFC 7009 token-revocation endpoint. */
export const OAUTH_REVOCATION_PATH = "/oauth/revoke";

/** Absolute revocation URL for an AS root. */
export function revocationUrl(serverBaseUrl: string): string {
  return `${serverBaseUrl.replace(/\/+$/, "")}${OAUTH_REVOCATION_PATH}`;
}

/** Options for {@link revokeTokenBestEffort}. */
export interface RevokeTokenOptions {
  /** The credential's server target (AS root or `/mcp` hub URL — normalized before use). */
  serverTarget: string;
  /** The token to revoke (revoking a refresh token revokes its whole family server-side). */
  token: string;
  /** The client id to present — the family's stored id, or the component default (F6.2). */
  clientId: string;
  /** RFC 7009 §2.1 hint. Defaults to `refresh_token`. */
  tokenTypeHint?: "refresh_token" | "access_token";
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request network timeout (ms). Default 15s. */
  timeoutMs?: number;
}

/**
 * RFC 7009 revocation, best effort: POSTs `token` + `token_type_hint` + `client_id` to
 * `{AS root}/oauth/revoke`. Returns true on an HTTP 2xx (the RFC returns 200 even for invalid
 * tokens) and false on ANY failure — it never throws (offline sign-out must proceed, F6.4).
 */
export async function revokeTokenBestEffort(options: RevokeTokenOptions): Promise<boolean> {
  const base = normalizeServerBase(options.serverTarget);
  if (!base || !options.token || !options.clientId) {
    return false;
  }
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await doFetch(revocationUrl(base), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: options.token,
        token_type_hint: options.tokenTypeHint ?? "refresh_token",
        client_id: options.clientId,
      }).toString(),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── account-switch guard (D6/F7) ────────────────────────────────────────────────────────────────

/** The guard's verdict: write may proceed, or the surface must confirm the account switch. */
export type AccountSwitchDecision =
  | { kind: "proceed" }
  | { kind: "confirm-required"; storedSubject: string; newSubject: string };

/**
 * The D6/F7 account-switch guard primitive: compare the new mint's `subject` against the stored
 * document's BEFORE any write. Only a genuine mismatch of two KNOWN subjects requires
 * confirmation — when either side is unknown (subject-less v1 / pre-O5 enroll credentials, or an
 * unreadable/missing store) the guard cannot judge and the write proceeds (F7.3: the guard
 * becomes fully effective once every mint path carries `sub`).
 */
export function evaluateAccountSwitch(
  stored: MachineCredentials | null,
  newSubject: string | undefined,
): AccountSwitchDecision {
  const storedSubject =
    typeof stored?.subject === "string" && stored.subject.length > 0 ? stored.subject : undefined;
  if (!storedSubject || !newSubject || storedSubject === newSubject) {
    return { kind: "proceed" };
  }
  return { kind: "confirm-required", storedSubject, newSubject };
}

/** Best-effort revocation seam used by the commit/sign-out flows (injectable for tests/surfaces). */
export type RevokeTokenFn = (
  token: string,
  clientId: string,
  tokenTypeHint: "refresh_token" | "access_token",
) => boolean | Promise<boolean>;

/** Options for {@link runAccountSwitchGuard} — the shared D6/F7 guard runner for login surfaces. */
export interface AccountSwitchGuardOptions {
  store: MachineCredentialStore;
  /** The client id presented when revoking the JUST-MINTED family on decline. */
  clientId: string;
  /** The freshly minted credentials being committed (subject compared; tokens revoked on decline). */
  credentials: MachineCredentials;
  confirmAccountSwitch?:
    | ((info: { storedSubject: string; newSubject: string }) => boolean | Promise<boolean>)
    | undefined;
  revokeToken?: RevokeTokenFn | undefined;
  fetchImpl?: typeof fetch | undefined;
  onWarning?: ((message: string) => void) | undefined;
}

/**
 * The guard's outcome. `premiseSubject` is the stored subject the decision was based on —
 * {@link commitFamilyUnderHold} RE-VERIFIES it under the lock before writing (review fix B2b:
 * the guard evaluates on a lock-free read and the confirm dialog can wait unbounded, so the
 * premise must still hold at write time).
 */
export type AccountSwitchGuardOutcome =
  | { kind: "proceed"; confirmedSwitch: boolean; premiseSubject: string | undefined }
  | { kind: "declined"; storedSubject: string; newSubject: string };

function nonEmptySubject(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Run the D6/F7 guard including the decline path (revoke just-minted, abort, store untouched)
 * and — on a CONFIRMED switch — the best-effort revocation of the old account's families.
 * Shared by every login surface commit path (agent login, tools-only login, enroll).
 */
export async function runAccountSwitchGuard(
  options: AccountSwitchGuardOptions,
): Promise<AccountSwitchGuardOutcome> {
  const { store, credentials } = options;
  const state = safeReadState(store);
  const stored = state?.status === "ok" ? state.credentials : null;
  const premiseSubject = nonEmptySubject(stored?.subject);
  const decision = evaluateAccountSwitch(stored, credentials.subject);
  if (decision.kind === "proceed") {
    return { kind: "proceed", confirmedSwitch: false, premiseSubject };
  }

  const confirmed =
    options.confirmAccountSwitch === undefined
      ? false // fail closed: an unconfirmable switch is a declined switch (CLI: `--yes`-gated)
      : await options.confirmAccountSwitch({
          storedSubject: decision.storedSubject,
          newSubject: decision.newSubject,
        });

  const revoke = resolveRevoker(options);
  if (!confirmed) {
    // F7.2 decline: revoke the JUST-MINTED family (best effort) and abort; F untouched.
    const minted = credentials.refreshToken ?? credentials.accessToken;
    if (minted) {
      await tryRevoke(revoke, minted, options.clientId, credentials.refreshToken ? "refresh_token" : "access_token", options.onWarning);
    }
    return { kind: "declined", storedSubject: decision.storedSubject, newSubject: decision.newSubject };
  }

  // F7.2 confirm: revoke the OLD account's families (best effort) before the store is replaced.
  if (stored) {
    for (const [, family] of Object.entries(effectiveFamilies(stored))) {
      const token = family?.refreshToken;
      if (!token) continue;
      const familyClientId =
        typeof family.clientId === "string" && family.clientId ? family.clientId : options.clientId;
      await tryRevoke(revoke, token, familyClientId, "refresh_token", options.onWarning);
    }
  }
  return { kind: "proceed", confirmedSwitch: true, premiseSubject };
}

function resolveRevoker(options: {
  revokeToken?: RevokeTokenFn | undefined;
  credentials?: MachineCredentials;
  serverTarget?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): RevokeTokenFn {
  if (options.revokeToken) {
    return options.revokeToken;
  }
  const serverTarget = options.serverTarget ?? options.credentials?.serverTarget;
  return (token, clientId, tokenTypeHint) =>
    serverTarget
      ? revokeTokenBestEffort({
          serverTarget,
          token,
          clientId,
          tokenTypeHint,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        })
      : false;
}

async function tryRevoke(
  revoke: RevokeTokenFn,
  token: string,
  clientId: string,
  tokenTypeHint: "refresh_token" | "access_token",
  onWarning?: (message: string) => void,
): Promise<boolean> {
  try {
    const ok = await revoke(token, clientId, tokenTypeHint);
    if (!ok) onWarning?.("Best-effort token revocation did not succeed (continuing).");
    return ok;
  } catch {
    onWarning?.("Best-effort token revocation failed (continuing).");
    return false;
  }
}

// ── family builders ─────────────────────────────────────────────────────────────────────────────

function tokenFamily(
  credentials: Pick<MachineCredentials, "accessToken" | "refreshToken" | "expiresAt">,
  clientId: string,
  scope: string,
): MachineTokenFamily {
  return {
    accessToken: credentials.accessToken,
    ...(credentials.refreshToken !== undefined ? { refreshToken: credentials.refreshToken } : {}),
    ...(credentials.expiresAt !== undefined ? { expiresAt: credentials.expiresAt } : {}),
    clientId,
    scope,
  };
}

/** Write a FRESH single-family v2 document (confirmed account switch: the store is replaced). */
function writeFreshDocument(
  store: MachineCredentialStore,
  name: "agent" | "plugin",
  family: MachineTokenFamily,
  serverTarget: string | undefined,
  subject: string | undefined,
): MachineCredentials {
  const document: MachineCredentials = {
    ...(serverTarget !== undefined ? { serverTarget } : {}),
    ...(subject !== undefined ? { subject } : {}),
    families: { [name]: family },
  };
  store.write(document);
  return applyV1CompatMirror({ ...document, version: documentSchemaVersion(document) });
}

function safeReadState(store: MachineCredentialStore): ReturnType<MachineCredentialStore["readState"]> | null {
  try {
    return store.readState();
  } catch {
    return null;
  }
}

/**
 * Why a commit path aborted without writing (review fix B2):
 *  - `guard-premise-changed` — the store's subject changed between the lock-free guard
 *    evaluation (or the confirm dialog) and the write hold; re-run the commit so the guard
 *    re-evaluates against the CURRENT store.
 *  - `subject-changed` — a confirmed account switch landed between the two commit holds; the
 *    derived family belongs to the OLD account and was not written.
 *  - `store-missing` — a machine-wide sign-out (F6) landed between the holds; the store is
 *    deliberately NOT recreated (a signed-out machine stays signed out).
 *  - `store-unreadable` — the store turned unreadable at the write hold; it is never overwritten
 *    by this path (04 §1) and the condition surfaces as a result, not a throw.
 */
export type CommitAbortReason =
  | "guard-premise-changed"
  | "subject-changed"
  | "store-missing"
  | "store-unreadable";

/** Parameters of {@link commitFamilyUnderHold} — one guarded family write under ONE lock hold. */
export interface FamilyCommitParams {
  store: MachineCredentialStore;
  lock: MachineCredentialLock;
  name: "agent" | "plugin";
  family: MachineTokenFamily;
  serverTarget?: string | undefined;
  subject?: string | undefined;
  /** The {@link runAccountSwitchGuard} proceed outcome whose premise is re-verified under the hold. */
  guard: { confirmedSwitch: boolean; premiseSubject: string | undefined };
}

/** Outcome of {@link commitFamilyUnderHold}: written, or the guard premise no longer held. */
export type FamilyCommitOutcome =
  | { committed: true; document: MachineCredentials }
  | { committed: false; reason: "guard-premise-changed" };

/**
 * Write one family under ONE lock hold, RE-VERIFYING the account-switch guard's premise inside
 * the hold before touching the store (review fix B2b — the guard evaluated on a lock-free read,
 * and a confirm dialog may have waited unbounded):
 *
 *  - confirmed switch: the store's subject must still equal the premise the user confirmed
 *    replacing; anything else (a concurrent login as a third account, a sign-out, an unreadable
 *    store) aborts — the confirmation described a state that no longer exists.
 *  - plain path: the guard is re-evaluated against the CURRENT store; a mismatch that appeared
 *    since the lock-free read aborts (the confirm dialog cannot run under the lock). The
 *    explicit-login `replaceUnreadable` semantic is preserved (04 §1).
 *
 * On `committed: false` the caller returns `guard-premise-changed` and the surface re-runs its
 * commit — the guard then re-evaluates against the new store state.
 */
export async function commitFamilyUnderHold(params: FamilyCommitParams): Promise<FamilyCommitOutcome> {
  return params.lock.withLock((): FamilyCommitOutcome => {
    const state = safeReadState(params.store);
    const stored = state?.status === "ok" ? state.credentials : null;
    if (params.guard.confirmedSwitch) {
      // The user confirmed replacing EXACTLY `premiseSubject`; replace only that store.
      if (nonEmptySubject(stored?.subject) !== params.guard.premiseSubject) {
        return { committed: false, reason: "guard-premise-changed" };
      }
      return {
        committed: true,
        document: writeFreshDocument(
          params.store,
          params.name,
          params.family,
          params.serverTarget,
          params.subject,
        ),
      };
    }
    // Plain path: a mismatch appearing since the lock-free evaluation voids the premise.
    if (evaluateAccountSwitch(stored, params.subject).kind !== "proceed") {
      return { committed: false, reason: "guard-premise-changed" };
    }
    return {
      committed: true,
      document: params.store.writeFamily(params.name, params.family, {
        ...(params.serverTarget !== undefined ? { serverTarget: params.serverTarget } : {}),
        ...(params.subject !== undefined ? { subject: params.subject } : {}),
        replaceUnreadable: true, // explicit re-authorization owns the store (04 §1)
      }),
    };
  });
}

// ── agent login commit (F1/F2) ──────────────────────────────────────────────────────────────────

export interface CommitAgentLoginOptions {
  store: MachineCredentialStore;
  /** The 04 §2 lock; defaults to one on the store's own directory. */
  lock?: MachineCredentialLock;
  /** The RFC 8693 exchange client used to derive the plugin family (04 §4). */
  exchangeClient: TokenExchangeClient;
  /** The login surface's OWN OAuth client id — stamped onto BOTH families (D8/O2). */
  clientId: string;
  /**
   * The agent-plane mint result from `deviceLogin`/`authCodeLogin` (scope `mcp:agent`): access +
   * refresh tokens, expiry, `serverTarget`, and `subject` (from the JWT `sub`).
   */
  credentials: MachineCredentials;
  /** D6/F7 confirmation callback. ABSENT ⇒ a subject mismatch is DECLINED (fail closed). */
  confirmAccountSwitch?: (info: {
    storedSubject: string;
    newSubject: string;
  }) => boolean | Promise<boolean>;
  /** Injectable best-effort revoker; defaults to RFC 7009 against the credential's serverTarget. */
  revokeToken?: RevokeTokenFn;
  /** Injectable `fetch` for the default revoker (tests). */
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}

export type CommitAgentLoginResult =
  /** Agent family committed AND plugin family derived + mirrored — the machine is fully signed in. */
  | { status: "committed"; document: MachineCredentials }
  /**
   * F1 failure path: the agent family IS committed, but the exchange failed — the surface shows
   * "partially authorized, retrying" and retries {@link derivePluginFamily} with backoff.
   */
  | { status: "partial"; document: MachineCredentials; exchangeFailure: string }
  /** D6/F7 decline: the just-minted family was revoked (best effort); the store is untouched. */
  | { status: "switch-declined"; storedSubject: string; newSubject: string }
  /** Review fix B2: a concurrent store change voided the commit — see {@link CommitAbortReason}. */
  | { status: "aborted"; reason: CommitAbortReason; detail?: string };

/**
 * Commit an agent-plane login (03 F1.3–F1.4 / F2.2): D6 guard → agent family under the FIRST
 * lock hold → RFC 8693 exchange (lock released) → plugin family + v1 mirror under the SECOND
 * hold. On a confirmed account switch the store is REPLACED (old families revoked best-effort);
 * otherwise the agent family is merged in, `replaceUnreadable` — an explicit login owns the
 * store (04 §1).
 */
export async function commitAgentLogin(
  options: CommitAgentLoginOptions,
): Promise<CommitAgentLoginResult> {
  const { store, credentials } = options;
  if (!credentials.accessToken) {
    throw new Error("agent credentials carry no access token");
  }
  const lock = options.lock ?? new MachineCredentialLock(store.baseDirectory);

  const guard = await runAccountSwitchGuard({ ...options, revokeToken: options.revokeToken });
  if (guard.kind === "declined") {
    return {
      status: "switch-declined",
      storedSubject: guard.storedSubject,
      newSubject: guard.newSubject,
    };
  }

  const agentFamily = tokenFamily(credentials, options.clientId, MCP_AGENT_SCOPE);
  const serverTarget = credentials.serverTarget;
  const subject = credentials.subject;

  // FIRST lock hold (F1.3): the agent family is committed before the exchange is attempted, so a
  // failed exchange still leaves the machine's root of trust on disk. The guard's premise is
  // re-verified INSIDE the hold (review fix B2b) — the confirm dialog may have waited unbounded.
  const hold1 = await commitFamilyUnderHold({
    store,
    lock,
    name: "agent",
    family: agentFamily,
    serverTarget,
    subject,
    guard,
  });
  if (!hold1.committed) {
    options.onWarning?.(
      "Login commit aborted: the machine's stored account changed while the sign-in was being confirmed; retry to re-evaluate.",
    );
    return { status: "aborted", reason: "guard-premise-changed" };
  }

  // Exchange + SECOND hold (F1.4) — deliberately outside the first hold.
  const derived = await derivePluginFamily({
    store,
    lock,
    exchangeClient: options.exchangeClient,
    clientId: options.clientId,
    agentAccessToken: credentials.accessToken,
    ...(subject !== undefined ? { expectedSubject: subject } : {}),
    ...(serverTarget !== undefined ? { serverTarget } : {}),
    ...(options.revokeToken ? { revokeToken: options.revokeToken } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (derived.status === "derived") {
    return { status: "committed", document: derived.document };
  }
  if (derived.status === "aborted") {
    // The hold-2 re-verification refused the write (subject changed / store gone / unreadable).
    return {
      status: "aborted",
      reason: derived.reason,
      ...(derived.detail !== undefined ? { detail: derived.detail } : {}),
    };
  }
  options.onWarning?.(
    `Token exchange failed (${derived.reason}) — partially authorized; the agent family is committed and the plugin derivation will be retried.`,
  );
  return { status: "partial", document: hold1.document, exchangeFailure: derived.reason };
}

export interface DerivePluginFamilyOptions {
  store: MachineCredentialStore;
  lock?: MachineCredentialLock;
  exchangeClient: TokenExchangeClient;
  /** The exchanging client's OWN id (stamped onto the derived family — O2). */
  clientId: string;
  /** A FRESH agent-plane access token (the exchange `subject_token`). */
  agentAccessToken: string;
  /**
   * The subject the agent credential belongs to (review fix B2a). When the store's subject at
   * the write hold is a DIFFERENT known subject — a confirmed account switch landed between the
   * holds — the write is refused (`aborted`/`subject-changed`): the derived family belongs to
   * the old account and must not enter the new account's store. Omit only when the mint carried
   * no `sub` (pre-O5 servers — nothing to compare, F7.3).
   */
  expectedSubject?: string;
  serverTarget?: string;
  /** Injectable best-effort revoker for a derived family orphaned by an abort. */
  revokeToken?: RevokeTokenFn;
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
}

export type DerivePluginFamilyResult =
  | { status: "derived"; document: MachineCredentials }
  | { status: "exchange-failed"; reason: string }
  /** Review fix B2a: the hold-2 re-verification refused the write; nothing was written. */
  | {
      status: "aborted";
      reason: Exclude<CommitAbortReason, "guard-premise-changed">;
      detail?: string;
    };

/**
 * The F1.4 derivation leg alone: RFC 8693 exchange → plugin family + v1 mirror under ONE lock
 * hold. Also the retry entry point for the `partial` state. On failure NOTHING is written.
 *
 * **Hold-2 re-verification (review fix B2a).** The exchange runs with the lock released, so the
 * world may have changed before the write hold. Under the hold, the store must still match the
 * commit's expectations, or the write is refused as a result (never a throw):
 *  - subject changed to a different known account (confirmed switch between holds) ⇒
 *    `aborted`/`subject-changed`;
 *  - store gone (machine-wide sign-out, F6) ⇒ `aborted`/`store-missing` — a signed-out machine
 *    is NEVER signed back in by recreating its store;
 *  - store unreadable ⇒ `aborted`/`store-unreadable` — never overwritten by this path (04 §1).
 * On any abort the just-derived (now orphaned) family is revoked best-effort — no orphan device
 * row.
 */
export async function derivePluginFamily(
  options: DerivePluginFamilyOptions,
): Promise<DerivePluginFamilyResult> {
  const lock = options.lock ?? new MachineCredentialLock(options.store.baseDirectory);
  const exchange = await options.exchangeClient.exchange({
    subjectToken: options.agentAccessToken,
    clientId: options.clientId,
    ...(options.serverTarget !== undefined ? { serverTarget: options.serverTarget } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!exchange.ok) {
    return { status: "exchange-failed", reason: exchange.reason };
  }

  const pluginFamily: MachineTokenFamily = {
    accessToken: exchange.accessToken,
    ...(exchange.refreshToken !== undefined ? { refreshToken: exchange.refreshToken } : {}),
    ...(exchange.expiresAt !== undefined ? { expiresAt: exchange.expiresAt } : {}),
    clientId: options.clientId,
    scope: exchange.scope ?? DEFAULT_PLUGIN_SCOPE,
  };

  // SECOND lock hold (F1.4): re-verify, then write the plugin family + the v1 compat mirror
  // (applied by writeFamily). `sub` from the exchange response backfills a missing store subject
  // (04 §4 "no path writes a subject-less credential") but never overwrites a present one.
  type Hold2Outcome =
    | { ok: true; document: MachineCredentials }
    | { ok: false; reason: Exclude<CommitAbortReason, "guard-premise-changed">; detail?: string };
  const outcome = await lock.withLock((): Hold2Outcome => {
    const state = safeReadState(options.store);
    if (state === null) {
      return { ok: false, reason: "store-unreadable", detail: "reading the machine credential store failed" };
    }
    if (state.status === "unreadable") {
      return { ok: false, reason: "store-unreadable", detail: state.reason };
    }
    if (state.status === "missing") {
      return { ok: false, reason: "store-missing" }; // signed out between holds — never recreate
    }
    const storedSubject = nonEmptySubject(state.credentials.subject);
    if (
      options.expectedSubject !== undefined &&
      storedSubject !== undefined &&
      storedSubject !== options.expectedSubject
    ) {
      return { ok: false, reason: "subject-changed" };
    }
    try {
      return {
        ok: true,
        document: options.store.writeFamily("plugin", pluginFamily, {
          ...(storedSubject === undefined && exchange.sub ? { subject: exchange.sub } : {}),
        }),
      };
    } catch (err) {
      if (err instanceof MachineCredentialStoreUnreadableError) {
        // A non-lock-honoring writer corrupted the store inside our microsecond window —
        // result-shaped, never an escaping throw, never an overwrite (B2a).
        return { ok: false, reason: "store-unreadable", detail: err.message };
      }
      throw err;
    }
  });

  if (!outcome.ok) {
    // The derived family has no home now — revoke it best-effort so no orphan device row lingers.
    const minted = exchange.refreshToken ?? exchange.accessToken;
    const revoke = resolveRevoker(options);
    await tryRevoke(
      revoke,
      minted,
      options.clientId,
      exchange.refreshToken ? "refresh_token" : "access_token",
      options.onWarning,
    );
    options.onWarning?.(
      `Plugin-family derivation aborted (${outcome.reason}): the machine's credential store changed between the commit holds.`,
    );
    return {
      status: "aborted",
      reason: outcome.reason,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
    };
  }
  return { status: "derived", document: outcome.document };
}

// ── tools-only login commit (O10/F10) ───────────────────────────────────────────────────────────

export interface CommitToolsOnlyLoginOptions {
  store: MachineCredentialStore;
  lock?: MachineCredentialLock;
  /** The minting surface's OWN OAuth client id (stamped onto the plugin family). */
  clientId: string;
  /** The `scope=mcp:plugin` mint result (device flow with `--tools-only`, or enroll). */
  credentials: MachineCredentials;
  confirmAccountSwitch?: (info: {
    storedSubject: string;
    newSubject: string;
  }) => boolean | Promise<boolean>;
  revokeToken?: RevokeTokenFn;
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
}

export type CommitToolsOnlyLoginResult =
  | { status: "committed"; document: MachineCredentials }
  | { status: "switch-declined"; storedSubject: string; newSubject: string }
  /** Review fix B2b: the guard's premise changed before the write hold; nothing was written. */
  | { status: "aborted"; reason: "guard-premise-changed" };

/**
 * Commit a `--tools-only` (O10) mint: ONE lock hold writing the plugin family only (F10 — the
 * store then holds no agent family; App pickup is impossible by design). The same D6/F7 guard
 * applies (premise re-verified under the hold — B2b); a confirmed switch replaces the store.
 */
export async function commitToolsOnlyLogin(
  options: CommitToolsOnlyLoginOptions,
): Promise<CommitToolsOnlyLoginResult> {
  const { store, credentials } = options;
  if (!credentials.accessToken) {
    throw new Error("plugin credentials carry no access token");
  }
  const lock = options.lock ?? new MachineCredentialLock(store.baseDirectory);

  const guard = await runAccountSwitchGuard(options);
  if (guard.kind === "declined") {
    return {
      status: "switch-declined",
      storedSubject: guard.storedSubject,
      newSubject: guard.newSubject,
    };
  }

  const hold = await commitFamilyUnderHold({
    store,
    lock,
    name: "plugin",
    family: tokenFamily(credentials, options.clientId, DEFAULT_PLUGIN_SCOPE),
    serverTarget: credentials.serverTarget,
    subject: credentials.subject,
    guard,
  });
  if (!hold.committed) {
    options.onWarning?.(
      "Tools-only login aborted: the machine's stored account changed while the sign-in was being confirmed; retry to re-evaluate.",
    );
    return { status: "aborted", reason: "guard-premise-changed" };
  }
  return { status: "committed", document: hold.document };
}

// ── machine-wide sign-out (F6/D5) ───────────────────────────────────────────────────────────────

export interface SignOutMachineWideOptions {
  store: MachineCredentialStore;
  lock?: MachineCredentialLock;
  /**
   * The component's own client id — presented when revoking a family that stores none
   * (`families.legacy`, F6.2; RFC 7009 returns 200 even for a wrong id/invalid token).
   */
  defaultClientId?: string;
  /** Injectable best-effort revoker; defaults to RFC 7009 against the document's serverTarget. */
  revokeToken?: RevokeTokenFn;
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
}

export interface SignOutMachineWideResult {
  /** Per-family best-effort revocation outcomes (empty when nothing was revocable). */
  revoked: Array<{ family: string; ok: boolean }>;
  /** True when the store file was deleted (the F6 delete path ran). */
  deleted: boolean;
}

/**
 * Machine-wide sign-out (F6, D5 — "signs out all tools on this machine"; the caller shows the
 * confirmation): best-effort RFC 7009 revocation of EVERY family's refresh token (stored
 * `clientId`, falling back to `defaultClientId` for legacy — F6.2), then the 04 §2 delete path —
 * acquire lock → unlink store → release → unlink lock. Failed/offline revokes never block the
 * local delete (F6.4: families die naturally at ≤30 d). Throws {@link CredentialLockBusyError}
 * when the lock stays contended — sign-out must not delete the store mid-rotation; retry.
 */
export async function signOutMachineWide(
  options: SignOutMachineWideOptions,
): Promise<SignOutMachineWideResult> {
  const { store } = options;
  const lock = options.lock ?? new MachineCredentialLock(store.baseDirectory);
  const revoked: Array<{ family: string; ok: boolean }> = [];

  const state = safeReadState(store);
  if (state?.status === "ok") {
    const document = state.credentials;
    const revoke =
      options.revokeToken ?? resolveRevoker({ credentials: document, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
    for (const [name, family] of Object.entries(effectiveFamilies(document))) {
      const token = family?.refreshToken;
      if (!token) continue;
      const clientId =
        typeof family.clientId === "string" && family.clientId
          ? family.clientId
          : options.defaultClientId;
      if (!clientId) {
        options.onWarning?.(
          `Cannot revoke the '${name}' family server-side (no client id known); it will be deleted locally and expire naturally.`,
        );
        continue;
      }
      revoked.push({
        family: name,
        ok: await tryRevoke(revoke, token, clientId, "refresh_token", options.onWarning),
      });
    }
  } else if (state?.status === "unreadable") {
    options.onWarning?.(
      "Machine credential store is unreadable — server-side revocation is impossible; deleting the local store (explicit sign-out).",
    );
  }

  // The 04 §2 delete path: acquire → unlink store → release (which unlinks the lock file).
  await lock.deleteStoreUnderLock(() => store.delete());
  return { revoked, deleted: true };
}
