import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeFileAtomicSync } from "./atomic-file.js";
import { CredentialLockBusyError, MachineCredentialLock } from "./credential-lock.js";
import type { EditorLaunchSpec, EditorSessionMode, EngineAdapter, EngineId } from "./engine-adapter.js";
import { errorMessage } from "./network-error.js";
import { isProcessAlive, readProcessStart, sleep, spawnDetached, terminateProcess } from "./process.js";

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
  /**
   * The editor executable, or a resolver. Resolution starts as soon as the warm readiness probe
   * fails (so it overlaps the startup lock), even when the call then joins an existing editor; its
   * result is used only when an editor has to be started.
   */
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
    // Resolved outside the lock (it can be slow: Unity Hub, registry lookups), awaited only to launch.
    const binary: BinaryRef = { promise: this.resolveBinary() };
    binary.promise.then(
      (value) => (binary.value = value),
      () => {}, // surfaced by the `await binary.promise` below, if a launch needs it
    );
    // A leased editor that dies while we wait for it (it was idling out) is replaced once.
    return (await this.attemptEnsure(spec, mode, binary, false)) ?? (await this.attemptEnsure(spec, mode, binary, true))!;
  }

  /** One decide-and-wait round; undefined when the leased editor we joined died (retry once). */
  private async attemptEnsure(
    spec: EditorLaunchSpec,
    mode: EditorSessionMode,
    binary: BinaryRef,
    lastAttempt: boolean,
  ): Promise<EnsureResult<TReady> | undefined> {
    const outcome = await this.withStartupLock(async (): Promise<StartOutcome> => {
      const lease = this.readLease();
      // An unverifiable lease never authorizes a close, but its editor may well be ours and still
      // starting: wait for it rather than launch a second editor into the same project.
      if (lease !== undefined && (await this.leaseState(lease)) !== "dead") return { kind: "join", lease };
      if (await spec.findRunningEditor?.(this.projectRoot)) return { kind: "foreign" };
      // Never wait for a slow resolver inside the lock (peers judge it stale after 60 s): leave,
      // resolve, and decide again.
      if (binary.value === undefined) return { kind: "resolve" };
      if (lease !== undefined) this.removeStaleLease(lease);
      return { kind: "started", lease: await this.launch(binary.value, spec, mode) };
    });

    if (outcome.kind === "resolve") {
      await binary.promise;
      return this.attemptEnsure(spec, mode, binary, lastAttempt);
    }

    if (outcome.kind === "foreign") {
      this.status("Waiting for the running editor...");
      return { ready: await this.waitReady(), source: "foreign" };
    }
    const { lease } = outcome;
    if (outcome.kind === "join") {
      this.status("Waiting for the editor started by another CLI call...");
      try {
        return { ready: await this.waitReady(lease.pid), source: "owned", lease };
      } catch (err) {
        if (!lastAttempt && err instanceof EditorSessionError && err.reason === "exited") return undefined;
        throw err;
      }
    }
    try {
      return { ready: await this.waitReady(lease.pid), source: "started", lease };
    } catch (err) {
      if (!this._ops.isAlive(lease.pid)) await this.removeLeaseLocked(lease.nonce);
      throw err;
    }
  }

  /**
   * `close --owned-only`: politely close the editor only when our valid lease names it. A foreign
   * editor (no lease, a stale lease, a reused pid, another machine) is never touched.
   */
  async closeOwned(options: CloseOptions = {}): Promise<CloseOwnedResult> {
    const lease = this.readLease();
    if (lease === undefined) return { kind: "not-owned", staleLeaseRemoved: false };
    const state = await this.leaseState(lease);
    if (state === "live") return this.closeLease(lease, options);
    // Unverifiable (pid alive, start time unknown): not ours to close, but not provably stale either.
    return {
      kind: "not-owned",
      staleLeaseRemoved: state === "dead" && this.isThisHost(lease) && (await this.removeLeaseLocked(lease.nonce)),
    };
  }

  /**
   * `open` with a window: if our headless editor holds the project, close it first so the caller
   * can open the GUI. A foreign editor is left alone (the caller's usual "already open" handling).
   */
  async prepareWindowOpen(options: CloseOptions = {}): Promise<PrepareWindowResult> {
    const lease = await this.ownedSession();
    if (lease === undefined) return { kind: "proceed" };
    if (lease.mode === "window") return { kind: "already-open", pid: lease.pid };
    this.status("Closing the headless editor started by the CLI...");
    const closed = await this.closeLease(lease, options);
    return closed.kind === "closed" ? { kind: "proceed", stoppedPid: closed.pid } : closed;
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

  /** Close the editor of a lease already verified live. */
  private async closeLease(
    lease: SessionLease,
    options: CloseOptions,
  ): Promise<Extract<CloseOwnedResult, { kind: "closed" | "still-running" }>> {
    const { pid } = lease;
    const requestClose = this._options.adapter.editor?.requestClose;
    const delivered = requestClose ? await requestClose(pid, this.projectRoot) : await this._ops.requestClose(pid);
    // An undelivered request (e.g. WM_CLOSE to a windowless process) is not worth waiting for.
    let exited = delivered
      ? await this.waitForExit(pid, options.timeoutMs ?? DEFAULT_SESSION_CLOSE_TIMEOUT_MS)
      : !this._ops.isAlive(pid);
    let forced = false;
    // Re-check identity right before the kill: the pid must still be the editor we leased.
    if (!exited && options.force === true && (await this.isLive(lease))) {
      forced = true;
      await this._ops.forceKill(pid);
      exited = await this.waitForExit(pid, 5_000);
    }
    if (!exited && this._ops.isAlive(pid)) return { kind: "still-running", pid };
    await this.removeLeaseLocked(lease.nonce);
    return { kind: "closed", pid, forced };
  }

  private async resolveBinary(): Promise<string> {
    const source = this._options.editorBinary;
    let binary: string | undefined;
    try {
      binary = typeof source === "function" ? await source() : source;
    } catch (err) {
      throw new EditorSessionError("no-editor-binary", `could not find the editor: ${errorMessage(err)}`, { cause: err });
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

  private async launch(binary: string, spec: EditorLaunchSpec, mode: EditorSessionMode): Promise<SessionLease> {
    let engineArgs: string[];
    try {
      engineArgs = spec.args(this.projectRoot, mode);
    } catch (err) {
      throw new EditorSessionError("launch-failed", `cannot build the editor command line: ${errorMessage(err)}`, {
        cause: err,
      });
    }
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
      throw new EditorSessionError("launch-failed", `could not start ${binary}: ${errorMessage(err)}`, { cause: err });
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
    return (await this.leaseState(lease)) === "live";
  }

  /**
   * `live`: same host, pid alive, and the recorded start time still matches (provably our editor).
   * `unverifiable`: same host and pid alive, but the start time is unknown on either side — NOT ours
   * (a lease never authorizes closing a process we cannot identify), yet not provably stale either.
   * `dead`: another host, the pid is gone, or the pid was reused (the start time differs).
   */
  private async leaseState(lease: SessionLease): Promise<"live" | "unverifiable" | "dead"> {
    if (!this.isThisHost(lease) || !this._ops.isAlive(lease.pid)) return "dead";
    if (lease.processStart === undefined) return "unverifiable";
    const current = await this._ops.processStart(lease.pid);
    if (current === undefined) return "unverifiable";
    return current === lease.processStart ? "live" : "dead";
  }

  private isThisHost(lease: SessionLease): boolean {
    return lease.hostId.toLowerCase() === this._hostId.toLowerCase();
  }

  /** Remove a lease that is not live — only one written on this machine. Returns true when removed. */
  private removeStaleLease(lease: SessionLease): boolean {
    return this.isThisHost(lease) && this.removeLease(lease.nonce);
  }

  /**
   * {@link removeLease} under the startup lock, so it cannot race a peer writing a new lease. A busy
   * lock leaves the (dead) lease for the next `ensure` to clean up.
   */
  private async removeLeaseLocked(nonce: string): Promise<boolean> {
    try {
      return await this.withStartupLock(async () => this.removeLease(nonce));
    } catch (err) {
      if (err instanceof EditorSessionError && err.reason === "lock-busy") return false;
      throw err;
    }
  }

  /** Compare-and-delete (call with the startup lock held): remove the lease only while it still carries `nonce`. */
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

interface CloseOptions {
  /** How long to wait for the editor to exit after the polite request. Default 30 s. */
  timeoutMs?: number;
  /** Kill the editor when it does not exit in time (only after re-verifying the lease). */
  force?: boolean;
}

/** The editor binary being resolved; `value` is set once it has resolved. */
interface BinaryRef {
  promise: Promise<string>;
  value?: string;
}

type StartOutcome =
  | { kind: "resolve" }
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

// ── default OS process primitives ─────────────────────────────────────────────────────────────

/** The real OS primitives. */
export const defaultSessionProcessOps: SessionProcessOps = {
  spawnDetached,
  isAlive: isProcessAlive,
  processStart: readProcessStart,
  requestClose: (pid) => terminateProcess(pid, false),
  forceKill: (pid) => terminateProcess(pid, true),
  sleep,
};

function unlinkQuietly(file: string): boolean {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
