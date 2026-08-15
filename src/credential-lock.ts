import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MACHINE_STORE_DIR_NAME } from "./machine-credentials.js";

/**
 * Cross-process lock protocol for the machine credential store (unified-machine-auth 04 §2) —
 * the TypeScript twin of the C# implementation in MCP-Plugin-dotnet (b2), with IDENTICAL
 * semantics and constants so mixed C#/TS processes on one machine serialize correctly against
 * the same `~/.ai-game-dev/credentials.lock` file.
 *
 * Protocol invariants (04 §2):
 *
 *  - **Exclusive-create only.** Acquisition is `open(…, 'wx')` (C#: `FileMode.CreateNew`) of the
 *    lock file, writing `{pid, startedAt, hostId}` and closing the handle immediately so the
 *    mtime is visible to peers. NO advisory locks (`flock`/`FileShare.None`) anywhere — .NET
 *    skips advisory locks on NFS/SMB and `File.Delete` ignores them on Linux (O6), so
 *    exclusive-create is the only primitive both languages can rely on identically.
 *
 *  - **Ordered constants.** {@link REFRESH_HTTP_TIMEOUT} < {@link LOCK_STALE_MS} <
 *    {@link ACQUIRE_BUDGET}. The ordering IS the invariant: a live holder inside one HTTP call
 *    can never be declared stale, and a waiter always outlives the stale threshold so takeover
 *    is reachable. Exported (and pinned by `test/golden-vectors/LockProtocol.GoldenVectors.json`)
 *    so the cross-language parity suite (x1) can assert equality with the C# values.
 *
 *  - **Stale takeover by compare-and-delete, SERIALIZED through a takeover-intent file.** A
 *    candidate whose last-WRITE time (never atime) is older than its class's threshold may be
 *    taken over ({@link classifyLockDocument}): same-host (case-insensitive `hostId`) and
 *    unparseable/zero-byte documents at {@link LOCK_STALE_MS}; parseable foreign-`hostId`
 *    documents (network home) only after {@link FOREIGN_LOCK_STALE_MS} (24 h). The remover must
 *    first win an
 *    exclusive-create of the sibling intent file ({@link CREDENTIALS_LOCK_TAKEOVER_FILE_NAME}),
 *    re-validate that the candidate is the SAME artifact it judged stale (stat + byte-identical
 *    content), and only then unlink it — then release the intent and race for exclusive-create
 *    of the lock itself, verifying the new lock's content is its own before entering.
 *
 *    The intent serialization is LOAD-BEARING, not defensive garnish: with removal gated only by
 *    a read → re-stat → re-read → unlink sequence (whether the removal is an `unlink` or an
 *    atomic rename-claim), two lockstep waiters both validate the SAME unchanged stale file, and
 *    the slower one's removal lands after the faster one has already re-created and verified a
 *    LIVE lock — stranding a verified holder and letting a third waiter in. Both raced variants
 *    were MEASURED double-entering under a 4-process hammer (see
 *    `lock-protocol.subprocess.test.ts`, plant 3, which fails against either). Exclusive-create
 *    of the intent is the atomic arbiter that path-based removal cannot provide.
 *
 *    Crash recovery: a claimant that dies between intent-create and intent-release leaves the
 *    intent file behind; it is itself recovered by the same staleness rules (compare-and-delete,
 *    unserialized — safe because it requires the rare crashed-intent precondition on top of the
 *    tight race window, multiplying two small probabilities; the C# twin shares this residual by
 *    design).
 *
 *  - **Budget exhaustion ⇒ "busy", never lock-free.** When {@link ACQUIRE_BUDGET} elapses the
 *    attempt fails with {@link CredentialLockBusyError} (D9 REVISED — the removed "kill-switch"
 *    fallback would have reintroduced the refresh-token reuse race). There is deliberately NO
 *    code path that proceeds without the lock.
 *
 *  - **Release = delete the lock file.** {@link MachineCredentialLock.release} additionally
 *    verifies the file still carries OUR content before unlinking, so a holder that overstayed
 *    {@link LOCK_STALE_MS} and was legitimately taken over never deletes the new holder's lock
 *    (a strict safety refinement of "delete the lock file"; unobservable on the happy path).
 *
 *  - **Logout delete path (F6).** {@link MachineCredentialLock.deleteStoreUnderLock}:
 *    acquire → unlink store → release (which unlinks the lock).
 */

