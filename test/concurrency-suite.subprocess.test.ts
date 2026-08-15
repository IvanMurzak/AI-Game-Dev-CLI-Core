import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ACQUIRE_BUDGET,
  CREDENTIALS_LOCK_FILE_NAME,
  CREDENTIALS_LOCK_TAKEOVER_FILE_NAME,
  LOCK_STALE_MS,
  REFRESH_HTTP_TIMEOUT,
} from "../src/credential-lock.js";
import { MachineCredentialStore, identityCredentialCodec } from "../src/machine-credentials.js";
import { FakeAuthorizationServer } from "./fake-as.js";

/**
 * The mixed-language REAL-PROCESS concurrency suite (unified-machine-auth 04 §5 / 03 F8, task
 * x2): N actual OS processes — Node workers driving this repo's BUILT dist/ plus C# workers
 * driving MCP-Plugin-dotnet's `McpPlugin.Tests.RefreshHarness` — hammer refresh against a local
 * fake AS (`test/fake-as.ts`, a line-cited mirror of the server's `oauth_token_service.py`
 * rotation + reuse-revoke + D10 grace window) over ONE shared machine credential store.
 *
 * Acceptance (F8): zero family revokes at N≥4 mixed processes over ≥100 rotations, with the
 * REAL 15/60/75 s lock constants (no timing overrides anywhere in the green run).
 *
 * Mandated plants (the suite's own falsifiability — G-SEC-1):
 *   1. grace window disabled AND lock disabled ⇒ a family revoke IS observed (the exact counter
 *      the green run gates on trips — the detector can fail);
 *   2. lock disabled, grace ON ⇒ redundant rotations are observable (the grace-hit counter
 *      rises; it is asserted === 0 in the green run);
 *   3. lost-response: a client killed between AS commit and response delivery; the next attempt
 *      (cross-language, taking over the victim's orphan lock with SCALED constants that keep
 *      the timeout < stale < budget ordering) succeeds idempotently within the D10 window —
 *      same successor pair by value, no revoke, no second rotation.
 *
 * GATING: opt-in via X2_CONCURRENCY=1 (the suite spawns many processes and runs minutes — it is
 * CI-home'd in .github/workflows/concurrency-suite.yml, NOT in the required `typecheck + build +
 * test` check). The C# side needs X2_CSHARP_HARNESS=<abs path to McpPlugin.Tests.RefreshHarness.dll>.
 */

const enabled = process.env.X2_CONCURRENCY === "1";
const csharpHarnessDll = process.env.X2_CSHARP_HARNESS ?? "";
const suite = enabled ? describe : describe.skip;

const repoRoot = path.resolve(import.meta.dirname, "..");
const workerPath = path.join(repoRoot, "test", "fixtures", "concurrency-worker.mjs");

const CLIENT_ID = "unity-mcp-plugin";
const SCALED = { timeoutMs: 2_000, staleMs: 5_000, budgetMs: 10_000 };

// ── infrastructure ────────────────────────────────────────────────────────────────────────────

interface TsWorkerConfig {
  mode: "hammer" | "once";
  storeDir: string;
  eventsFile: string;
  serverBase: string;
  clientId: string;
  skewMs: number;
  loopDelayMs: number;
  maxDurationMs: number;
  stopFile: string;
  noLock: boolean;
  scaled: { timeoutMs: number; staleMs: number; budgetMs: number } | null;
}

interface CsWorker {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
}

const children: ChildProcess[] = [];
const servers: FakeAuthorizationServer[] = [];

beforeAll(() => {
  // The workers import from dist/ (plain node, outside vitest's transpiler). CI builds before
  // testing; locally, rebuild when dist is missing or stale (same pattern as the lock plants).
  const out = path.join(repoRoot, "dist", "credential-provider.js");
  const sources = [
    "credential-provider.ts",
    "credential-lock.ts",
    "machine-credentials.ts",
    "token-refresher.ts",
    "atomic-file.ts",
  ].map((name) => path.join(repoRoot, "src", name));
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

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

function makeStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "x2-concurrency-"));
}

function newFakeAs(options: ConstructorParameters<typeof FakeAuthorizationServer>[0]): FakeAuthorizationServer {
  const server = new FakeAuthorizationServer(options);
  servers.push(server);
  return server;
}

