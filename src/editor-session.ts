import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isErrno, writeFileAtomicSync } from "./atomic-file.js";
import { CredentialLockBusyError, MachineCredentialLock } from "./credential-lock.js";
import type { EditorSessionMode, EngineAdapter, EngineId } from "./engine-adapter.js";
import { powerShellHostCandidates } from "./machine-credentials.js";

/**
 * Editor sessions for CLI commands that need a running editor (`exec`, `open --headless`,
 * `close --owned-only`) — Code-Exec plan §4.6. Engine-agnostic: every engine difference comes
 * from the adapter's {@link EngineAdapter.editor} spec and the CLI-supplied binary and probe.
 *
 * Policy:
 *  - A live editor of the project — ours or the user's — is reused and never closed by us.
 *  - None: start our own (headless by default), passing {@link SESSION_ENV} so the plugin quits
 *    by itself after the idle timeout, record a lease, and wait until the readiness probe answers.
 *  - The lease `<project>/.ai-game-dev/session.json` marks the editor as OURS. Only an editor whose
 *    lease is valid (same host, pid alive, and the pid's process start time still the one recorded
 *    at launch — so a reused pid never matches) is ever closed automatically.
 *  - One start per project: the decide-and-launch step runs under the
 *    `<project>/.ai-game-dev/session.lock` file lock (the {@link MachineCredentialLock} protocol).
 *    It is held only until the lease is written; concurrent callers then find the lease and wait
 *    for readiness instead of launching a second editor.
 */

/** Project-relative directory of the lease and the startup lock. */
export const SESSION_DIR_NAME = ".ai-game-dev";
/** File name of the session lease. */
export const SESSION_LEASE_FILE_NAME = "session.json";
/** File name of the startup lock. */
export const SESSION_LOCK_FILE_NAME = "session.lock";

/** Environment a CLI-started editor receives (the same names for every engine). */
export const SESSION_ENV = {
  /** Seconds without a tool call after which the plugin closes the editor (saving as configured). */
  idleSeconds: "AIGD_SESSION_IDLE_SECONDS",
  /** `cli`: the editor was started by a CLI session (not by the user). */
  owner: "AIGD_SESSION_OWNER",
  /** The lease nonce, so the plugin can tell its own lease apart (e.g. to remove it on exit). */
  nonce: "AIGD_SESSION_NONCE",
} as const;

/** Default idle timeout passed to a started editor. */
export const DEFAULT_SESSION_IDLE_SECONDS = 300;
/** Default time to wait for a started editor's readiness probe. */
export const DEFAULT_SESSION_READY_TIMEOUT_MS = 300_000;
/** Default delay between readiness probes. */
export const DEFAULT_SESSION_READY_INTERVAL_MS = 2_000;
/** Default time `closeOwned` waits for the editor to exit after the polite request. */
export const DEFAULT_SESSION_CLOSE_TIMEOUT_MS = 30_000;

/** The lease document (`.ai-game-dev/session.json`). */
export interface SessionLease {
  /** Editor process id. */
  pid: number;
  /** Random per-launch id; identifies this lease in compare-and-delete and to the plugin. */
  nonce: string;
  engine: EngineId;
  mode: EditorSessionMode;
  /** ISO-8601 instant the CLI started the editor. */
  startedAt: string;
  ownedBy: "cli";
  /** Machine that started the editor (pids are only meaningful there). */
  hostId: string;
  /** OS process start time of `pid` at launch (opaque); a different value means the pid was reused. */
  processStart?: string;
}