/** File name of the cross-process lock, a sibling of `credentials.json` — NEVER the data file itself (04 §2). */
export const CREDENTIALS_LOCK_FILE_NAME = "credentials.lock";

/**
 * File name of the takeover-intent file (sibling of the lock). Removing a stale
 * {@link CREDENTIALS_LOCK_FILE_NAME} requires FIRST winning an exclusive-create of this file —
 * the atomic arbiter that serializes concurrent stale-takeover claimants (see the module doc).
 * Part of the shared cross-language protocol surface: the C# twin (b2) must honor the same
 * intent file, or a mixed C#/TS fleet degrades to the measured double-acquire race.
 */
export const CREDENTIALS_LOCK_TAKEOVER_FILE_NAME = "credentials.lock.takeover";

/**
 * Network timeout (ms) for the token-refresh HTTP call performed INSIDE the lock's critical
 * section — 15 s, explicitly set in both languages (.NET's default would be 100 s, which would
 * break the ordering invariant). Must stay `<` {@link LOCK_STALE_MS}: a live holder inside one
 * HTTP call can never be declared stale. Shared contract with C# (04 §2); consumed by the
 * refresher wiring (c3).
 */
export const REFRESH_HTTP_TIMEOUT = 15_000;

/**
 * Age (ms of last-WRITE time, never atime) beyond which a same-host lock is a stale-takeover
 * candidate — 60 s. Must stay `>` {@link REFRESH_HTTP_TIMEOUT} and `<` {@link ACQUIRE_BUDGET}
 * (04 §2). Shared contract with C#.
 */
export const LOCK_STALE_MS = 60_000;

/**
 * Total time (ms) an acquisition attempt may spend before failing as "busy" — 75 s. Must stay
 * `>` {@link LOCK_STALE_MS} so a waiter always outlives the stale threshold and takeover is
 * reachable (04 §2). Shared contract with C#.
 */
export const ACQUIRE_BUDGET = 75_000;

/**
 * Age (ms) beyond which a lock with a FOREIGN `hostId` may be taken over — 24 h (04 §2). On a
 * network home directory another machine's live process may hold the lock; its clock skew and
 * our inability to probe its pid make the short threshold unsafe, hence the long bar.
 */
export const FOREIGN_LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** The JSON document written into the lock file at acquisition (04 §2 + fix-round amendment). */
export interface CredentialLockContent {
  /** Process id of the holder (diagnostic; staleness is judged by mtime, never by pid probing). */
  pid: number;
  /** ISO-8601 instant the holder acquired the lock (diagnostic). */
  startedAt: string;
  /** Stable machine identifier of the holder — hostname is acceptable (04 §2). Compared CASE-INSENSITIVELY. */
  hostId: string;
  /**
   * Fresh random 128-bit hex per acquisition attempt (fix-round amendment): `startedAt` has only
   * millisecond granularity, so two same-process attempts inside one ms would otherwise produce
   * byte-identical documents and defeat every content-identity comparison in the protocol.
   * Optional on READ — both twins tolerate documents from writers that predate the field.
   */
  nonce?: string;
}

/**
 * Staleness class of a lock/intent document (fix-round contract amendment):
 *  - `local`       — parseable, `hostId` equal to ours case-insensitively ⇒ {@link LOCK_STALE_MS}.
 *  - `foreign`     — parseable, `hostId` missing/empty/different ⇒ {@link FOREIGN_LOCK_STALE_MS}.
 *  - `unparseable` — zero-byte or corrupted ⇒ {@link LOCK_STALE_MS}: such an artifact's writer
 *    NEVER entered the critical section (the full document write precedes the handle return,
 *    which precedes entry), so the 24 h foreign bar would protect nothing while wedging
 *    same-host recovery for a day. Takeover of this class emits one diagnostic warning.
 */
