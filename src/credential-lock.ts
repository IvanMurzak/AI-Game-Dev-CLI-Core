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
 *  - **Stale takeover by compare-and-delete.** A candidate whose last-WRITE time (never atime)
 *    is older than {@link LOCK_STALE_MS} and whose `hostId` matches the local host is taken
 *    over: read its content, re-stat, delete only if the content is byte-identical to what was
 *    read, then race for exclusive-create and verify the new lock's content is your own before
 *    entering. A lock with a foreign `hostId` (network home) is only taken over after
 *    {@link FOREIGN_LOCK_STALE_MS} (24 h).
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
 *
 * No OS offers an atomic compare-and-delete primitive, so the compare-and-delete pair is made
 * atomic against concurrent claimants via a RENAME-CLAIM (see
 * {@link MachineCredentialLock.tryStaleTakeover}): the stale candidate is atomically moved to a
 * private sibling name first — exactly one claimant can win that rename — and only then
 * compared and discarded. A plain validate-then-unlink measurably fails the mandated two-waiter
 * plant: both waiters validate the SAME unchanged stale file, and the slower unlink deletes the
 * faster waiter's freshly created live lock. The C# twin (b2) must realize compare-and-delete
 * the same way (`File.Move` to a private name is the same atomic arbiter). The x2
 * mixed-language concurrency suite hammers exactly this seam.
 */

/** File name of the cross-process lock, a sibling of `credentials.json` — NEVER the data file itself (04 §2). */
export const CREDENTIALS_LOCK_FILE_NAME = "credentials.lock";

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

/** The JSON document written into the lock file at acquisition (04 §2). */
export interface CredentialLockContent {
  /** Process id of the holder (diagnostic; staleness is judged by mtime, never by pid probing). */
  pid: number;
  /** ISO-8601 instant the holder acquired the lock (diagnostic). */
  startedAt: string;
  /** Stable machine identifier of the holder — hostname is acceptable (04 §2). */
  hostId: string;
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
  private readonly _hostId: string;
  private readonly _staleMs: number;
  private readonly _foreignStaleMs: number;
  private readonly _acquireBudgetMs: number;
  private readonly _maxBackoffMs: number;

  /** The exact bytes we wrote into the lock file while held; undefined when not held. */
  private _ownContent: Buffer | undefined;

  constructor(baseDirectory?: string, options: MachineCredentialLockOptions = {}) {
    const dir = baseDirectory ?? path.join(os.homedir(), MACHINE_STORE_DIR_NAME);
    this._lockPath = path.join(dir, CREDENTIALS_LOCK_FILE_NAME);
    this._hostId = options.hostId ?? os.hostname();
    this._staleMs = options.staleMs ?? LOCK_STALE_MS;
    this._foreignStaleMs = options.foreignStaleMs ?? FOREIGN_LOCK_STALE_MS;
    this._acquireBudgetMs = options.acquireBudgetMs ?? ACQUIRE_BUDGET;
    this._maxBackoffMs = options.maxBackoffMs ?? BACKOFF_CAP_MS;
  }

  /** Absolute path of the lock file (`<store dir>/credentials.lock`). */
  get lockPath(): string {
    return this._lockPath;
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
        // We unlinked a stale lock — race for exclusive-create immediately (04 §2), no backoff.
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
      /* best-effort: a racing takeover may have unlinked it between the read and here */
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
   * verify it still holds OUR content before we consider ourselves the holder — a waiter that
   * raced a stale takeover against us may have unlinked our fresh lock and created its own.
   */
  private tryExclusiveCreate(): boolean {
    const content: CredentialLockContent = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostId: this._hostId,
    };
    const bytes = Buffer.from(JSON.stringify(content), "utf-8");

    let fd: number;
    try {
      fs.mkdirSync(path.dirname(this._lockPath), { recursive: true });
      fd = fs.openSync(this._lockPath, "wx", 0o600);
    } catch (err) {
      if (isErrno(err, "EEXIST")) {
        return false; // held by someone — the caller decides between backoff and stale takeover
      }
      throw err;
    }
    try {
      fs.writeSync(fd, bytes);
    } finally {
      fs.closeSync(fd); // close immediately: peers judge staleness by our mtime (04 §2)
    }

    // Verify the new lock's content is our own before entering the critical section (04 §2).
    // A transient ENOENT can be a mis-claim in flight (a racing waiter momentarily renamed our
    // fresh lock away and is about to restore it, byte-identical) — give the restore one brief
    // chance before treating the lock as lost; any OTHER content means a racer's live lock is
    // in place and we must walk away without deleting it.
    for (let verifyAttempt = 0; verifyAttempt < 2; verifyAttempt += 1) {
      let readBack: Buffer;
      try {
        readBack = fs.readFileSync(this._lockPath);
      } catch {
        if (verifyAttempt === 0) {
          sleepBlockingMs(15);
          continue;
        }
        return false; // our fresh lock was stolen by a racing takeover before we could verify
      }
      if (!readBack.equals(bytes)) {
        return false; // a racer's lock is in place now; never delete it — keep waiting
      }
      this._ownContent = bytes;
      return true;
    }
    return false;
  }

