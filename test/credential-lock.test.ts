import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACQUIRE_BUDGET,
  CREDENTIALS_LOCK_FILE_NAME,
  CREDENTIALS_LOCK_TAKEOVER_FILE_NAME,
  CredentialLockBusyError,
  FOREIGN_LOCK_STALE_MS,
  LOCK_STALE_MS,
  MachineCredentialLock,
  REFRESH_HTTP_TIMEOUT,
  classifyLockDocument,
  parseLockContent,
} from "../src/credential-lock.js";

/**
 * In-process protocol tests for the credential-store lock (unified-machine-auth 04 §2).
 *
 * These use the TEST-ONLY timing overrides so a full acquire/busy/takeover cycle runs in
 * milliseconds; the REAL constants and real multi-process semantics (kill -9 holder, live
 * holder inside `REFRESH_HTTP_TIMEOUT`, two waiters on one stale lock) are exercised by the
 * mandated real-subprocess plants in `lock-protocol.subprocess.test.ts`.
 */

const FIXTURE_HOST = "fixture-host";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aigd-lock-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function lockAt(overrides: ConstructorParameters<typeof MachineCredentialLock>[1] = {}): MachineCredentialLock {
  return new MachineCredentialLock(dir, { hostId: FIXTURE_HOST, ...overrides });
}

function lockFilePath(): string {
  return path.join(dir, CREDENTIALS_LOCK_FILE_NAME);
}

function intentFilePath(): string {
  return path.join(dir, CREDENTIALS_LOCK_TAKEOVER_FILE_NAME);
}

/** Plant a lock file as if written by `hostId` and backdate its mtime by `ageMs`. */
function plantLock(hostId: string, ageMs: number, rawContent?: string): Buffer {
  const bytes = Buffer.from(
    rawContent ?? JSON.stringify({ pid: 999_999_999, startedAt: new Date(Date.now() - ageMs).toISOString(), hostId }),
    "utf-8",
  );
  fs.writeFileSync(lockFilePath(), bytes);
  const past = new Date(Date.now() - ageMs);
  fs.utimesSync(lockFilePath(), past, past);
  return bytes;
}