export type LockDocumentClass = "local" | "foreign" | "unparseable";

/**
 * Classify a lock/intent document for staleness-threshold selection (see
 * {@link LockDocumentClass}). `hostId` is compared case-insensitively (hostnames are
 * case-insensitive on every platform we ship to, and Windows reports them inconsistently);
 * an empty or missing `hostId` in an otherwise-parseable document classifies as FOREIGN —
 * a foreign implementation's document proves nothing about which machine wrote it.
 */
export function classifyLockDocument(bytes: Buffer, localHostId: string): LockDocumentClass {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return "unparseable";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unparseable";
  }
  const hostId = (parsed as Record<string, unknown>)["hostId"];
  if (typeof hostId !== "string" || hostId.length === 0) {
    return "foreign";
  }
  return hostId.toLowerCase() === localHostId.toLowerCase() ? "local" : "foreign";
}

/**
 * Thrown by {@link MachineCredentialLock.acquire} when {@link ACQUIRE_BUDGET} elapses without
 * acquiring the lock. The operation MUST be surfaced to the caller as "busy" — it never
 * proceeds lock-free (04 §2, D9 REVISED).
 */
export class CredentialLockBusyError extends Error {
  /** Absolute path of the lock file that stayed contended. */
  readonly lockPath: string;
  /** How long the attempt waited before giving up (ms). */
  readonly waitedMs: number;

  constructor(lockPath: string, waitedMs: number) {
    super(
      `credential store lock is busy: could not acquire ${lockPath} within ${waitedMs} ms; ` +
        "another process is refreshing — retry later (never proceed without the lock)",
    );
    this.name = "CredentialLockBusyError";
    this.lockPath = lockPath;
    this.waitedMs = waitedMs;
  }
}

/**
 * Options for {@link MachineCredentialLock}. The timing overrides exist EXCLUSIVELY so tests can
 * exercise the protocol without minute-scale waits — production consumers MUST use the defaults,
 * which are the 04 §2 cross-language contract ({@link LOCK_STALE_MS} / {@link ACQUIRE_BUDGET} /
 * {@link FOREIGN_LOCK_STALE_MS}). Overriding them in shipping code breaks the ordering invariant
 * shared with the C# twin.
 */
export interface MachineCredentialLockOptions {
  /** Stable machine identifier written into the lock content. Default: `os.hostname()`. */
  hostId?: string;
  /** TEST-ONLY override of {@link LOCK_STALE_MS}. */
  staleMs?: number;
  /** TEST-ONLY override of {@link FOREIGN_LOCK_STALE_MS}. */
  foreignStaleMs?: number;
  /** TEST-ONLY override of {@link ACQUIRE_BUDGET}. */
  acquireBudgetMs?: number;
  /** TEST-ONLY cap of the jittered retry backoff (ms). Default 500. */
  maxBackoffMs?: number;
  /**
   * Structured diagnostic-warning sink (never receives token material — lock documents carry
   * none). Default: `console.warn`, so the one mandated diagnostic — taking over an
   * unparseable/zero-byte lock artifact — surfaces even before a consumer wires a sink.
   */
  onWarning?: (message: string) => void;
}

/** Backoff base delay (ms); doubled per attempt up to the cap, then jittered ×[0.5, 1.5). */
const BACKOFF_BASE_MS = 25;
const BACKOFF_CAP_MS = 500;

/**
 * The cross-process credential-store lock (04 §2). One instance guards one store directory;
 * non-reentrant — a second {@link acquire} on a held instance throws instead of deadlocking.
 *
 * Intended use (c3 refresher / F6 logout):
 * ```ts
 * const lock = new MachineCredentialLock();          // ~/.ai-game-dev/credentials.lock
 * await lock.withLock(() => {                        // acquire → fn → release
 *   // re-read store → decide → network refresh (≤ REFRESH_HTTP_TIMEOUT) → write
 * });
 * ```
 */