/** OS process primitives used by a session. Injectable for tests. */
export interface SessionProcessOps {
  /** Start `command` detached from this process; resolves its pid once spawned. */
  spawnDetached(
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; hideWindow: boolean },
  ): Promise<number>;
  isAlive(pid: number): boolean;
  /** An opaque token for the process start time of `pid`; undefined when it cannot be read. */
  processStart(pid: number): Promise<string | undefined>;
  /** The OS polite-quit request (SIGTERM / `taskkill` without `/F`). */
  requestClose(pid: number): Promise<boolean>;
  /** Kill outright (SIGKILL / `taskkill /F`). */
  forceKill(pid: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

/** Why a session could not provide a ready editor. */
export type EditorSessionErrorReason =
  /** The adapter has no {@link EngineAdapter.editor} spec (the engine is not launched by a CLI). */
  | "unsupported"
  /** No editor binary was given or it could not be resolved. */
  | "no-editor-binary"
  /** The editor process could not be started. */
  | "launch-failed"
  /** The editor exited before its readiness probe answered. */
  | "exited"
  /** The readiness probe did not answer in time. */
  | "not-ready"
  /** The startup lock stayed held by another process for the whole acquire budget. */
  | "lock-busy";

export class EditorSessionError extends Error {
  readonly reason: EditorSessionErrorReason;
  constructor(reason: EditorSessionErrorReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EditorSessionError";
    this.reason = reason;
  }
}

export interface EditorSessionOptions<TReady> {
  adapter: EngineAdapter;
  projectRoot: string;
  /**
   * One readiness check: resolve a value (e.g. the server URL that answered) when the editor's MCP
   * server is up, undefined when not yet. Should return quickly (it is also the warm-path check).
   * {@link mcpReadinessProbe} builds the standard one.
   */
  probeReady: () => Promise<TReady | undefined>;
  /** The editor executable, or a resolver (called only when an editor has to be started). */
  editorBinary?: string | (() => string | Promise<string>);
  /** Extra environment for a started editor (engine-specific connection settings). */
  env?: Record<string, string>;
  /** Extra editor arguments appended after the adapter's. */
  extraArgs?: readonly string[];
  /** Idle seconds passed as {@link SESSION_ENV}.idleSeconds; `0` passes none. Default 300. */
  idleSeconds?: number;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  /** Progress messages ("Starting the editor (headless)..."). */
  onStatus?: (message: string) => void;
  /** Machine id written into the lease. Default `os.hostname()`. */
  hostId?: string;
  /** Overrides of the OS process primitives (tests). */
  processOps?: Partial<SessionProcessOps>;
  /** TEST-ONLY timing overrides of the startup lock (production keeps the protocol defaults). */
  lockTiming?: { staleMs?: number; acquireBudgetMs?: number; maxBackoffMs?: number };
}

/** How {@link EditorSession.ensure} got its editor. */
export type EnsureSource =
  /** An editor (ours or not) answered the readiness probe right away. */
  | "running"
  /** An editor not started by a CLI session had the project open; we waited for it. */
  | "foreign"
  /** An editor started by another CLI call (valid lease); we waited for it. */
  | "owned"
  /** This call started the editor. */
  | "started";

export interface EnsureResult<TReady> {
  /** What the readiness probe returned. */
  ready: TReady;
  source: EnsureSource;
  /** The lease, for `owned` / `started`. */
  lease?: SessionLease;
}

export type CloseOwnedResult =
  /** Our editor exited; the lease was removed. */
  | { kind: "closed"; pid: number; forced: boolean }
  /** No valid lease: nothing of ours is running (a stale lease was removed). Foreign editors are never touched. */
  | { kind: "not-owned"; staleLeaseRemoved: boolean }
  /** Our editor did not exit within the timeout (and `force` was not set or did not work). */
  | { kind: "still-running"; pid: number };

export type PrepareWindowResult =
  /** Open the GUI now; `stoppedPid` is our headless editor that was closed first. */
  | { kind: "proceed"; stoppedPid?: number }
  /** Our session already runs with a window. */
  | { kind: "already-open"; pid: number }
  /** Our headless editor did not exit in time; opening a second editor would fail. */
  | { kind: "still-running"; pid: number };

/** Build the session environment for a started editor. */
export function buildSessionEnv(nonce: string, idleSeconds: number): Record<string, string> {
  if (!Number.isInteger(idleSeconds) || idleSeconds < 0) {
    throw new Error("idleSeconds must be a non-negative whole number");
  }
  return {
    [SESSION_ENV.owner]: "cli",
    [SESSION_ENV.nonce]: nonce,
    ...(idleSeconds > 0 ? { [SESSION_ENV.idleSeconds]: String(idleSeconds) } : {}),
  };
}

/** Parse a lease document; undefined when unparseable or mis-shaped. */
export function parseSessionLease(text: string): SessionLease | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  if (
    typeof r["pid"] !== "number" ||
    !Number.isInteger(r["pid"]) ||
    r["pid"] <= 0 ||
    typeof r["nonce"] !== "string" ||
    typeof r["engine"] !== "string" ||
    (r["mode"] !== "headless" && r["mode"] !== "window") ||
    typeof r["startedAt"] !== "string" ||
    r["ownedBy"] !== "cli" ||
    typeof r["hostId"] !== "string"
  ) {
    return undefined;
  }
  return {
    pid: r["pid"],
    nonce: r["nonce"],
    engine: r["engine"] as EngineId,
    mode: r["mode"],
    startedAt: r["startedAt"],
    ownedBy: "cli",
    hostId: r["hostId"],
    ...(typeof r["processStart"] === "string" ? { processStart: r["processStart"] } : {}),
  };
}

