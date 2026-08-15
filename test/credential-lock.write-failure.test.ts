import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Own-artifact cleanup pinning tests (fix-round amendment): when `open('wx')` succeeds but the
 * subsequent write throws, the process must best-effort unlink the artifact IT created — lock
 * and intent paths both — instead of leaving a zero-byte file that wedges every peer until it
 * goes stale. The write failure is planted by intercepting `fs.writeSync` for fds opened on the
 * targeted path suffix; everything else passes through to the real fs (dedicated test file so
 * the mock never leaks into the rest of the suite).
 */

const control = vi.hoisted(() => ({
  failWritesTo: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const fdPaths = new Map<number, string>();
  const openSync: typeof actual.openSync = (...args) => {
    const fd = actual.openSync(...(args as Parameters<typeof actual.openSync>));
    fdPaths.set(fd, String(args[0]));
    return fd;
  };
  const writeSync = ((fd: number, ...rest: unknown[]) => {
    const target = fdPaths.get(fd);
    if (
      control.failWritesTo !== undefined &&
      target !== undefined &&
      target.endsWith(control.failWritesTo)
    ) {
      throw Object.assign(new Error("planted write failure (ENOSPC)"), { code: "ENOSPC" });
    }
    return (actual.writeSync as (fd: number, ...a: unknown[]) => number)(fd, ...rest);
  }) as typeof actual.writeSync;
  return { ...actual, openSync, writeSync };
});

import * as fs from "node:fs";

import {
  CREDENTIALS_LOCK_FILE_NAME,
  CREDENTIALS_LOCK_TAKEOVER_FILE_NAME,
  MachineCredentialLock,
} from "../src/credential-lock.js";

const FIXTURE_HOST = "fixture-host";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aigd-lock-wf-"));
});

afterEach(() => {
  control.failWritesTo = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("own-artifact cleanup on write failure (fix-round amendment)", () => {
  it("unlinks the LOCK artifact this process created when the content write throws", async () => {
    const lock = new MachineCredentialLock(dir, { hostId: FIXTURE_HOST, acquireBudgetMs: 1_000 });
    control.failWritesTo = CREDENTIALS_LOCK_FILE_NAME;

    await expect(lock.acquire()).rejects.toThrow("planted write failure");
    expect(lock.isHeld).toBe(false);
    // The zero-byte artifact was cleaned up — no peer is wedged until staleness.
    expect(fs.existsSync(path.join(dir, CREDENTIALS_LOCK_FILE_NAME))).toBe(false);
  });

  it("unlinks the INTENT artifact this process created when the content write throws", async () => {
    // A stale same-host lock forces the takeover path (and with it the intent create).
    const lockPath = path.join(dir, CREDENTIALS_LOCK_FILE_NAME);
    const staleBytes = JSON.stringify({
      pid: 999_999_999,
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      hostId: FIXTURE_HOST,
    });
    fs.writeFileSync(lockPath, staleBytes);
    const past = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, past, past);

    const lock = new MachineCredentialLock(dir, {
      hostId: FIXTURE_HOST,
      staleMs: 400,
      acquireBudgetMs: 1_000,
      maxBackoffMs: 50,
    });
    control.failWritesTo = CREDENTIALS_LOCK_TAKEOVER_FILE_NAME;

    await expect(lock.acquire()).rejects.toThrow("planted write failure");
    expect(lock.isHeld).toBe(false);
    // Our zero-byte intent was cleaned up; the stale lock we never got to remove is untouched.
    expect(fs.existsSync(path.join(dir, CREDENTIALS_LOCK_TAKEOVER_FILE_NAME))).toBe(false);
    expect(fs.readFileSync(lockPath, "utf-8")).toBe(staleBytes);
  });
});