export class MachineCredentialLock {
  private readonly _lockPath: string;
  private readonly _intentPath: string;
  private readonly _hostId: string;
  private readonly _staleMs: number;
  private readonly _foreignStaleMs: number;
  private readonly _acquireBudgetMs: number;
  private readonly _maxBackoffMs: number;
  private readonly _onWarning: (message: string) => void;

  /** The exact bytes we wrote into the lock file while held; undefined when not held. */
  private _ownContent: Buffer | undefined;

  constructor(baseDirectory?: string, options: MachineCredentialLockOptions = {}) {
    const dir = baseDirectory ?? path.join(os.homedir(), MACHINE_STORE_DIR_NAME);
    this._lockPath = path.join(dir, CREDENTIALS_LOCK_FILE_NAME);
    this._intentPath = path.join(dir, CREDENTIALS_LOCK_TAKEOVER_FILE_NAME);
    this._hostId = options.hostId ?? os.hostname();
    this._staleMs = options.staleMs ?? LOCK_STALE_MS;
    this._foreignStaleMs = options.foreignStaleMs ?? FOREIGN_LOCK_STALE_MS;
    this._acquireBudgetMs = options.acquireBudgetMs ?? ACQUIRE_BUDGET;
    this._maxBackoffMs = options.maxBackoffMs ?? BACKOFF_CAP_MS;
    this._onWarning = options.onWarning ?? ((message) => console.warn(message));
  }

  /** Absolute path of the lock file (`<store dir>/credentials.lock`). */
  get lockPath(): string {
    return this._lockPath;
  }

  /** Absolute path of the takeover-intent file (`<store dir>/credentials.lock.takeover`). */
  get takeoverIntentPath(): string {
    return this._intentPath;
  }

  /** True while this instance holds the lock. */
  get isHeld(): boolean {
    return this._ownContent !== undefined;
  }

  /**
   * Acquire the lock, waiting up to the budget ({@link ACQUIRE_BUDGET}) with jittered backoff and
   * stale takeover (04 §2). Throws {@link CredentialLockBusyError} when the budget is exhausted —
   * the caller must surface "busy" and MUST NOT proceed lock-free (D9 REVISED).
   */
  async acquire(): Promise<void> {
    if (this.isHeld) {
      throw new Error(
        `credential lock is non-reentrant: ${this._lockPath} is already held by this instance`,
      );
    }

    const startedWaiting = Date.now();
    const deadline = startedWaiting + this._acquireBudgetMs;
    let attempt = 0;
    for (;;) {
      if (this.tryExclusiveCreate()) {
        return;
      }
      if (this.tryStaleTakeover()) {
        // We removed a stale lock — race for exclusive-create immediately (04 §2), no backoff.
        continue;
      }
      const now = Date.now();
      if (now >= deadline) {
        throw new CredentialLockBusyError(this._lockPath, now - startedWaiting);
      }
      await sleep(Math.min(this.nextBackoffMs(attempt), deadline - now));
      attempt += 1;
    }
  }

  /**
   * Release the lock: delete the lock file (04 §2) — but only when it still carries OUR content.
   * If a peer legitimately took the lock over (we overstayed {@link LOCK_STALE_MS}), the file is
   * theirs now and is left untouched. Safe to call when the file is already gone. Always clears
   * the held state.
   */
  release(): void {
    const own = this._ownContent;
    this._ownContent = undefined;
    if (own === undefined) {
      return;
    }
    let current: Buffer;
    try {
      current = fs.readFileSync(this._lockPath);
    } catch {
      return; // already gone (e.g. taken over and released, or manually cleaned)
    }
    if (!current.equals(own)) {
      return; // a peer's lock now — never delete it (compare-and-delete, release side)
    }
    try {
      fs.unlinkSync(this._lockPath);
    } catch {
      /* best-effort: a racing takeover may have removed it between the read and here */
    }
  }