/** Seed the shared store with the fake AS's freshly minted plugin family (v2 + mirror). */
function seedStore(
  storeDir: string,
  as: FakeAuthorizationServer,
  options: { expired?: boolean } = {},
): { familyId: string; refreshToken: string } {
  const minted = as.mintFamily({ clientId: CLIENT_ID, scope: "mcp:plugin" });
  const store = new MachineCredentialStore(storeDir, identityCredentialCodec);
  store.writeFamily(
    "plugin",
    {
      accessToken: minted.accessToken,
      refreshToken: minted.refreshToken,
      expiresAt: options.expired ? new Date(Date.now() - 60_000).toISOString() : minted.expiresAt,
      clientId: minted.clientId,
      scope: minted.scope,
    },
    { serverTarget: as.baseUrl, subject: "usr_x2-concurrency" },
  );
  return { familyId: minted.familyId, refreshToken: minted.refreshToken };
}

function readStorePluginFamily(storeDir: string): { accessToken?: string; refreshToken?: string } {
  const store = new MachineCredentialStore(storeDir, identityCredentialCodec);
  const state = store.readState();
  expect(state.status, "shared store must remain readable").toBe("ok");
  const family =
    state.status === "ok" ? (state.credentials.families?.plugin ?? state.credentials.families?.legacy) : undefined;
  expect(family, "shared store must retain its plugin family").toBeDefined();
  return family ?? {};
}

