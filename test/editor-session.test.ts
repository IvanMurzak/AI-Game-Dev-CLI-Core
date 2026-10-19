import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EditorSession,
  EditorSessionError,
  SESSION_DIR_NAME,
  SESSION_ENV,
  SESSION_LEASE_FILE_NAME,
  SESSION_LOCK_FILE_NAME,
  buildSessionEnv,
  parseSessionLease,
  waitForReady,
  type EditorSessionOptions,
  type SessionLease,
  type SessionProcessOps,
} from "../src/editor-session.js";
import { godotAdapter, unityAdapter, type EngineAdapter } from "../src/engine-adapter.js";
import { MCP_PING_PATH, mcpReadinessProbe } from "../src/mcp-ping.js";

/** An in-memory process table standing in for the OS. One world is shared by all sessions of a test. */
class FakeWorld {
  private nextPid = 4000;
  readonly procs = new Map<number, { alive: boolean; start: string; ready: boolean }>();
  readonly spawns: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv; hideWindow: boolean }> = [];
  readonly closeRequests: number[] = [];
  readonly kills: number[] = [];
  /** Editors become ready this long after spawning; undefined = never. */
  readyAfterMs: number | undefined = 30;
  /** Editors exit on the polite request (false = ignore it, like a windowless process on Windows). */
  honorsClose = true;
  spawnDelayMs = 25;

  /** A process that exists but was not started by a session (the user's editor, or a pid reuse). */
  addProcess(start = "foreign-start"): number {
    const pid = this.nextPid++;
    this.procs.set(pid, { alive: true, start, ready: false });
    return pid;
  }

  get readyCount(): number {
    return [...this.procs.values()].filter((p) => p.alive && p.ready).length;
  }

  probe = async (): Promise<string | undefined> => (this.readyCount > 0 ? "http://localhost:1234" : undefined);

  ops(): Partial<SessionProcessOps> {
    return {
      spawnDetached: async (command, args, options) => {
        await sleep(this.spawnDelayMs);
        const pid = this.nextPid++;
        const proc = { alive: true, start: `start-${pid}`, ready: false };
        this.procs.set(pid, proc);
        this.spawns.push({ command, args, env: options.env, hideWindow: options.hideWindow });
        if (this.readyAfterMs !== undefined) setTimeout(() => (proc.ready = true), this.readyAfterMs);
        return pid;
      },
      isAlive: (pid) => this.procs.get(pid)?.alive === true,
      processStart: async (pid) => (this.procs.get(pid)?.alive ? this.procs.get(pid)!.start : undefined),
      requestClose: async (pid) => {
        this.closeRequests.push(pid);
        const proc = this.procs.get(pid);
        if (proc && this.honorsClose) proc.alive = false;
        return this.honorsClose;
      },
      forceKill: async (pid) => {
        this.kills.push(pid);
        const proc = this.procs.get(pid);
        if (proc) proc.alive = false;
        return true;
      },
      sleep: (ms) => sleep(Math.min(ms, 10)),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let root: string;
let world: FakeWorld;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-session-"));
  world = new FakeWorld();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function session(overrides: Partial<EditorSessionOptions<string>> = {}): EditorSession<string> {
  return new EditorSession<string>({
    adapter: unityAdapter,
    projectRoot: root,
    probeReady: world.probe,
    editorBinary: "/opt/unity/Editor",
    readyIntervalMs: 5,
    readyTimeoutMs: 5_000,
    hostId: "host-a",
    processOps: world.ops(),
    lockTiming: { maxBackoffMs: 10 },
    ...overrides,
  });
}

function writeLease(lease: Partial<SessionLease> & { pid: number }): void {
  const full: SessionLease = {
    nonce: "n0",
    engine: "unity",
    mode: "headless",
    startedAt: new Date().toISOString(),
    ownedBy: "cli",
    hostId: "host-a",
    processStart: world.procs.get(lease.pid)?.start ?? "gone",
    ...lease,
  };
  fs.mkdirSync(sessionDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionDir(), SESSION_LEASE_FILE_NAME), JSON.stringify(full));
}

function sessionDir(): string {
  return path.join(root, SESSION_DIR_NAME);
}

/** A startup lock held by a peer (fresh, or aged to `mtime`). */
function writeLockFile(mtime?: Date): string {
  const lockPath = path.join(sessionDir(), SESSION_LOCK_FILE_NAME);
  fs.mkdirSync(sessionDir(), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), hostId: "host-a", nonce: "x" }));
  if (mtime) fs.utimesSync(lockPath, mtime, mtime);
  return lockPath;
}