describe("lock protocol constants (shared cross-language contract, 04 §2)", () => {
  it("pins the exact contract values", () => {
    expect(REFRESH_HTTP_TIMEOUT).toBe(15_000);
    expect(LOCK_STALE_MS).toBe(60_000);
    expect(ACQUIRE_BUDGET).toBe(75_000);
    expect(FOREIGN_LOCK_STALE_MS).toBe(86_400_000);
    expect(CREDENTIALS_LOCK_FILE_NAME).toBe("credentials.lock");
    expect(CREDENTIALS_LOCK_TAKEOVER_FILE_NAME).toBe("credentials.lock.takeover");
  });

  it("holds the ordering invariant REFRESH_HTTP_TIMEOUT < LOCK_STALE_MS < ACQUIRE_BUDGET", () => {
    expect(REFRESH_HTTP_TIMEOUT).toBeLessThan(LOCK_STALE_MS);
    expect(LOCK_STALE_MS).toBeLessThan(ACQUIRE_BUDGET);
  });

  it("matches the cross-language golden vector consumed by the x1 parity suite", () => {
    const vectorPath = path.join(import.meta.dirname, "golden-vectors", "LockProtocol.GoldenVectors.json");
    const vector = JSON.parse(fs.readFileSync(vectorPath, "utf-8")) as Record<string, unknown>;
    expect(vector["lockFileName"]).toBe(CREDENTIALS_LOCK_FILE_NAME);
    expect(vector["takeoverIntentFileName"]).toBe(CREDENTIALS_LOCK_TAKEOVER_FILE_NAME);
    expect(vector["refreshHttpTimeoutMs"]).toBe(REFRESH_HTTP_TIMEOUT);
    expect(vector["lockStaleMs"]).toBe(LOCK_STALE_MS);
    expect(vector["acquireBudgetMs"]).toBe(ACQUIRE_BUDGET);
    expect(vector["foreignLockStaleMs"]).toBe(FOREIGN_LOCK_STALE_MS);
    expect(vector["hostIdCompare"]).toBe("case-insensitive");
  });

  it("writes lock documents whose field NAMES AND ORDER match the golden vector (x1 byte-parity)", async () => {
    const vectorPath = path.join(import.meta.dirname, "golden-vectors", "LockProtocol.GoldenVectors.json");
    const vector = JSON.parse(fs.readFileSync(vectorPath, "utf-8")) as Record<string, unknown>;
    const lock = lockAt();
    await lock.acquire();
    const written = JSON.parse(fs.readFileSync(lockFilePath(), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(written)).toEqual(vector["lockDocumentFields"]);
    lock.release();
  });
});

describe("acquire / release", () => {
  it("acquires by exclusive-create, writing {pid, startedAt, hostId}, and releases by unlink", async () => {
    const lock = lockAt();
    expect(lock.lockPath).toBe(lockFilePath());
    expect(lock.isHeld).toBe(false);

    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    const content = parseLockContent(fs.readFileSync(lockFilePath()));
    expect(content).toBeDefined();
    expect(content?.pid).toBe(process.pid);
    expect(content?.hostId).toBe(FIXTURE_HOST);
    expect(Number.isNaN(Date.parse(content?.startedAt ?? ""))).toBe(false);

    lock.release();
    expect(lock.isHeld).toBe(false);
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });

  it("stamps a fresh random 128-bit nonce per acquisition (same-process ms-tie breaker)", async () => {
    const lock = lockAt();
    await lock.acquire();
    const first = parseLockContent(fs.readFileSync(lockFilePath()));
    lock.release();
    await lock.acquire();
    const second = parseLockContent(fs.readFileSync(lockFilePath()));
    lock.release();

    expect(first?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(second?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(first?.nonce).not.toBe(second?.nonce);
  });

  it("creates the store directory when missing", async () => {
    const nested = path.join(dir, "does", "not", "exist");
    const lock = new MachineCredentialLock(nested, { hostId: FIXTURE_HOST });
    await lock.acquire();
    expect(fs.existsSync(path.join(nested, CREDENTIALS_LOCK_FILE_NAME))).toBe(true);
    lock.release();
  });

  it("is non-reentrant: a second acquire on a held instance throws instead of deadlocking", async () => {
    const lock = lockAt();
    await lock.acquire();
    await expect(lock.acquire()).rejects.toThrow(/non-reentrant/);
    lock.release();
  });

  it("release is a safe no-op when the lock file is already gone", async () => {
    const lock = lockAt();
    await lock.acquire();
    fs.unlinkSync(lockFilePath());
    expect(() => lock.release()).not.toThrow();
    expect(lock.isHeld).toBe(false);
  });

  it("release never deletes a lock that no longer carries our content (taken over by a peer)", async () => {
    const lock = lockAt();
    await lock.acquire();
    // Simulate a legitimate stale takeover by a peer while we overstayed.
    const peerBytes = Buffer.from(
      JSON.stringify({ pid: 4242, startedAt: new Date().toISOString(), hostId: FIXTURE_HOST }),
      "utf-8",
    );
    fs.writeFileSync(lockFilePath(), peerBytes);

    lock.release();
    expect(lock.isHeld).toBe(false);
    expect(fs.existsSync(lockFilePath())).toBe(true);
    expect(fs.readFileSync(lockFilePath()).equals(peerBytes)).toBe(true);
  });
});

describe("busy on budget exhaustion (D9 REVISED: never lock-free)", () => {
  it("fails as CredentialLockBusyError when a live same-host lock never goes stale in budget", async () => {
    const planted = plantLock(FIXTURE_HOST, 0);
    const lock = lockAt({ staleMs: 5_000, acquireBudgetMs: 300, maxBackoffMs: 50 });

    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(lock.isHeld).toBe(false);
    // The holder's lock survives untouched — a busy waiter never deletes or rewrites it.
    expect(fs.readFileSync(lockFilePath()).equals(planted)).toBe(true);
  });

  it("carries the lock path and the waited duration", async () => {
    plantLock(FIXTURE_HOST, 0);
    const lock = lockAt({ staleMs: 5_000, acquireBudgetMs: 250, maxBackoffMs: 50 });
    const err = await lock.acquire().then(
      () => undefined,
      (e: unknown) => e as CredentialLockBusyError,
    );
    expect(err).toBeInstanceOf(CredentialLockBusyError);
    expect(err?.lockPath).toBe(lockFilePath());
    expect(err?.waitedMs).toBeGreaterThanOrEqual(250);
  });
});

describe("stale takeover (compare-and-delete, 04 §2)", () => {
  it("takes over a same-host lock older than the stale threshold", async () => {
    plantLock(FIXTURE_HOST, 1_000);
    const lock = lockAt({ staleMs: 400, acquireBudgetMs: 2_000, maxBackoffMs: 50 });

    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    expect(parseLockContent(fs.readFileSync(lockFilePath()))?.pid).toBe(process.pid);
    lock.release();
  });

  it("does NOT take over a same-host lock younger than the stale threshold", async () => {
    const planted = plantLock(FIXTURE_HOST, 1_000);
    const lock = lockAt({ staleMs: 5_000, acquireBudgetMs: 300, maxBackoffMs: 50 });

    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(fs.readFileSync(lockFilePath()).equals(planted)).toBe(true);
  });

  it("judges staleness by LAST-WRITE time, never atime: old atime + fresh mtime is NOT stale", async () => {
    plantLock(FIXTURE_HOST, 0);
    // atime far in the past, mtime now — an atime-based (wrong) implementation would steal this.
    fs.utimesSync(lockFilePath(), new Date(Date.now() - 3_600_000), new Date());
    const lock = lockAt({ staleMs: 1_000, acquireBudgetMs: 300, maxBackoffMs: 50 });
    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
  });

  it("judges staleness by LAST-WRITE time: old mtime + fresh atime IS stale", async () => {
    plantLock(FIXTURE_HOST, 5_000);
    fs.utimesSync(lockFilePath(), new Date(), new Date(Date.now() - 5_000));
    const lock = lockAt({ staleMs: 1_000, acquireBudgetMs: 2_000, maxBackoffMs: 50 });
    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    lock.release();
  });

  it("bars a foreign-hostId lock from the short threshold (network home, 04 §2)", async () => {
    const planted = plantLock("some-other-machine", 2_000);
    // Way past the local stale threshold, far under the foreign bar.
    const lock = lockAt({ staleMs: 400, foreignStaleMs: 60_000, acquireBudgetMs: 300, maxBackoffMs: 50 });

    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(fs.readFileSync(lockFilePath()).equals(planted)).toBe(true);
  });

  it("takes over a foreign-hostId lock older than the foreign bar", async () => {
    plantLock("some-other-machine", 5_000);
    const lock = lockAt({ staleMs: 400, foreignStaleMs: 1_000, acquireBudgetMs: 2_000, maxBackoffMs: 50 });

    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    lock.release();
  });

  it("takes over an UNPARSEABLE lock at LOCK_STALE_MS with one diagnostic warning (amended contract)", async () => {
    // Its writer never entered the critical section (full write precedes handle return precedes
    // entry), so the 24 h foreign bar would protect nothing while wedging same-host recovery.
    plantLock(FIXTURE_HOST, 2_000, "not json at all {{{");
    const warnings: string[] = [];
    const lock = lockAt({
      staleMs: 400,
      foreignStaleMs: 60_000,
      acquireBudgetMs: 2_000,
      maxBackoffMs: 50,
      onWarning: (message) => warnings.push(message),
    });

    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unparseable/);
    lock.release();
  });

  it("takes over a ZERO-BYTE lock artifact at LOCK_STALE_MS (crashed 'wx' creator)", async () => {
    plantLock(FIXTURE_HOST, 2_000, "");
    const warnings: string[] = [];
    const lock = lockAt({
      staleMs: 400,
      foreignStaleMs: 60_000,
      acquireBudgetMs: 2_000,
      maxBackoffMs: 50,
      onWarning: (message) => warnings.push(message),
    });

    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    expect(warnings).toHaveLength(1);
    lock.release();
  });

  it("does NOT take over an unparseable lock younger than LOCK_STALE_MS, and stays silent", async () => {
    const planted = plantLock(FIXTURE_HOST, 1_000, "not json at all {{{");
    const warnings: string[] = [];
    const lock = lockAt({
      staleMs: 5_000,
      acquireBudgetMs: 300,
      maxBackoffMs: 50,
      onWarning: (message) => warnings.push(message),
    });

    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(fs.readFileSync(lockFilePath()).equals(planted)).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("compares hostId CASE-INSENSITIVELY: a case-differing same-host lock gets the short threshold", async () => {
    plantLock(FIXTURE_HOST.toUpperCase(), 2_000);
    const lock = lockAt({ staleMs: 400, foreignStaleMs: 60_000, acquireBudgetMs: 2_000, maxBackoffMs: 50 });

    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    lock.release();
  });

  it("treats an EMPTY hostId in a parseable doc as FOREIGN (24 h bar)", async () => {
    const planted = plantLock("", 2_000);
    const lock = lockAt({ staleMs: 400, foreignStaleMs: 60_000, acquireBudgetMs: 300, maxBackoffMs: 50 });

    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(fs.readFileSync(lockFilePath()).equals(planted)).toBe(true);
  });

  it("treats a MISSING hostId in a parseable doc as FOREIGN (24 h bar)", async () => {
    const planted = plantLock(
      FIXTURE_HOST,
      2_000,
      JSON.stringify({ pid: 999, startedAt: new Date().toISOString() }),
    );
    const lock = lockAt({ staleMs: 400, foreignStaleMs: 60_000, acquireBudgetMs: 300, maxBackoffMs: 50 });

    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(fs.readFileSync(lockFilePath()).equals(planted)).toBe(true);
  });

  it("cleans the takeover-intent file up after a successful takeover", async () => {
    plantLock(FIXTURE_HOST, 1_000);
    const lock = lockAt({ staleMs: 400, acquireBudgetMs: 2_000, maxBackoffMs: 50 });
    await lock.acquire();
    expect(fs.existsSync(intentFilePath())).toBe(false);
    lock.release();
    expect(fs.existsSync(intentFilePath())).toBe(false);
  });

  it("backs off while a LIVE takeover intent exists — another claimant is mid-takeover", async () => {
    const planted = plantLock(FIXTURE_HOST, 1_000); // stale main lock
    // A fresh intent: some other claimant is between intent-create and intent-release.
    fs.writeFileSync(
      intentFilePath(),
      JSON.stringify({ pid: 4242, startedAt: new Date().toISOString(), hostId: FIXTURE_HOST }),
    );
    const lock = lockAt({ staleMs: 400, acquireBudgetMs: 300, maxBackoffMs: 50 });

    await expect(lock.acquire()).rejects.toBeInstanceOf(CredentialLockBusyError);
    // Neither the stale lock nor the other claimant's intent was touched.
    expect(fs.readFileSync(lockFilePath()).equals(planted)).toBe(true);
    expect(fs.existsSync(intentFilePath())).toBe(true);
  });

  it("recovers a CRASHED claimant's stale takeover intent and completes the takeover", async () => {
    plantLock(FIXTURE_HOST, 1_000); // stale main lock
    // A stale intent: its claimant died between intent-create and intent-release.
    fs.writeFileSync(
      intentFilePath(),
      JSON.stringify({ pid: 4242, startedAt: new Date(Date.now() - 1_000).toISOString(), hostId: FIXTURE_HOST }),
    );
    const past = new Date(Date.now() - 1_000);
    fs.utimesSync(intentFilePath(), past, past);
    const lock = lockAt({ staleMs: 400, acquireBudgetMs: 2_000, maxBackoffMs: 50 });

    await lock.acquire();
    expect(lock.isHeld).toBe(true);
    expect(fs.existsSync(intentFilePath())).toBe(false);
    lock.release();
  });
});

describe("withLock", () => {
  it("holds the lock during fn and releases after", async () => {
    const lock = lockAt();
    const result = await lock.withLock(() => {
      expect(lock.isHeld).toBe(true);
      expect(fs.existsSync(lockFilePath())).toBe(true);
      return 42;
    });
    expect(result).toBe(42);
    expect(lock.isHeld).toBe(false);
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });

  it("releases when fn throws", async () => {
    const lock = lockAt();
    await expect(lock.withLock(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(lock.isHeld).toBe(false);
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });
});

describe("F6 logout delete path (acquire → unlink store → release → unlink lock)", () => {
  it("deletes the store while holding the lock, then removes the lock", async () => {
    const storePath = path.join(dir, "credentials.json");
    fs.writeFileSync(storePath, "{}");
    const lock = lockAt();

    await lock.deleteStoreUnderLock(() => {
      // The lock MUST be held while the store is unlinked.
      expect(lock.isHeld).toBe(true);
      expect(fs.existsSync(lockFilePath())).toBe(true);
      fs.rmSync(storePath);
    });

    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(lockFilePath())).toBe(false);
  });

  it("fails busy — and leaves the store intact — when the lock is contended (never lock-free)", async () => {
    const storePath = path.join(dir, "credentials.json");
    fs.writeFileSync(storePath, "{}");
    plantLock(FIXTURE_HOST, 0);
    const lock = lockAt({ staleMs: 5_000, acquireBudgetMs: 250, maxBackoffMs: 50 });

    let storeUnlinked = false;
    await expect(
      lock.deleteStoreUnderLock(() => {
        storeUnlinked = true;
        fs.rmSync(storePath);
      }),
    ).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(storeUnlinked).toBe(false);
    expect(fs.existsSync(storePath)).toBe(true);
  });
});

describe("parseLockContent", () => {
  it("parses a well-formed lock document (nonce optional — pre-nonce writers stay readable)", () => {
    const bytes = Buffer.from(JSON.stringify({ pid: 7, startedAt: "2026-08-14T00:00:00.000Z", hostId: "h" }));
    expect(parseLockContent(bytes)).toEqual({ pid: 7, startedAt: "2026-08-14T00:00:00.000Z", hostId: "h" });
  });

  it("passes a nonce through when present", () => {
    const bytes = Buffer.from(
      JSON.stringify({ pid: 7, startedAt: "2026-08-14T00:00:00.000Z", hostId: "h", nonce: "ab12" }),
    );
    expect(parseLockContent(bytes)?.nonce).toBe("ab12");
  });

  it.each([
    ["garbage", "]]]not json"],
    ["non-object", "42"],
    ["missing pid", JSON.stringify({ startedAt: "t", hostId: "h" })],
    ["missing hostId", JSON.stringify({ pid: 1, startedAt: "t" })],
    ["mistyped pid", JSON.stringify({ pid: "1", startedAt: "t", hostId: "h" })],
  ])("returns undefined for %s", (_name, raw) => {
    expect(parseLockContent(Buffer.from(raw))).toBeUndefined();
  });
});

describe("classifyLockDocument (amended staleness classes)", () => {
  const doc = (hostId: unknown): Buffer =>
    Buffer.from(JSON.stringify({ pid: 1, startedAt: "t", hostId }));

  it.each([
    ["same host, same case", doc("host-a"), "local"],
    ["same host, different case", doc("HOST-A"), "local"],
    ["different host", doc("host-b"), "foreign"],
    ["empty hostId", doc(""), "foreign"],
    ["missing hostId", Buffer.from(JSON.stringify({ pid: 1, startedAt: "t" })), "foreign"],
    ["mistyped hostId", doc(42), "foreign"],
    ["zero-byte", Buffer.alloc(0), "unparseable"],
    ["garbage", Buffer.from("]]]not json"), "unparseable"],
    ["non-object", Buffer.from("42"), "unparseable"],
    ["array", Buffer.from("[1,2]"), "unparseable"],
  ])("classifies %s as %s", (_name, bytes, expected) => {
    expect(classifyLockDocument(bytes as Buffer, "host-a")).toBe(expected);
  });
});