/**
 * A project's editor session. Cheap to construct; every method re-reads the lease, so several
 * instances (and processes) can work on one project at once.
 */
export class EditorSession<TReady = unknown> {
  readonly projectRoot: string;
  readonly leasePath: string;
  readonly lockPath: string;
  private readonly _options: EditorSessionOptions<TReady>;
  private readonly _ops: SessionProcessOps;
  private readonly _hostId: string;

  constructor(options: EditorSessionOptions<TReady>) {
    this._options = options;
    this.projectRoot = path.resolve(options.projectRoot);
    const dir = path.join(this.projectRoot, SESSION_DIR_NAME);
    this.leasePath = path.join(dir, SESSION_LEASE_FILE_NAME);
    this.lockPath = path.join(dir, SESSION_LOCK_FILE_NAME);
    this._ops = { ...defaultSessionProcessOps, ...options.processOps };
    this._hostId = options.hostId ?? os.hostname();
  }

  /** The lease as stored (not validated); undefined when absent or unreadable. */
  readLease(): SessionLease | undefined {
    let text: string;
    try {
      text = fs.readFileSync(this.leasePath, "utf-8");
    } catch {
      return undefined;
    }
    return parseSessionLease(text);
  }

  /** The lease when it describes a live editor started by a CLI session on this machine. */
  async ownedSession(): Promise<SessionLease | undefined> {
    const lease = this.readLease();
    return lease !== undefined && (await this.isLive(lease)) ? lease : undefined;
  }

  /**
   * Make sure an editor of the project is running and ready (the `exec` policy): reuse any live
   * editor, otherwise start one in `mode` (default headless) and wait for readiness. Throws
   * {@link EditorSessionError}.
   */
  async ensure(options: { mode?: EditorSessionMode } = {}): Promise<EnsureResult<TReady>> {
    const warm = await this._options.probeReady();
    if (warm !== undefined) return { ready: warm, source: "running" };

    const spec = this.requireSpec();
    const mode = options.mode ?? "headless";
    let binary: string | undefined;
    // One retry: a leased editor that dies while we wait for it (it was idling out) is replaced.
    for (let attempt = 0; ; attempt++) {
      const joined = await this.ownedSession();
      if (joined !== undefined) {
        const ready = await this.waitForLeased(joined, attempt > 0);
        if (ready !== undefined) return { ready, source: "owned", lease: joined };
        continue;
      }

      binary ??= await this.resolveBinary();
      const outcome = await this.withStartupLock(async (): Promise<StartOutcome> => {
        const lease = await this.ownedSession();
        if (lease !== undefined) return { kind: "join", lease };
        if (await spec.findRunningEditor?.(this.projectRoot)) return { kind: "foreign" };
        this.removeStaleLease();
        return { kind: "started", lease: await this.launch(binary!, spec.args(this.projectRoot, mode), mode) };
      });

      if (outcome.kind === "foreign") {
        this.status("Waiting for the running editor...");
        return { ready: await this.waitReady(), source: "foreign" };
      }
      if (outcome.kind === "join") {
        const ready = await this.waitForLeased(outcome.lease, attempt > 0);
        if (ready !== undefined) return { ready, source: "owned", lease: outcome.lease };
        continue;
      }
      try {
        return { ready: await this.waitReady(outcome.lease.pid), source: "started", lease: outcome.lease };
      } catch (err) {
        if (!this._ops.isAlive(outcome.lease.pid)) this.removeLease(outcome.lease.nonce);
        throw err;
      }
    }
  }