  /**
   * Run `fn` inside the lock's critical section: acquire → fn → release (release runs even when
   * `fn` throws). The refresher's critical section (04 §2): re-read store → decide → network
   * refresh (≤ {@link REFRESH_HTTP_TIMEOUT}) → write → release.
   */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * The F6 logout delete path (04 §2): acquire → `unlinkStore()` (the server-side revoke has
   * already been done by the caller) → release, which unlinks the lock file. Exposed so logout
   * consumers never hand-roll the ordering. Throws {@link CredentialLockBusyError} when the lock
   * cannot be acquired — logout must not delete the store while a refresher is mid-rotation.
   */
  async deleteStoreUnderLock(unlinkStore: () => void): Promise<void> {
    await this.acquire();
    try {
      unlinkStore();
    } finally {
      this.release();
    }
  }

  /**
   * One `open(…,'wx')` exclusive-create attempt (04 §2). On success the content is written, the
   * handle is closed immediately (so the mtime is visible to peers), and the file is re-read to
   * verify it still holds OUR content before we consider ourselves the holder.
   */
  private tryExclusiveCreate(): boolean {
    const bytes = this.newDocumentBytes();

    let fd: number;
    try {
      fs.mkdirSync(path.dirname(this._lockPath), { recursive: true });
      fd = fs.openSync(this._lockPath, "wx", 0o600);
    } catch (err) {
      if (isErrno(err, "EEXIST")) {
        return false; // held by someone — the caller decides between backoff and stale takeover
      }
      if (isErrno(err, "EPERM") || isErrno(err, "EACCES") || isErrno(err, "EBUSY")) {
        // Windows: an exclusive-create racing a concurrent unlink can land in the file's
        // DELETE-PENDING window, which surfaces as an access error rather than EEXIST. That is
        // transient contention, not a permission problem — back off and retry (measured under
        // the 4-waiter takeover hammer; POSIX never takes this branch for contention).
        return false;
      }
      throw err;
    }
    try {
      fs.writeSync(fd, bytes);
    } catch (err) {
      // Own-artifact cleanup (fix-round amendment): a failed write must not leave OUR zero-byte
      // or partial artifact wedging peers until it goes stale — close, best-effort unlink of the
      // file THIS process just created (it is milliseconds old, so no takeover can own it yet),
      // and propagate the environmental error.
      try {
        fs.closeSync(fd);
      } catch {
        /* already on the error path */
      }
      try {
        fs.unlinkSync(this._lockPath);
      } catch {
        /* best-effort */
      }
      throw err;
    }
    fs.closeSync(fd); // close immediately: peers judge staleness by our mtime (04 §2)

    // Verify the new lock's content is our own before entering the critical section (04 §2).
    let readBack: Buffer;
    try {
      readBack = fs.readFileSync(this._lockPath);
    } catch {
      return false; // our fresh lock disappeared under us — walk away and re-contend
    }
    if (!readBack.equals(bytes)) {
      return false; // a racer's lock is in place now; never delete it — keep waiting
    }
    this._ownContent = bytes;
    return true;
  }

