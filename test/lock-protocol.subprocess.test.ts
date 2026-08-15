import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ACQUIRE_BUDGET,
  CREDENTIALS_LOCK_FILE_NAME,
  LOCK_STALE_MS,
  REFRESH_HTTP_TIMEOUT,
} from "../src/credential-lock.js";

/**
 * The MANDATED real-subprocess plants for the lock protocol (unified-machine-auth 04 §5, c2):
 *
 *  1. kill -9 the holder → a survivor recovers after `LOCK_STALE_MS` within `ACQUIRE_BUDGET`;
 *  2. a holder sleeping `REFRESH_HTTP_TIMEOUT` inside the lock is NOT taken over;
 *  3. two waiters observing the same stale lock never both acquire (compare-and-delete).
 *
 * Every child is a REAL `node` process running `test/fixtures/lock-runner.mjs` against the BUILT
 * library (`dist/`) with the REAL contract constants — no test-only timing overrides. Where a
 * plant would otherwise wait the full 60 s staleness window, the orphaned lock file's mtime is
 * backdated with `utimes`: mtime (last-write time) is exactly the observable the protocol keys
 * staleness on (04 §2), so aging the file exercises the identical decision path; plant 2 runs in
 * full real time against the real 15 s hold.
 *
 * Each plant also proves its POSITIVE half in the same run (a waiter that never acquires would
 * satisfy any "did not steal" assertion vacuously): plant 1's waiter must actually enter after
 * the stale instant; plant 2's waiter must actually enter after the release; plant 3's waiters
 * must BOTH eventually enter, sequentially.
 */

interface RunnerEvent {
  tag: string;
  pid: number;
  t: number;
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const runnerPath = path.join(repoRoot, "test", "fixtures", "lock-runner.mjs");

const children: ChildProcess[] = [];
const stderrByPid = new Map<number, string[]>();

beforeAll(() => {
  // The runner children import from dist/ (they run plain node, outside vitest's transpiler).
  // CI builds before testing; locally, rebuild when dist is missing or stale.
  const out = path.join(repoRoot, "dist", "credential-lock.js");
  const sources = [
    path.join(repoRoot, "src", "credential-lock.ts"),
    path.join(repoRoot, "src", "machine-credentials.ts"),
  ];
  const stale =
    !fs.existsSync(out) ||
    sources.some((source) => fs.statSync(source).mtimeMs > fs.statSync(out).mtimeMs);
  if (stale) {
    const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", path.join(repoRoot, "tsconfig.json")], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
}, 180_000);

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  stderrByPid.clear();
});

function spawnRunner(mode: "hold" | "acquire", storeDir: string, eventsFile: string, holdMs: number): ChildProcess {
  const child = spawn(process.execPath, [runnerPath, mode, storeDir, eventsFile, String(holdMs)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  const lines: string[] = [];
  stderrByPid.set(child.pid ?? -1, lines);
  child.stderr?.on("data", (chunk: Buffer) => lines.push(chunk.toString("utf-8")));
  return child;
}

/** Decode the base64 detail field of any ERROR events so failures name the actual exception. */
function errorDetails(eventsFile: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.startsWith("ERROR "))
    .map((line) => {
      const detail = line.trim().split(" ")[3];
      try {
        return detail === undefined ? line : Buffer.from(detail, "base64").toString("utf-8");
      } catch {
        return line;
      }
    });
}

function readEvents(eventsFile: string): RunnerEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(eventsFile, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [tag, pid, t] = line.trim().split(" ");
      return { tag: tag ?? "", pid: Number(pid), t: Number(t) };
    });
}

async function waitForEvent(
  eventsFile: string,
  predicate: (event: RunnerEvent) => boolean,
  timeoutMs: number,
  description: string,
): Promise<RunnerEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = readEvents(eventsFile).find(predicate);
    if (match !== undefined) {
      return match;
    }
    if (Date.now() >= deadline) {
      const stderr = [...stderrByPid.values()].flat().join("");
      throw new Error(
        `timed out after ${timeoutMs} ms waiting for ${description}; events so far: ` +
          `${JSON.stringify(readEvents(eventsFile))}; child stderr: ${stderr || "(empty)"}`,
      );
    }
    await sleep(50);
  }
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStoreDir(): { dir: string; eventsFile: string; lockPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aigd-lock-plant-"));
  return {
    dir,
    eventsFile: path.join(dir, "events.log"),
    lockPath: path.join(dir, CREDENTIALS_LOCK_FILE_NAME),
  };
}

