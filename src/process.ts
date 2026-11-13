import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";

import { isErrno } from "./atomic-file.js";
import { isHostStartFailure, powerShellHostsInOrder } from "./machine-credentials.js";

/**
 * OS process primitives (the platform branches live here, not in the policy modules): liveness,
 * a process start-time identity token, polite / forced termination, detached spawn, and `sleep`.
 */

const isWindows = process.platform === "win32";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when `pid` names a running process (EPERM = it exists but is not ours to signal). */
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
 * An opaque token for the start time of `pid` — Linux `/proc/<pid>/stat` starttime, macOS
 * `ps -o lstart=`, Windows `Get-Process` StartTime ticks. Two reads of the same live process are
 * equal; a reused pid yields a different token. Undefined when it cannot be read.
 */
export async function readProcessStart(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Field 22 (starttime); the command name (field 2) may contain spaces, so split after its ")".
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks ? `linux:${ticks}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (isWindows) {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    for (const host of powerShellHostsInOrder()) {
      try {
        const out = (await execFileText(host, ["-NoProfile", "-NonInteractive", "-Command", script], 15_000)).trim();
        return /^\d+$/.test(out) ? `win:${out}` : undefined;
      } catch (err) {
        if (isHostStartFailure(err)) continue; // this host is missing — try the next
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

/**
 * The command line of `pid` as one string — Linux `/proc/<pid>/cmdline` (an argument with whitespace
 * is quoted), Windows `Win32_Process.CommandLine` (as the process was started, quoting included),
 * elsewhere `ps -ww -o args=` (the arguments joined with spaces, unquoted). Undefined when it
 * cannot be read (no such process, access denied, no PowerShell).
 */
export async function readProcessCommandLine(pid: number): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0");
      if (args[args.length - 1] === "") args.pop();
      const line = args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
      return line || undefined;
    } catch {
      return undefined;
    }
  }
  if (isWindows) {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop).CommandLine`;
    for (const host of powerShellHostsInOrder()) {
      try {
        const out = (await execFileText(host, ["-NoProfile", "-NonInteractive", "-Command", script], 15_000)).trim();
        return out || undefined;
      } catch (err) {
        if (isHostStartFailure(err)) continue; // this host is missing — try the next
        return undefined;
      }
    }
    return undefined;
  }
  try {
    const out = (await execFileText("ps", ["-ww", "-o", "args=", "-p", String(pid)], 10_000)).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask `pid` to quit: SIGTERM on POSIX, `taskkill /PID` (WM_CLOSE — never reaches a windowless
 * process) on Windows. Resolves whether the request was delivered (or the process is already gone).
 */
export function terminateProcess(pid: number): Promise<boolean> {
  return deliver(pid, async () => {
    if (isWindows) await execFileText("taskkill", ["/PID", String(pid)], 10_000);
    else process.kill(pid, "SIGTERM");
  });
}

/**
 * Kill `pid` and every process it started, outright, so an editor's children (shader compilers, the
 * console wrapper, workers) do not outlive it: `taskkill /PID <pid> /T /F` on Windows; on POSIX
 * SIGKILL to the process group `pid` leads ({@link spawnDetached} makes the editor a group leader),
 * or to `pid` alone when it leads no group. Resolves whether `pid` is gone or the kill was delivered.
 */
export function killProcessTree(pid: number): Promise<boolean> {
  return deliver(pid, async () => {
    if (isWindows) {
      await execFileText("taskkill", ["/PID", String(pid), "/T", "/F"], 10_000);
      return;
    }
    // Never signal group 1 (`kill(-1)` reaches every process we may signal) or our own process.
    if (pid > 1 && pid !== process.pid) {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
        // not a group leader (or no group member is ours): kill the pid alone
      }
    }
    process.kill(pid, "SIGKILL");
  });
}

/** Run `signal` against a live `pid`; true when it was delivered or the process is gone. */
async function deliver(pid: number, signal: () => Promise<void>): Promise<boolean> {
  if (!isProcessAlive(pid)) return true;
  try {
    await signal();
    return true;
  } catch {
    return !isProcessAlive(pid); // it may have exited between the check and the signal
  }
}

/** Start `command` detached from this process (no stdio, unref'd); resolves its pid once spawned. */
export function spawnDetached(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; hideWindow: boolean },
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
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
  });
}

function execFileText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf-8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}