  /**
   * `close --owned-only`: politely close the editor only when our valid lease names it. A foreign
   * editor (no lease, a stale lease, a reused pid, another machine) is never touched.
   */
  async closeOwned(options: { timeoutMs?: number; force?: boolean } = {}): Promise<CloseOwnedResult> {
    const lease = this.readLease();
    if (lease === undefined) return { kind: "not-owned", staleLeaseRemoved: false };
    if (!(await this.isLive(lease))) {
      return { kind: "not-owned", staleLeaseRemoved: this.removeStaleLease() };
    }
    const pid = lease.pid;
    const requestClose = this._options.adapter.editor?.requestClose;
    const delivered = requestClose ? await requestClose(pid, this.projectRoot) : await this._ops.requestClose(pid);

    // An undelivered request (e.g. WM_CLOSE to a windowless process) is not worth waiting for.
    let exited = delivered
      ? await this.waitForExit(pid, options.timeoutMs ?? DEFAULT_SESSION_CLOSE_TIMEOUT_MS)
      : !this._ops.isAlive(pid);
    let forced = false;
    if (!exited && options.force === true) {
      // Re-check identity right before the kill: the pid must still be the editor we leased.
      if (await this.isLive(lease)) {
        forced = true;
        await this._ops.forceKill(pid);
        exited = await this.waitForExit(pid, 5_000);
      } else {
        exited = true;
      }
    }
    if (!exited) return { kind: "still-running", pid };
    this.removeLease(lease.nonce);
    return { kind: "closed", pid, forced };
  }