describe("lock protocol — mandated real-subprocess plants (04 §5)", () => {
  it(
    "plant 1: a kill -9'd holder's lock is recovered after LOCK_STALE_MS, within ACQUIRE_BUDGET",
    async () => {
      const { dir, eventsFile, lockPath } = makeStoreDir();
      try {
        // A real holder process acquires, then dies hard (no release, no cleanup).
        const holder = spawnRunner("hold", dir, eventsFile, 600_000);
        await waitForEvent(eventsFile, (e) => e.tag === "ACQUIRED", 15_000, "holder ACQUIRED");
        holder.kill("SIGKILL");
        await exited(holder);
        expect(fs.existsSync(lockPath)).toBe(true); // the orphan survives the kill

        // Age the orphan so it goes stale in ~3 s instead of 60 s. mtime (last-write time) is
        // exactly the observable the protocol judges staleness on (04 §2), so this exercises
        // the identical decision path at test-affordable wall time.
        const staleRemainingMs = 3_000;
        const backdatedMtime = Date.now() - (LOCK_STALE_MS - staleRemainingMs);
        fs.utimesSync(lockPath, new Date(backdatedMtime), new Date(backdatedMtime));
        const staleInstant = backdatedMtime + LOCK_STALE_MS;

        const waiterStart = Date.now();
        const waiter = spawnRunner("acquire", dir, eventsFile, 200);
        const enter = await waitForEvent(eventsFile, (e) => e.tag === "ENTER", 30_000, "waiter ENTER");

        // Negative half: never taken over BEFORE the lock went stale (ε for mtime rounding).
        expect(enter.t).toBeGreaterThanOrEqual(staleInstant - 250);
        // Positive half: recovery genuinely happened, within the acquire budget.
        expect(enter.t - waiterStart).toBeLessThanOrEqual(ACQUIRE_BUDGET);
        expect(enter.pid).toBe(waiter.pid);

        await waitForEvent(eventsFile, (e) => e.tag === "EXIT", 15_000, "waiter EXIT");
        const tags = readEvents(eventsFile).map((e) => e.tag);
        expect(tags).toContain("INTACT"); // the survivor's own lock was never stolen mid-hold
        expect(tags).not.toContain("BUSY");
        expect(tags).not.toContain("STOLEN");
        expect(tags).not.toContain("ERROR");
        expect(fs.existsSync(lockPath)).toBe(false); // released cleanly after recovery
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "plant 2: a live holder sleeping REFRESH_HTTP_TIMEOUT inside the lock is NOT taken over",
    async () => {
      const { dir, eventsFile } = makeStoreDir();
      try {
        // The holder sleeps the full REAL REFRESH_HTTP_TIMEOUT (15 s) inside its critical
        // section — the longest a live refresher can legitimately hold the lock (04 §2).
        const holder = spawnRunner("hold", dir, eventsFile, REFRESH_HTTP_TIMEOUT);
        const acquired = await waitForEvent(eventsFile, (e) => e.tag === "ACQUIRED", 15_000, "holder ACQUIRED");

        // A real waiter contends for the whole hold, with the real 75 s budget.
        const waiter = spawnRunner("acquire", dir, eventsFile, 200);
        const released = await waitForEvent(
          eventsFile,
          (e) => e.tag === "RELEASED",
          REFRESH_HTTP_TIMEOUT + 30_000,
          "holder RELEASED",
        );
        const enter = await waitForEvent(eventsFile, (e) => e.tag === "ENTER", 30_000, "waiter ENTER");

        // Negative half: the waiter entered only AFTER the holder released — never mid-hold.
        expect(enter.t).toBeGreaterThanOrEqual(released.t);
        // The holder's lock stayed its own for the whole sleep (verified by the holder itself
        // immediately before releasing).
        const holderIntact = readEvents(eventsFile).find(
          (e) => e.tag === "INTACT" && e.pid === holder.pid,
        );
        expect(holderIntact).toBeDefined();
        // Positive halves: the wait really spanned the full hold, and the waiter — whose budget
        // (75 s) outlives the hold (15 s) by the ordering invariant — did acquire, not go busy.
        expect(enter.t - acquired.t).toBeGreaterThanOrEqual(REFRESH_HTTP_TIMEOUT - 250);
        expect(enter.pid).toBe(waiter.pid);
        await waitForEvent(eventsFile, (e) => e.tag === "EXIT", 15_000, "waiter EXIT");
        const tags = readEvents(eventsFile).map((e) => e.tag);
        expect(tags).not.toContain("BUSY");
        expect(tags).not.toContain("STOLEN");
        expect(tags).not.toContain("ERROR");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "plant 3: waiters observing the same stale lock never double-acquire (compare-and-delete)",
    async () => {
      // Contention parameters are CALIBRATED, not arbitrary: with the takeover-intent
      // serialization removed, 4 lockstep waiters double-acquire in ~12% of rounds on a loaded
      // Windows box (3/25 measured; 2 waiters expose it far more rarely). 30 rounds put the
      // mutation-detection probability near 1 - 0.88^30 ≈ 98% while the green path stays ~35 s.
      const ROUNDS = 30;
      const WAITERS = 4;
      const HOLD_MS = 150;
      for (let round = 0; round < ROUNDS; round += 1) {
        const { dir, eventsFile, lockPath } = makeStoreDir();
        try {
          // Fabricate a long-dead same-host holder: every waiter sees it stale IMMEDIATELY, so
          // all attempt the compare-and-delete takeover concurrently — the exact race the
          // intent serialization + verify-own-content steps exist for.
          const deadHolderMtime = Date.now() - LOCK_STALE_MS - 60_000;
          fs.writeFileSync(
            lockPath,
            JSON.stringify({
              pid: 999_999_999,
              startedAt: new Date(deadHolderMtime).toISOString(),
              hostId: os.hostname(),
            }),
          );
          fs.utimesSync(lockPath, new Date(deadHolderMtime), new Date(deadHolderMtime));

          const waiters = Array.from({ length: WAITERS }, () =>
            spawnRunner("acquire", dir, eventsFile, HOLD_MS),
          );
          await Promise.all(waiters.map((w) => exited(w)));

          const events = readEvents(eventsFile);
          const tags = events.map((e) => e.tag);
          expect(tags).not.toContain("BUSY");
          expect(errorDetails(eventsFile), "child processes reported errors").toEqual([]);
          // A STOLEN report is a holder whose verified lock was removed from under it —
          // the double-acquire mechanism caught red-handed even when the overlap is short.
          expect(tags).not.toContain("STOLEN");

          // Positive half: ALL waiters eventually acquired (sequentially) — a round where some
          // never entered would prove nothing about mutual exclusion.
          const enters = events.filter((e) => e.tag === "ENTER");
          const exits = events.filter((e) => e.tag === "EXIT");
          expect(enters).toHaveLength(WAITERS);
          expect(exits).toHaveLength(WAITERS);

          // Negative half: no two [ENTER, EXIT] critical sections overlap.
          const sections = enters
            .map((enter) => ({
              enter,
              exit: exits.find((exit) => exit.pid === enter.pid),
            }))
            .sort((a, b) => a.enter.t - b.enter.t);
          for (const section of sections) {
            expect(section.exit).toBeDefined();
          }
          for (let i = 1; i < sections.length; i += 1) {
            expect((sections[i - 1]?.exit?.t ?? Number.NaN) <= (sections[i]?.enter.t ?? Number.NaN)).toBe(
              true,
            );
          }

          expect(fs.existsSync(lockPath)).toBe(false); // fully released at the end
          // The takeover-intent file never outlives the takeover that used it.
          expect(fs.existsSync(`${lockPath}.takeover`)).toBe(false);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    240_000,
  );
});