  /**
   * Stale-takeover attempt by compare-and-delete (04 §2). Returns true when the stale lock was
   * removed (the caller then races for exclusive-create immediately); false when there is
   * nothing stale to take over or we lost a race along the way.
   *
   * Staleness is judged on the LAST-WRITE time (mtime — never atime: reads must not extend a
   * lock's life) against {@link LOCK_STALE_MS} for a same-host lock and
   * {@link FOREIGN_LOCK_STALE_MS} for a foreign or unreadable one. Unparseable content is
   * treated as FOREIGN on purpose — fail-safe: when we cannot prove the holder is this machine,
   * we must not apply the short threshold.
   *
   * The compare-and-delete pair is made ATOMIC with respect to concurrent claimants via a
   * rename-claim: the candidate is first `rename`d to a private sibling name — an operation
   * exactly one process can win (losers get ENOENT and never delete anything) — and only then
   * byte-compared against what was validated. Two waiters that judged the SAME stale lock both
   * pass a pure read/re-stat validation (the file is unchanged for both), so a plain
   * validate-then-unlink lets the slower waiter's unlink land after the faster one has already
   * re-created a live lock — deleting it. The rename arbiter closes that measured race (the
   * plant in `lock-protocol.subprocess.test.ts` fails without it). In the residual window where
   * the claim itself catches a freshly re-created LIVE lock (claim landed after the winner's
   * create), the mismatch is detected by the byte-compare and the claimed file is restored via
   * an atomic no-replace `link` — never clobbering a newer lock. Crash debris (a private
   * `credentials.lock.steal.*` sibling) can only exist if a process dies mid-takeover and never
   * shadows the canonical lock path.
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

    const holder = parseLockContent(content1);
    const threshold =
      holder !== undefined && holder.hostId === this._hostId ? this._staleMs : this._foreignStaleMs;
    if (Date.now() - stat1.mtimeMs < threshold) {
      return false; // not stale (or not provably ours to judge on the short threshold)
    }

    // Atomic claim: move the candidate aside. Exactly one concurrent claimant wins the rename;
    // every loser gets ENOENT here and walks away without ever deleting anything.
    const claimedPath = `${this._lockPath}.steal.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.renameSync(this._lockPath, claimedPath);
    } catch {
      return false; // another waiter claimed it first (or the holder released) — retry create
    }

    // Delete only if byte-identical to what we validated (04 §2). rename preserves mtime, so a
    // claimed file that is NOT the artifact we judged stale is a live lock re-created between
    // our validation and our claim.
    let claimedStat: fs.Stats | undefined;
    let claimedContent: Buffer | undefined;
    try {
      claimedStat = fs.statSync(claimedPath);
      claimedContent = fs.readFileSync(claimedPath);
    } catch {
      /* fall through to the mismatch path — never treat an unreadable claim as validated */
    }
    if (
      claimedStat === undefined ||
      claimedContent === undefined ||
      !claimedContent.equals(content1) ||
      claimedStat.mtimeMs !== stat1.mtimeMs
    ) {
      // We claimed a LIVE lock. Put it back with an atomic no-replace link: if a newer lock
      // already exists at the canonical path, the link fails and the displaced holder's own
      // verify-own-content step makes it re-contend instead of double-entering.
      try {
        fs.linkSync(claimedPath, this._lockPath);
      } catch {
        /* a newer lock is already in place — leave it; the displaced holder re-contends */
      }
      try {
        fs.unlinkSync(claimedPath);
      } catch {
        /* best-effort cleanup of the private claim name */
      }
      return false;
    }

    // The claimed file IS the stale artifact we validated — discard it and race for create.
    try {
      fs.unlinkSync(claimedPath);
    } catch {
      /* the canonical path is already free either way */
    }
    return true;
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
  return { pid: record["pid"], startedAt: record["startedAt"], hostId: record["hostId"] };
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

/** Tiny synchronous pause used only inside the verify retry (single-digit ms, no event loop). */
function sleepBlockingMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin — bounded by `ms`, called once per rare mis-claim race */
  }
}