  /**
   * `open` with a window: if our headless editor holds the project, close it first so the caller
   * can open the GUI. A foreign editor is left alone (the caller's usual "already open" handling).
   */
  async prepareWindowOpen(options: { timeoutMs?: number; force?: boolean } = {}): Promise<PrepareWindowResult> {
    const lease = await this.ownedSession();
    if (lease === undefined) return { kind: "proceed" };
    if (lease.mode === "window") return { kind: "already-open", pid: lease.pid };
    this.status("Closing the headless editor started by the CLI...");
    const closed = await this.closeOwned(options);
    if (closed.kind === "still-running") return closed;
    return closed.kind === "closed" ? { kind: "proceed", stoppedPid: closed.pid } : { kind: "proceed" };
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────

  private requireSpec() {
    const spec = this._options.adapter.editor;
    if (spec === undefined) {
      throw new EditorSessionError(
        "unsupported",
        `the ${this._options.adapter.engine} adapter cannot start an editor (no editor launch spec)`,
      );
    }
    return spec;
  }

  private async resolveBinary(): Promise<string> {
    const source = this._options.editorBinary;
    let binary: string | undefined;
    try {
      binary = typeof source === "function" ? await source() : source;
    } catch (err) {
      throw new EditorSessionError("no-editor-binary", `could not find the editor: ${errorText(err)}`, { cause: err });
    }
    if (!binary) throw new EditorSessionError("no-editor-binary", "no editor binary given");
    return binary;
  }

  private async withStartupLock<T>(fn: () => Promise<T>): Promise<T> {
    const timing = this._options.lockTiming ?? {};
    const lock = new MachineCredentialLock(path.dirname(this.lockPath), {
      lockFileName: SESSION_LOCK_FILE_NAME,
      hostId: this._hostId,
      ...(timing.staleMs !== undefined ? { staleMs: timing.staleMs } : {}),
      ...(timing.acquireBudgetMs !== undefined ? { acquireBudgetMs: timing.acquireBudgetMs } : {}),
      ...(timing.maxBackoffMs !== undefined ? { maxBackoffMs: timing.maxBackoffMs } : {}),
    });
    try {
      return await lock.withLock(fn);
    } catch (err) {
      if (err instanceof CredentialLockBusyError) {
        throw new EditorSessionError(
          "lock-busy",
          `another process is starting the editor (${this.lockPath} stayed locked for ${err.waitedMs} ms)`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  private async launch(binary: string, engineArgs: string[], mode: EditorSessionMode): Promise<SessionLease> {
    const idleSeconds = this._options.idleSeconds ?? DEFAULT_SESSION_IDLE_SECONDS;
    const nonce = randomBytes(16).toString("hex");
    const env = { ...process.env, ...this._options.env, ...buildSessionEnv(nonce, idleSeconds) };
    this.status(mode === "headless" ? "Starting the editor (headless)..." : "Starting the editor...");
    let pid: number;
    try {
      pid = await this._ops.spawnDetached(binary, [...engineArgs, ...(this._options.extraArgs ?? [])], {
        cwd: this.projectRoot,
        env,
        hideWindow: mode === "headless",
      });
    } catch (err) {
      throw new EditorSessionError("launch-failed", `could not start ${binary}: ${errorText(err)}`, { cause: err });
    }
    const processStart = await this._ops.processStart(pid);
    const lease: SessionLease = {
      pid,
      nonce,
      engine: this._options.adapter.engine,
      mode,
      startedAt: new Date().toISOString(),
      ownedBy: "cli",
      hostId: this._hostId,
      ...(processStart !== undefined ? { processStart } : {}),
    };
    writeFileAtomicSync(this.leasePath, Buffer.from(JSON.stringify(lease, null, 2) + "\n", "utf-8"));
    if (idleSeconds > 0) this.status(`Editor started (pid ${pid}); it quits after ${idleSeconds}s without tool calls.`);
    return lease;
  }

  /** Wait for an editor leased by another call; undefined when it died first (the caller may relaunch once). */
  private async waitForLeased(lease: SessionLease, lastAttempt: boolean): Promise<TReady | undefined> {
    this.status("Waiting for the editor started by another CLI call...");
    try {
      return await this.waitReady(lease.pid);
    } catch (err) {
      if (!lastAttempt && err instanceof EditorSessionError && err.reason === "exited") return undefined;
      throw err;
    }
  }

  private async waitReady(pid?: number): Promise<TReady> {
    const timeoutMs = this._options.readyTimeoutMs ?? DEFAULT_SESSION_READY_TIMEOUT_MS;
    const result = await waitForReady({
      probe: this._options.probeReady,
      timeoutMs,
      intervalMs: this._options.readyIntervalMs ?? DEFAULT_SESSION_READY_INTERVAL_MS,
      sleep: this._ops.sleep,
      ...(pid !== undefined
        ? {
            stopReason: () =>
              this._ops.isAlive(pid) ? undefined : `the editor (pid ${pid}) exited before it became ready; see its log`,
          }
        : {}),
    });
    if (result.kind === "ready") return result.value;
    throw new EditorSessionError(result.kind === "stopped" ? "exited" : "not-ready", result.message);
  }

  private async isLive(lease: SessionLease): Promise<boolean> {
    if (lease.hostId.toLowerCase() !== this._hostId.toLowerCase()) return false;
    if (!this._ops.isAlive(lease.pid)) return false;
    // Pid reuse: the recorded start time must still match. Unknown on either side = unverifiable,
    // which is treated as NOT ours — a lease never authorizes closing a process we cannot identify.
    if (lease.processStart === undefined) return false;
    return (await this._ops.processStart(lease.pid)) === lease.processStart;
  }

  /** Remove a lease that is not live (only one from this machine). Returns true when removed. */
  private removeStaleLease(): boolean {
    const lease = this.readLease();
    if (lease === undefined) {
      // An unparseable leftover is removed too; a well-formed foreign-host lease is not ours to judge.
      if (!fs.existsSync(this.leasePath)) return false;
      return unlinkQuietly(this.leasePath);
    }
    if (lease.hostId.toLowerCase() !== this._hostId.toLowerCase()) return false;
    return this.removeLease(lease.nonce);
  }

  /** Compare-and-delete: remove the lease only while it still carries `nonce`. */
  private removeLease(nonce: string): boolean {
    if (this.readLease()?.nonce !== nonce) return false;
    return unlinkQuietly(this.leasePath);
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!this._ops.isAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await this._ops.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    }
  }

  private status(message: string): void {
    this._options.onStatus?.(message);
  }
}

type StartOutcome =
  | { kind: "join"; lease: SessionLease }
  | { kind: "foreign" }
  | { kind: "started"; lease: SessionLease };

// ── readiness ─────────────────────────────────────────────────────────────────────────────────

export interface WaitForReadyOptions<T> {
  /** One check; a defined value ends the wait. A throw counts as "not yet". */
  probe: () => Promise<T | undefined>;
  timeoutMs: number;
  intervalMs: number;
  /** Checked before every probe; a message ends the wait as `stopped` (e.g. the editor exited). */
  stopReason?: () => string | undefined;
  sleep?: (ms: number) => Promise<void>;
}

export type WaitForReadyResult<T> =
  | { kind: "ready"; value: T; elapsedMs: number }
  | { kind: "stopped" | "timeout"; message: string; elapsedMs: number };

/** Poll `probe` until it yields a value, `stopReason` fires, or `timeoutMs` elapses. Never throws. */
export async function waitForReady<T>(options: WaitForReadyOptions<T>): Promise<WaitForReadyResult<T>> {
  const sleepFn = options.sleep ?? sleep;
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  if (!(options.timeoutMs >= 0) || !(options.intervalMs > 0)) {
    return { kind: "timeout", message: "timeoutMs must be >= 0 and intervalMs > 0", elapsedMs: 0 };
  }
  for (;;) {
    const stopped = options.stopReason?.();
    if (stopped !== undefined) return { kind: "stopped", message: stopped, elapsedMs: elapsed() };
    let value: T | undefined;
    try {
      value = await options.probe();
    } catch {
      value = undefined;
    }
    if (value !== undefined) return { kind: "ready", value, elapsedMs: elapsed() };
    const remaining = options.timeoutMs - elapsed();
    if (remaining <= 0) {
      return { kind: "timeout", message: `the editor did not become ready within ${options.timeoutMs} ms`, elapsedMs: elapsed() };
    }
    await sleepFn(Math.min(options.intervalMs, remaining));
  }
}

/** The MCP server's ping endpoint (a system tool, the same for every engine). */
export const MCP_PING_PATH = "/api/system-tools/ping";

export type McpProbeResult = { ok: true; baseUrl: string; data: unknown } | { ok: false; reason: string };

/** One POST to `<baseUrl>/api/system-tools/ping`. Never throws. */
export async function probeMcpServer(
  baseUrl: string,
  options: { token?: string; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<McpProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  const base = baseUrl.replace(/\/+$/, "");
  try {
    const response = await doFetch(`${base}${MCP_PING_PATH}`, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain-text answer */
    }
    return { ok: true, baseUrl, data };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  }
}

/**
 * The standard readiness probe for {@link EditorSessionOptions.probeReady}: ping every URL at once
 * and resolve the first that answers (undefined when none does).
 */
export function mcpReadinessProbe(options: {
  urls: readonly string[];
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): () => Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return () =>
    new Promise<string | undefined>((resolve) => {
      let pending = options.urls.length;
      if (pending === 0) resolve(undefined);
      for (const url of options.urls) {
        void probeMcpServer(url, { ...options, timeoutMs }).then((result) => {
          if (result.ok) resolve(result.baseUrl);
          else if (--pending === 0) resolve(undefined);
        });
      }
    });
}

// ── default OS process primitives ─────────────────────────────────────────────────────────────

const isWindows = process.platform === "win32";

/** True when `pid` names a running process (EPERM = exists, not ours to signal). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrno(err, "EPERM");
  }
}

/**
 * An opaque token for the start time of `pid` (Linux `/proc/<pid>/stat` starttime, macOS
 * `ps -o lstart=`, Windows `Get-Process` StartTime ticks); undefined when it cannot be read.
 */
export async function readProcessStart(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Field 22 (starttime); the command name (field 2) may contain spaces, so split after its ")".
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = fields[19];
      return ticks ? `linux:${ticks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (isWindows) {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    for (const host of powerShellHostCandidates()) {
      try {
        const out = (await execFileText(host, ["-NoProfile", "-NonInteractive", "-Command", script], 30_000)).trim();
        return /^\d+$/.test(out) ? `win:${out}` : undefined;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES") continue; // this host is missing — try the next
        return undefined;
      }
    }
    return undefined;
  }
  try {
    const out = (await execFileText("ps", ["-o", "lstart=", "-p", String(pid)], 10_000)).trim();
    return out ? `ps:${out}` : undefined;
  } catch {
    return undefined;
  }
}

function execFileText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf-8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function signalProcess(pid: number, force: boolean): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  try {
    if (isWindows) {
      await execFileText("taskkill", [...(force ? ["/F"] : []), "/PID", String(pid)], 10_000);
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
    return true;
  } catch {
    return !isProcessAlive(pid); // it may have exited between the check and the signal
  }
}

/** The real OS primitives. */
export const defaultSessionProcessOps: SessionProcessOps = {
  spawnDetached: (command, args, options) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: "ignore",
        windowsHide: options.hideWindow,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        if (child.pid === undefined) reject(new Error("the process started without a pid"));
        else resolve(child.pid);
      });
    }),
  isAlive: isProcessAlive,
  processStart: readProcessStart,
  requestClose: (pid) => signalProcess(pid, false),
  forceKill: (pid) => signalProcess(pid, true),
  sleep,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unlinkQuietly(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