  /**
   * Stale-takeover attempt (04 §2), serialized through the takeover-intent file. Returns true
   * when the stale lock was removed (the caller then races for exclusive-create immediately);
   * false when there is nothing stale to take over or we lost a race along the way.
   *
   * Staleness is judged on the LAST-WRITE time (mtime — never atime: reads must not extend a
   * lock's life) against {@link LOCK_STALE_MS} for a same-host lock and
   * {@link FOREIGN_LOCK_STALE_MS} for a foreign or unreadable one. Unparseable content is
   * treated as FOREIGN on purpose — fail-safe: when we cannot prove the holder is this machine,
   * we must not apply the short threshold.
   *
   * Sequence: judge stale → win exclusive-create of the INTENT file (losers back off; a live
   * lock is never touched by a claimant that did not win the intent) → re-validate that the
   * candidate is the SAME artifact (stat + byte-identical content; a live replacement always
   * differs — its `startedAt`/`pid` are newer than the dead holder's) → unlink it → release the
   * intent. Only then does the caller race `open('wx')` for the lock itself.
   */
  private tryStaleTakeover(): boolean {
    let stat1: fs.Stats;
    try {
      stat1 = fs.statSync(this._lockPath);
    } catch {
      return false; // gone already — the caller's next exclusive-create attempt races for it
    }

    let content1: Buffer;
    try {
      content1 = fs.readFileSync(this._lockPath);
    } catch {
      return false;
    }

    const documentClass = classifyLockDocument(content1, this._hostId);
    const threshold = documentClass === "foreign" ? this._foreignStaleMs : this._staleMs;
    if (Date.now() - stat1.mtimeMs < threshold) {
      return false; // not stale (or not provably ours to judge on the short threshold)
    }

    // Serialize claimants: only the winner of the intent file's exclusive-create may remove the
    // stale artifact. Without this arbiter, two lockstep claimants both validate the unchanged
    // stale file and the slower removal deletes a freshly re-created LIVE lock (measured).
    const intentBytes = this.tryAcquireTakeoverIntent();
    if (intentBytes === undefined) {
      return false; // another claimant is mid-takeover (or a live intent blocks us) — back off
    }
    try {
      // Re-validate under the intent: remove only the exact artifact we judged stale.
      let stat2: fs.Stats;
      let content2: Buffer;
      try {
        stat2 = fs.statSync(this._lockPath);
        content2 = fs.readFileSync(this._lockPath);
      } catch {
        return false; // released or already removed while we acquired the intent
      }
      if (
        stat2.mtimeMs !== stat1.mtimeMs ||
        stat2.size !== stat1.size ||
        !content2.equals(content1)
      ) {
        return false; // replaced by a live lock while we acquired the intent — leave it alone
      }
      // Re-verify intent ownership IMMEDIATELY before the removal (fix-round amendment): if a
      // crashed-intent recovery displaced our intent between acquisition and here, the removal
      // authority is no longer ours.
      let intentNow: Buffer;
      try {
        intentNow = fs.readFileSync(this._intentPath);
      } catch {
        return false;
      }
      if (!intentNow.equals(intentBytes)) {
        return false;
      }
      try {
        fs.unlinkSync(this._lockPath);
      } catch {
        return false;
      }
      if (documentClass === "unparseable") {
        // One diagnostic per takeover of a corrupt artifact (fix-round amendment): its writer
        // never entered the critical section, but its existence usually means a crashed or
        // interrupted acquisition worth surfacing. Lock documents carry no token material.
        this._onWarning(
          `credential lock takeover: removed an unparseable (zero-byte or corrupted) lock artifact at ${this._lockPath}; ` +
            "treated as stale at LOCK_STALE_MS because its writer can never have entered the critical section",
        );
      }
      return true;
    } finally {
      this.releaseTakeoverIntent(intentBytes);
    }
  }