function spawnTsWorker(config: TsWorkerConfig): ChildProcess {
  const child = spawn(process.execPath, [workerPath, JSON.stringify(config)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.push(child);
  const stderr: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf-8")));
  child.once("exit", () => {
    if (stderr.length > 0) {
      // Surface worker stderr in the vitest output for diagnosis; assertions run on events/exits.
      console.error(`[ts-worker pid=${child.pid}]`, stderr.join(""));
    }
  });
  return child;
}

function spawnCsWorker(args: string[]): CsWorker {
  expect(
    csharpHarnessDll,
    "X2_CSHARP_HARNESS must point at the built McpPlugin.Tests.RefreshHarness.dll (the mixed-language mandate is not satisfiable without the C# workers)",
  ).toBeTruthy();
  const child = spawn("dotnet", [csharpHarnessDll, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf-8");
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length > 0) stdout.push(line.trim());
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf-8")));
  child.once("exit", () => {
    if (stderr.length > 0) {
      console.error(`[cs-worker pid=${child.pid}]`, stderr.join(""));
    }
  });
  return { child, stdout, stderr };
}

function csHammerArgs(
  mode: "hammer" | "hammer-nolock",
  storeDir: string,
  serverBase: string,
  skewMs: number,
  loopDelayMs: number,
  maxDurationMs: number,
  stopFile: string,
): string[] {
  return [mode, storeDir, serverBase, CLIENT_ID, String(skewMs), String(loopDelayMs), String(maxDurationMs), stopFile];
}

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function pollUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms waiting for: ${description}`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function tsWorkerRefreshes(eventsFile: string): number {
  if (!fs.existsSync(eventsFile)) return 0;
  return fs
    .readFileSync(eventsFile, "utf-8")
    .split("\n")
    .filter((line) => line.startsWith("DONE "))
    .map((line) => Number(line.trim().split(" ")[3] ?? "0"))
    .reduce((sum, value) => sum + value, 0);
}

function csWorkerRefreshes(worker: CsWorker): number {
  const done = worker.stdout.find((line) => line.startsWith("DONE "));
  const match = done?.match(/refreshes=(\d+)/);
  return match ? Number(match[1]) : 0;
}

function sha256Hex(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf-8").digest("hex");
}

// ── the suite ─────────────────────────────────────────────────────────────────────────────────

suite("mixed-language refresh concurrency (x2)", () => {
  it("timing contract: the real constants hold the ordering invariant and match the golden vector", () => {
    // 04 §2: REFRESH_HTTP_TIMEOUT < LOCK_STALE_MS < ACQUIRE_BUDGET — the invariant that makes a
    // live holder untouchable and a stale takeover reachable. The green run uses these REAL
    // values; the only scaled variant (plant 3's retry) is asserted against the same ordering.
    expect(REFRESH_HTTP_TIMEOUT).toBeLessThan(LOCK_STALE_MS);
    expect(LOCK_STALE_MS).toBeLessThan(ACQUIRE_BUDGET);

    const vector = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "test", "golden-vectors", "LockProtocol.GoldenVectors.json"), "utf-8"),
    ) as { refreshHttpTimeoutMs: number; lockStaleMs: number; acquireBudgetMs: number };
    expect(REFRESH_HTTP_TIMEOUT).toBe(vector.refreshHttpTimeoutMs);
    expect(LOCK_STALE_MS).toBe(vector.lockStaleMs);
    expect(ACQUIRE_BUDGET).toBe(vector.acquireBudgetMs);

    expect(SCALED.timeoutMs).toBeLessThan(SCALED.staleMs);
    expect(SCALED.staleMs).toBeLessThan(SCALED.budgetMs);
  });

  it(
    "acceptance (F8): N=4 mixed C#/TS processes, ≥100 rotations, ZERO family revokes",
    async () => {
      const as = newFakeAs({ graceWindowMs: 30_000, accessTokenTtlSeconds: 2 });
      await as.start();
      const storeDir = makeStoreDir();
      const { familyId } = seedStore(storeDir, as);

      const eventsFile = path.join(storeDir, "events.log");
      const stopFile = path.join(storeDir, "stop");
      const skewMs = 1_500;
      const loopDelayMs = 25;
      const maxDurationMs = 240_000;

      const tsWorkers = [0, 1].map(() =>
        spawnTsWorker({
          mode: "hammer",
          storeDir,
          eventsFile,
          serverBase: as.baseUrl,
          clientId: CLIENT_ID,
          skewMs,
          loopDelayMs,
          maxDurationMs,
          stopFile,
          noLock: false,
          scaled: null,
        }),
      );
      const csWorkers = [0, 1].map(() =>
        spawnCsWorker(csHammerArgs("hammer", storeDir, as.baseUrl, skewMs, loopDelayMs, maxDurationMs, stopFile)),
      );

      await pollUntil(() => as.counters.rotations >= 110, maxDurationMs, "≥110 rotations at the fake AS");

      fs.writeFileSync(stopFile, "stop");
      const exits = await withTimeout(
        Promise.all([...tsWorkers.map(exited), ...csWorkers.map((worker) => exited(worker.child))]),
        30_000,
        "all 4 workers exiting after the stop signal",
      );

      // Every worker finished cleanly — no dead family, no busy lock, no error.
      for (const [index, exit] of exits.entries()) {
        expect(exit, `worker #${index} exit`).toEqual({ code: 0, signal: null });
      }

      const counters = as.counters;
      expect(counters.rotations, "the acceptance floor").toBeGreaterThanOrEqual(100);
      // THE acceptance invariant (03 F8): a lock-honoring mixed fleet never trips reuse
      // detection. Plant 1 below proves this exact counter CAN trip when the controls are cut.
      expect(counters.familyRevokes, "family revokes in the green run").toBe(0);
      // A lock-honoring fleet also never needs the D10 window locally: every raced process
      // adopts under the lock instead of replaying a predecessor. Plant 2 proves this counter
      // rises when the lock is cut. (If this ever fires it is an interop finding, not noise.)
      expect(counters.graceHits, "grace hits in the green run").toBe(0);

      // Both languages actually rotated (the mixed-fleet mandate, not one language starving).
      expect(tsWorkerRefreshes(eventsFile), "TS-side successful refreshes").toBeGreaterThanOrEqual(5);
      const csRefreshes = csWorkers.reduce((sum, worker) => sum + csWorkerRefreshes(worker), 0);
      expect(csRefreshes, "C#-side successful refreshes").toBeGreaterThanOrEqual(5);

      // End state: the lock is released, the store is readable and holds the family HEAD — the
      // fake AS's single live row (interop proof that the last write is the last rotation).
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_FILE_NAME))).toBe(false);
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_TAKEOVER_FILE_NAME))).toBe(false);
      const family = readStorePluginFamily(storeDir);
      expect(family.refreshToken).toBeDefined();
      expect(sha256Hex(family.refreshToken ?? "")).toBe(as.liveRefreshTokenHash(familyId));
    },
    300_000,
  );

  it(
    "plant 1 (RED): grace window disabled AND lock disabled ⇒ a family revoke IS observed",
    async () => {
      // The falsifiability plant for the acceptance test's familyRevokes===0 gate: cut BOTH
      // controls (D10 window off at the AS, no cross-process lock in any worker) and the reuse
      // race the system exists to prevent must actually happen.
      const as = newFakeAs({ graceWindowMs: 0, accessTokenTtlSeconds: 1, responseDelayMs: 60 });
      await as.start();
      const storeDir = makeStoreDir();
      seedStore(storeDir, as);

      const eventsFile = path.join(storeDir, "events.log");
      const stopFile = path.join(storeDir, "stop");
      const skewMs = 800;
      const loopDelayMs = 15;
      const maxDurationMs = 90_000;

      const tsWorkers = [0, 1].map(() =>
        spawnTsWorker({
          mode: "hammer",
          storeDir,
          eventsFile,
          serverBase: as.baseUrl,
          clientId: CLIENT_ID,
          skewMs,
          loopDelayMs,
          maxDurationMs,
          stopFile,
          noLock: true,
          scaled: null,
        }),
      );
      const csWorkers = [0, 1].map(() =>
        spawnCsWorker(csHammerArgs("hammer-nolock", storeDir, as.baseUrl, skewMs, loopDelayMs, maxDurationMs, stopFile)),
      );

      await pollUntil(() => as.counters.familyRevokes >= 1, 60_000, "a reuse-triggered family revoke at the fake AS");
      expect(as.counters.familyRevokes).toBeGreaterThanOrEqual(1);

      // The revoke reaches real clients: at least one worker must die with the dead-family
      // verdict (exit 5) — the suite's red is a client-visible red, not just an AS counter.
      const anyDead = await withTimeout(
        Promise.race(
          [...tsWorkers, ...csWorkers.map((worker) => worker.child)].map(async (child) => (await exited(child)).code),
        ),
        30_000,
        "a worker exiting with the dead-family verdict",
      );
      expect(anyDead).toBe(5);

      fs.writeFileSync(stopFile, "stop");
    },
    120_000,
  );

  it(
    "plant 2: lock disabled with grace ON ⇒ redundant rotations become observable (grace hits rise)",
    async () => {
      // The green run asserts graceHits === 0; removing ONLY the lock must make that same
      // counter rise — the D10 window absorbing the raced replays the lock would have prevented
      // (03 F8 "any process that raced anyway is absorbed by the D10 window").
      const as = newFakeAs({ graceWindowMs: 30_000, accessTokenTtlSeconds: 1, responseDelayMs: 40 });
      await as.start();
      const storeDir = makeStoreDir();
      seedStore(storeDir, as);

      const eventsFile = path.join(storeDir, "events.log");
      const stopFile = path.join(storeDir, "stop");
      const skewMs = 800;
      const loopDelayMs = 15;
      const maxDurationMs = 90_000;

      [0, 1].forEach(() =>
        spawnTsWorker({
          mode: "hammer",
          storeDir,
          eventsFile,
          serverBase: as.baseUrl,
          clientId: CLIENT_ID,
          skewMs,
          loopDelayMs,
          maxDurationMs,
          stopFile,
          noLock: true,
          scaled: null,
        }),
      );
      [0, 1].forEach(() =>
        spawnCsWorker(csHammerArgs("hammer-nolock", storeDir, as.baseUrl, skewMs, loopDelayMs, maxDurationMs, stopFile)),
      );

      await pollUntil(() => as.counters.graceHits >= 3, 60_000, "≥3 D10 grace hits at the fake AS");
      expect(as.counters.graceHits).toBeGreaterThanOrEqual(3);
      if (as.counters.familyRevokes > 0) {
        // Possible in principle (an older-generation replay is outside the D10 carve-out) but
        // not this plant's assertion; surface it for the log rather than failing.
        console.warn(`plant 2 observed ${as.counters.familyRevokes} family revoke(s) alongside the grace hits`);
      }

      fs.writeFileSync(stopFile, "stop");
    },
    120_000,
  );

  it(
    "plant 3a (lost response): TS client killed between AS commit and response; C# retry within the window succeeds idempotently",
    async () => {
      const as = newFakeAs({ graceWindowMs: 30_000, accessTokenTtlSeconds: 2 });
      await as.start();
      const storeDir = makeStoreDir();
      const seeded = seedStore(storeDir, as, { expired: true });

      const eventsFile = path.join(storeDir, "events.log");
      const hold = as.holdNextRotation();

      // The victim: a REAL one-shot refresh (real constants). The AS commits its rotation and
      // withholds the response; the kill lands exactly in the lost-response window, leaving the
      // predecessor in the store and the victim's orphan lock on disk.
      const victim = spawnTsWorker({
        mode: "once",
        storeDir,
        eventsFile,
        serverBase: as.baseUrl,
        clientId: CLIENT_ID,
        skewMs: 60_000,
        loopDelayMs: 25,
        maxDurationMs: 60_000,
        stopFile: path.join(storeDir, "stop"),
        noLock: false,
        scaled: null,
      });
      const committed = await withTimeout(hold.committed, 30_000, "the AS committing the victim's rotation");
      const committedAtMs = Date.now();
      victim.kill("SIGKILL");
      await exited(victim);
      hold.abandon(); // the response is now lost forever

      // The lost-response state: the store still holds the PREDECESSOR; the orphan lock remains.
      expect(readStorePluginFamily(storeDir).refreshToken).toBe(seeded.refreshToken);
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_FILE_NAME))).toBe(true);
      const rotationsAfterVictim = as.counters.rotations;

      // The retry — from the OTHER language: C# takes over the dead TS process's orphan lock
      // with SCALED constants (2 s < 5 s < 10 s, ordering asserted here and inside the harness;
      // the REAL 60 s staleness would outlive the 30 s window by design — the scaled variant
      // compresses the takeover, not the protocol) and re-presents the predecessor.
      const retry = spawnCsWorker([
        "once",
        storeDir,
        as.baseUrl,
        CLIENT_ID,
        "--scaled",
        `${SCALED.timeoutMs},${SCALED.staleMs},${SCALED.budgetMs}`,
      ]);
      const retryExit = await withTimeout(exited(retry.child), 60_000, "the C# retry completing");
      expect(retryExit, `C# retry exit (stdout: ${retry.stdout.join(" | ")})`).toEqual({ code: 0, signal: null });
      expect(Date.now() - committedAtMs, "the retry landed WITHIN the D10 window").toBeLessThan(30_000);

      // Idempotent BY VALUE: the grace hit returned the exact successor pair the killed client
      // never received — no revoke, and NO second rotation was performed.
      expect(as.counters.graceHits).toBe(1);
      expect(as.counters.familyRevokes).toBe(0);
      expect(as.counters.rotations).toBe(rotationsAfterVictim);
      const family = readStorePluginFamily(storeDir);
      expect(family.refreshToken).toBe(committed.refreshToken);
      expect(family.accessToken).toBe(committed.accessToken);
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_FILE_NAME))).toBe(false);
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_TAKEOVER_FILE_NAME))).toBe(false);
    },
    120_000,
  );

  it(
    "plant 3b (lost response, mirrored): C# client killed between AS commit and response; TS retry within the window succeeds idempotently",
    async () => {
      const as = newFakeAs({ graceWindowMs: 30_000, accessTokenTtlSeconds: 2 });
      await as.start();
      const storeDir = makeStoreDir();
      const seeded = seedStore(storeDir, as, { expired: true });

      const hold = as.holdNextRotation();
      const victim = spawnCsWorker(["once", storeDir, as.baseUrl, CLIENT_ID]);
      const committed = await withTimeout(hold.committed, 30_000, "the AS committing the victim's rotation");
      const committedAtMs = Date.now();
      victim.child.kill("SIGKILL");
      await exited(victim.child);
      hold.abandon();

      expect(readStorePluginFamily(storeDir).refreshToken).toBe(seeded.refreshToken);
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_FILE_NAME))).toBe(true);
      const rotationsAfterVictim = as.counters.rotations;

      const eventsFile = path.join(storeDir, "events.log");
      const retry = spawnTsWorker({
        mode: "once",
        storeDir,
        eventsFile,
        serverBase: as.baseUrl,
        clientId: CLIENT_ID,
        skewMs: 60_000,
        loopDelayMs: 25,
        maxDurationMs: 60_000,
        stopFile: path.join(storeDir, "stop"),
        noLock: false,
        scaled: SCALED,
      });
      const retryExit = await withTimeout(exited(retry), 60_000, "the TS retry completing");
      expect(retryExit, "TS retry exit").toEqual({ code: 0, signal: null });
      expect(Date.now() - committedAtMs, "the retry landed WITHIN the D10 window").toBeLessThan(30_000);

      expect(as.counters.graceHits).toBe(1);
      expect(as.counters.familyRevokes).toBe(0);
      expect(as.counters.rotations).toBe(rotationsAfterVictim);
      const family = readStorePluginFamily(storeDir);
      expect(family.refreshToken).toBe(committed.refreshToken);
      expect(family.accessToken).toBe(committed.accessToken);
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_FILE_NAME))).toBe(false);
      expect(fs.existsSync(path.join(storeDir, CREDENTIALS_LOCK_TAKEOVER_FILE_NAME))).toBe(false);
    },
    120_000,
  );
});