/** The EditorSessionError reason a promise rejects with (fails the test if it resolves). */
async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EditorSessionError);
  return (err as EditorSessionError).reason;
}

describe("EditorSession.ensure", () => {
  it("cold start: launches one headless editor with the session env and writes the lease", async () => {
    const s = session({ env: { UNITY_MCP_KEEP_CONNECTED: "true" }, idleSeconds: 120 });
    const result = await s.ensure();

    expect(result.source).toBe("started");
    expect(result.ready).toBe("http://localhost:1234");
    expect(world.spawns).toHaveLength(1);
    const spawn = world.spawns[0]!;
    expect(spawn.command).toBe("/opt/unity/Editor");
    expect(spawn.args).toEqual(["-batchmode", "-projectPath", path.resolve(root)]);
    expect(spawn.hideWindow).toBe(true);
    expect(spawn.env[SESSION_ENV.owner]).toBe("cli");
    expect(spawn.env[SESSION_ENV.idleSeconds]).toBe("120");
    expect(spawn.env["UNITY_MCP_KEEP_CONNECTED"]).toBe("true");

    const lease = s.readLease()!;
    expect(lease).toMatchObject({ engine: "unity", mode: "headless", ownedBy: "cli", hostId: "host-a" });
    expect(lease.pid).toBe(result.lease!.pid);
    expect(spawn.env[SESSION_ENV.nonce]).toBe(lease.nonce);
    expect(lease.processStart).toBe(`start-${lease.pid}`);
    expect(await s.ownedSession()).toEqual(lease);
  });

  it("window mode uses the window args and does not hide the window", async () => {
    const result = await session({ adapter: godotAdapter }).ensure({ mode: "window" });
    expect(result.lease!.mode).toBe("window");
    expect(world.spawns[0]!.args).toEqual(["--editor", "--path", path.resolve(root)]);
    expect(world.spawns[0]!.hideWindow).toBe(false);
  });

  it("warm: an editor that answers the probe is reused without launching", async () => {
    world.procs.get(world.addProcess())!.ready = true;
    let resolved = false;
    const result = await session({
      editorBinary: () => {
        resolved = true;
        return "/x";
      },
    }).ensure();
    expect(result.source).toBe("running");
    expect(world.spawns).toHaveLength(0);
    expect(resolved).toBe(false);
  });

  it("race: two parallel cold starts launch exactly one editor", async () => {
    const [a, b] = await Promise.all([session().ensure(), session().ensure()]);
    expect(world.spawns).toHaveLength(1);
    expect([a.source, b.source].sort()).toEqual(["owned", "started"]);
    expect(a.ready).toBe("http://localhost:1234");
    expect(b.ready).toBe("http://localhost:1234");
  });

  it("race: eight parallel cold starts launch exactly one editor", async () => {
    world.spawnDelayMs = 60;
    const results = await Promise.all(Array.from({ length: 8 }, () => session().ensure()));
    expect(world.spawns).toHaveLength(1);
    expect(results.filter((r) => r.source === "started")).toHaveLength(1);
    for (const r of results) expect(["owned", "started", "running"]).toContain(r.source);
  });

  it("joins an editor another call is still starting (valid lease, not ready yet)", async () => {
    world.readyAfterMs = undefined;
    const first = session().ensure({ mode: "headless" });
    await sleep(80); // the first call has launched and written the lease
    const pid = session().readLease()!.pid;
    const second = session().ensure();
    await sleep(30);
    world.procs.get(pid)!.ready = true;
    const [a, b] = await Promise.all([first, second]);
    expect(world.spawns).toHaveLength(1);
    expect(a.source).toBe("started");
    expect(b.source).toBe("owned");
  });

  it("a foreign editor that is still loading is waited for, never replaced", async () => {
    const foreignPid = world.addProcess();
    const s = session({
      adapter: { ...unityAdapter, editor: { ...unityAdapter.editor!, findRunningEditor: async () => true } },
    });
    setTimeout(() => (world.procs.get(foreignPid)!.ready = true), 40);
    const result = await s.ensure();
    expect(result.source).toBe("foreign");
    expect(world.spawns).toHaveLength(0);
    expect(s.readLease()).toBeUndefined();
  });

  it("stale lease (pid dead) is replaced by a fresh launch", async () => {
    const dead = world.addProcess();
    writeLease({ pid: dead, nonce: "old" });
    world.procs.get(dead)!.alive = false;
    const result = await session().ensure();
    expect(result.source).toBe("started");
    expect(world.spawns).toHaveLength(1);
    expect(session().readLease()!.nonce).not.toBe("old");
  });

  it("stale lease (pid reused by another process) is not trusted", async () => {
    const reused = world.addProcess("some-other-program");
    writeLease({ pid: reused, processStart: "the-editor-start" });
    const s = session();
    expect(await s.ownedSession()).toBeUndefined();
    const result = await s.ensure();
    expect(result.source).toBe("started");
    expect(world.procs.get(reused)!.alive).toBe(true);
  });

  it("a lease without a process start time is unverifiable and never trusted", async () => {
    const pid = world.addProcess();
    writeLease({ pid, processStart: undefined }); // JSON drops the undefined field
    expect(session().readLease()!.processStart).toBeUndefined();
    expect(await session().ownedSession()).toBeUndefined();
  });

  it("replaces a leased editor that exits while we wait for it (it was idling out)", async () => {
    world.readyAfterMs = undefined;
    const dying = world.addProcess();
    writeLease({ pid: dying });
    setTimeout(() => (world.procs.get(dying)!.alive = false), 30);
    world.readyAfterMs = 20;
    const result = await session().ensure();
    expect(result.source).toBe("started");
    expect(world.spawns).toHaveLength(1);
  });

  it("an editor that exits before it is ready fails with `exited` and its lease is removed", async () => {
    world.readyAfterMs = undefined;
    const s = session();
    const pending = s.ensure();
    await sleep(80);
    const lease = s.readLease()!;
    world.procs.get(lease.pid)!.alive = false;
    expect(await reasonOf(pending)).toBe("exited");
    expect(s.readLease()).toBeUndefined();
    expect(world.spawns).toHaveLength(1);
  });

  it("not-ready after the timeout", async () => {
    world.readyAfterMs = undefined;
    expect(await reasonOf(session({ readyTimeoutMs: 100 }).ensure())).toBe("not-ready");
  });

  it("launch failure and a missing binary are typed errors", async () => {
    const failing = session({
      processOps: { ...world.ops(), spawnDetached: async () => Promise.reject(new Error("ENOENT")) },
    });
    expect(await reasonOf(failing.ensure())).toBe("launch-failed");
    expect(await reasonOf(session({ editorBinary: undefined }).ensure())).toBe("no-editor-binary");
    const throwing = session({
      editorBinary: () => {
        throw new Error("Unity 6000.6 is not installed");
      },
    });
    const err = (await throwing.ensure().catch((e: unknown) => e)) as EditorSessionError;
    expect(err.reason).toBe("no-editor-binary");
    expect(err.message).toContain("6000.6");
  });

  it("an adapter without an editor spec is unsupported", async () => {
    const adapter: EngineAdapter = { ...unityAdapter, engine: "brutal" };
    delete (adapter as { editor?: unknown }).editor;
    expect(await reasonOf(session({ adapter }).ensure())).toBe("unsupported");
  });

  it("lock-busy when the startup lock stays held by a live peer", async () => {
    writeLockFile();
    expect(await reasonOf(session({ lockTiming: { acquireBudgetMs: 100, maxBackoffMs: 10 } }).ensure())).toBe("lock-busy");
    expect(world.spawns).toHaveLength(0);
  });

  it("recovers a stale startup lock left by a crashed CLI", async () => {
    const lockPath = writeLockFile(new Date(Date.now() - 120_000));
    const result = await session().ensure();
    expect(result.source).toBe("started");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe("EditorSession.closeOwned", () => {
  it("closes our editor and removes the lease", async () => {
    const s = session();
    const { lease } = await s.ensure();
    const result = await s.closeOwned();
    expect(result).toEqual({ kind: "closed", pid: lease!.pid, forced: false });
    expect(world.closeRequests).toEqual([lease!.pid]);
    expect(s.readLease()).toBeUndefined();
  });

  it("never closes a foreign editor (no lease)", async () => {
    const foreign = world.addProcess();
    world.procs.get(foreign)!.ready = true;
    const result = await session().closeOwned({ force: true });
    expect(result).toEqual({ kind: "not-owned", staleLeaseRemoved: false });
    expect(world.closeRequests).toHaveLength(0);
    expect(world.kills).toHaveLength(0);
    expect(world.procs.get(foreign)!.alive).toBe(true);
  });

  it("never closes a process that reused our lease's pid; removes the stale lease", async () => {
    const reused = world.addProcess("another-program");
    writeLease({ pid: reused, processStart: "our-editor" });
    const s = session();
    expect(await s.closeOwned({ force: true })).toEqual({ kind: "not-owned", staleLeaseRemoved: true });
    expect(world.closeRequests).toHaveLength(0);
    expect(world.kills).toHaveLength(0);
    expect(s.readLease()).toBeUndefined();
  });

  it("never closes or removes a lease written on another machine", async () => {
    const pid = world.addProcess();
    writeLease({ pid, hostId: "host-b" });
    const s = session();
    expect(await s.closeOwned({ force: true })).toEqual({ kind: "not-owned", staleLeaseRemoved: false });
    expect(world.closeRequests).toHaveLength(0);
    expect(s.readLease()).toBeDefined();
  });

  it("an editor that ignores the polite request is still-running, or force-killed with force", async () => {
    world.honorsClose = false;
    const s = session();
    const { lease } = await s.ensure();
    expect(await s.closeOwned({ timeoutMs: 50 })).toEqual({ kind: "still-running", pid: lease!.pid });
    expect(world.kills).toHaveLength(0);
    expect(await s.closeOwned({ timeoutMs: 50, force: true })).toEqual({ kind: "closed", pid: lease!.pid, forced: true });
    expect(world.kills).toEqual([lease!.pid]);
  });

  it("uses the adapter's requestClose when it has one", async () => {
    const asked: number[] = [];
    const adapter: EngineAdapter = {
      ...unityAdapter,
      editor: {
        ...unityAdapter.editor!,
        requestClose: async (pid) => {
          asked.push(pid);
          world.procs.get(pid)!.alive = false;
          return true;
        },
      },
    };
    const s = session({ adapter });
    const { lease } = await s.ensure();
    expect((await s.closeOwned()).kind).toBe("closed");
    expect(asked).toEqual([lease!.pid]);
    expect(world.closeRequests).toHaveLength(0);
  });
});

describe("EditorSession.prepareWindowOpen", () => {
  it("stops our headless editor so the GUI can open", async () => {
    const s = session();
    const { lease } = await s.ensure();
    expect(await s.prepareWindowOpen()).toEqual({ kind: "proceed", stoppedPid: lease!.pid });
    expect(world.procs.get(lease!.pid)!.alive).toBe(false);
  });

  it("reports our windowed session as already open", async () => {
    const s = session();
    const { lease } = await s.ensure({ mode: "window" });
    expect(await s.prepareWindowOpen()).toEqual({ kind: "already-open", pid: lease!.pid });
    expect(world.closeRequests).toHaveLength(0);
  });

  it("leaves a foreign editor alone", async () => {
    const foreign = world.addProcess();
    expect(await session().prepareWindowOpen()).toEqual({ kind: "proceed" });
    expect(world.procs.get(foreign)!.alive).toBe(true);
  });

  it("reports a headless editor that would not exit", async () => {
    world.honorsClose = false;
    const s = session();
    const { lease } = await s.ensure();
    expect(await s.prepareWindowOpen({ timeoutMs: 30 })).toEqual({ kind: "still-running", pid: lease!.pid });
  });
});

describe("mcpReadinessProbe", () => {
  it("resolves the first URL that answers the ping and aborts the others", async () => {
    const aborted: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(url.endsWith(MCP_PING_PATH)).toBe(true);
      if (url.startsWith("http://slow")) {
        return new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener("abort", () => {
            aborted.push(url);
            reject(new Error("aborted"));
          }),
        );
      }
      if (url.startsWith("http://down")) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const probe = mcpReadinessProbe({ urls: ["http://slow:1", "http://down:2", "http://up:3/"], fetchImpl });
    expect(await probe()).toBe("http://up:3/");
    await sleep(5);
    expect(aborted).toEqual([`http://slow:1${MCP_PING_PATH}`]);
    expect(await mcpReadinessProbe({ urls: ["http://down:2"], fetchImpl })()).toBeUndefined();
    expect(await mcpReadinessProbe({ urls: [], fetchImpl })()).toBeUndefined();
  });
});

describe("helpers", () => {
  it("buildSessionEnv", () => {
    expect(buildSessionEnv("abc", 300)).toEqual({
      AIGD_SESSION_OWNER: "cli",
      AIGD_SESSION_NONCE: "abc",
      AIGD_SESSION_IDLE_SECONDS: "300",
    });
    expect(buildSessionEnv("abc", 0)).not.toHaveProperty("AIGD_SESSION_IDLE_SECONDS");
    expect(() => buildSessionEnv("abc", 1.5)).toThrow();
  });

  it("parseSessionLease rejects mis-shaped documents", () => {
    expect(parseSessionLease("not json")).toBeUndefined();
    expect(parseSessionLease(JSON.stringify({ pid: 1 }))).toBeUndefined();
    const ok = { pid: 7, nonce: "n", engine: "godot", mode: "window", startedAt: "t", ownedBy: "cli", hostId: "h" };
    expect(parseSessionLease(JSON.stringify(ok))).toEqual(ok);
    expect(parseSessionLease(JSON.stringify({ ...ok, ownedBy: "user" }))).toBeUndefined();
    expect(parseSessionLease(JSON.stringify({ ...ok, pid: -1 }))).toBeUndefined();
  });

  it("waitForReady: ready / stopped / timeout, and a throwing probe counts as not yet", async () => {
    let n = 0;
    const ready = await waitForReady({
      probe: async () => {
        n++;
        if (n === 1) throw new Error("ECONNREFUSED");
        return n >= 3 ? "up" : undefined;
      },
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(ready).toMatchObject({ kind: "ready", value: "up" });
    const stopped = await waitForReady({ probe: async () => undefined, timeoutMs: 1_000, intervalMs: 1, stopReason: () => "gone" });
    expect(stopped).toMatchObject({ kind: "stopped", message: "gone" });
    const timeout = await waitForReady({ probe: async () => undefined, timeoutMs: 20, intervalMs: 5 });
    expect(timeout.kind).toBe("timeout");
    expect((await waitForReady({ probe: async () => 1, timeoutMs: Number.NaN, intervalMs: 1 })).kind).toBe("timeout");
  });
});