  /**
   * Try to win the takeover-intent file by exclusive-create, recovering a CRASHED claimant's
   * intent by the same staleness + compare-and-delete rules. Returns the intent content bytes on
   * success (used to verify ownership at release) or undefined when another claimant holds it.
   *
   * The crashed-intent recovery path is deliberately unserialized (there is no third lock): it
   * is reachable only when a claimant died between intent-create and intent-release, and the
   * damage of its residual race is another claimant pair racing the MAIN takeover — two small
   * probabilities multiplied, accepted by design in both languages.
   */
  private tryAcquireTakeoverIntent(): Buffer | undefined {
    const bytes = this.newDocumentBytes();

    for (let createAttempt = 0; createAttempt < 2; createAttempt += 1) {
      let fd: number;
      try {
        fd = fs.openSync(this._intentPath, "wx", 0o600);
      } catch (err) {
        if (!isErrno(err, "EEXIST")) {
          return undefined;
        }
        // An intent exists. Recover it only if its holder crashed (stale by the same
        // classification rules as the lock itself — an unparseable/zero-byte intent's writer
        // never completed intent acquisition, so it gets the short threshold too).
        let istat: fs.Stats;
        let icontent: Buffer;
        try {
          istat = fs.statSync(this._intentPath);
          icontent = fs.readFileSync(this._intentPath);
        } catch {
          continue; // vanished — retry the exclusive-create once
        }
        const intentClass = classifyLockDocument(icontent, this._hostId);
        const ithreshold = intentClass === "foreign" ? this._foreignStaleMs : this._staleMs;
        if (Date.now() - istat.mtimeMs < ithreshold) {
          return undefined; // a live claimant is mid-takeover — back off
        }
        // Compare-and-delete the crashed intent, then retry the exclusive-create once.
        let istat2: fs.Stats;
        let icontent2: Buffer;
        try {
          istat2 = fs.statSync(this._intentPath);
          icontent2 = fs.readFileSync(this._intentPath);
        } catch {
          continue;
        }
        if (istat2.mtimeMs !== istat.mtimeMs || !icontent2.equals(icontent)) {
          return undefined;
        }
        try {
          fs.unlinkSync(this._intentPath);
        } catch {
          return undefined;
        }
        continue;
      }
      try {
        fs.writeSync(fd, bytes);
      } catch (err) {
        // Own-artifact cleanup (fix-round amendment) — mirror of the lock path: never leave OUR
        // zero-byte intent wedging every claimant until it goes stale.
        try {
          fs.closeSync(fd);
        } catch {
          /* already on the error path */
        }
        try {
          fs.unlinkSync(this._intentPath);
        } catch {
          /* best-effort */
        }
        throw err;
      }
      fs.closeSync(fd);

      // Verify the intent still carries OUR content before relying on it (fix-round amendment —
      // the lock path has always had this step; a racing crashed-intent recovery could have
      // replaced our intent between the write and here).
      let readBack: Buffer;
      try {
        readBack = fs.readFileSync(this._intentPath);
      } catch {
        return undefined;
      }
      if (!readBack.equals(bytes)) {
        return undefined; // displaced — the removal authority is not ours; never delete theirs
      }
      return bytes;
    }
    return undefined;
  }

  /**
   * Fresh protocol document bytes for one acquisition attempt: `{pid, startedAt, hostId, nonce}`
   * with a fresh random 128-bit hex `nonce` (fix-round amendment) — `startedAt` alone has ms
   * granularity, so same-process attempts inside one ms would otherwise be byte-identical and
   * defeat the protocol's content-identity comparisons.
   */
  private newDocumentBytes(): Buffer {
    const content: CredentialLockContent = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostId: this._hostId,
      nonce: randomBytes(16).toString("hex"),
    };
    return Buffer.from(JSON.stringify(content), "utf-8");
  }

  /** Release the takeover-intent file — only when it still carries OUR content. */
  private releaseTakeoverIntent(ownBytes: Buffer): void {
    let current: Buffer;
    try {
      current = fs.readFileSync(this._intentPath);
    } catch {
      return; // already gone
    }
    if (!current.equals(ownBytes)) {
      return; // a crashed-intent recovery replaced it — it is someone else's now
    }
    try {
      fs.unlinkSync(this._intentPath);
    } catch {
      /* best-effort */
    }
  }

  /** Jittered exponential backoff: base 25 ms doubled per attempt, capped, ×[0.5, 1.5). */
  private nextBackoffMs(attempt: number): number {
    const uncapped = BACKOFF_BASE_MS * 2 ** Math.min(attempt, 10);
    const capped = Math.min(uncapped, this._maxBackoffMs);
    return Math.max(1, Math.round(capped * (0.5 + Math.random())));
  }
}

/** Parse lock-file bytes into {@link CredentialLockContent}; undefined when unparseable/mis-shaped. */
export function parseLockContent(bytes: Buffer): CredentialLockContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["pid"] !== "number" ||
    typeof record["startedAt"] !== "string" ||
    typeof record["hostId"] !== "string"
  ) {
    return undefined;
  }
  const nonce = record["nonce"];
  return {
    pid: record["pid"],
    startedAt: record["startedAt"],
    hostId: record["hostId"],
    // Optional on read (fix-round amendment): documents from pre-nonce writers stay parseable.
    ...(typeof nonce === "string" ? { nonce } : {}),
  };
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === code
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
