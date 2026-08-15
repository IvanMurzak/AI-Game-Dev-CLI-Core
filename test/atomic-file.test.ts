import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OWNER_ONLY_DIRECTORY_MODE,
  OWNER_ONLY_FILE_MODE,
  RENAME_RETRY_ATTEMPTS,
  RENAME_RETRY_DELAY_MS,
  tempSiblingPathFor,
  writeFileAtomicSync,
} from "../src/index.js";

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-atomic-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("writeFileAtomicSync — same-directory temp sibling (04 §1 same-volume rename contract)", () => {
  it("tempSiblingPathFor always resolves inside the target's own directory", () => {
    const dir = freshDir();
    const target = path.join(dir, "credentials.json");
    const temp = tempSiblingPathFor(target);
    expect(path.dirname(temp)).toBe(dir);
    expect(path.basename(temp)).toMatch(/^credentials\.json\..+\.tmp$/);
    // Never the OS temp dir — a cross-volume temp would silently break rename atomicity.
    expect(path.dirname(temp)).not.toBe(os.tmpdir());
  });

  it("the writer creates its temp file at EXACTLY the same-directory sibling path (EEXIST plant)", () => {
    // Freeze the clock: the temp name is (basename, pid, now36), so the path becomes deterministic
    // and we can occupy it in advance. 'wx' open semantics then force EEXIST — proving the writer
    // really placed its temp file as the same-directory sibling, not in os.tmpdir() or elsewhere.
    vi.useFakeTimers({ now: 1_723_600_000_000 });
    const dir = freshDir();
    const target = path.join(dir, "credentials.json");
    const predicted = tempSiblingPathFor(target);
    fs.writeFileSync(predicted, "occupied");

    expect(() => writeFileAtomicSync(target, Buffer.from("data"))).toThrow(/EEXIST/);
    expect(fs.existsSync(target)).toBe(false); // the obstructed write never touched the target
    // The failed writer must NOT delete a temp file it does not own ('wx' contract): the
    // colliding file is another writer's in-flight temp, and destroying it would corrupt THAT write.
    expect(fs.readFileSync(predicted, "utf-8")).toBe("occupied");

    // With the obstruction removed the identical write succeeds at the same instant.
    fs.rmSync(predicted);
    writeFileAtomicSync(target, Buffer.from("data"));
    expect(fs.readFileSync(target, "utf-8")).toBe("data");
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writes land intact and replace atomically (advisory POSIX parent-dir fsync does not break the path)", () => {
    const dir = freshDir();
    const target = path.join(dir, "store", "credentials.json");
    writeFileAtomicSync(target, Buffer.from("first"));
    writeFileAtomicSync(target, Buffer.from("second"));
    expect(fs.readFileSync(target, "utf-8")).toBe("second");
  });
});

describe("rename retry (04 §1 Windows store contract — parity with C# MachineCredentialStore)", () => {
  it("the retry policy meets the store contract floor (≥4 attempts, ≥250 ms backoff)", () => {
    // 04 §1: "Windows rename retry policy is part of the contract: ≥4 attempts, ≥250 ms backoff
    // on EBUSY/EPERM/EACCES". The design assumed Node inherited this from libuv — it does not
    // (that behavior lives in graceful-fs); the loop is implemented in atomic-file.ts and these
    // constants pin it exactly like the C# twin's RetryPolicy_MeetsTheStoreContract.
    expect(RENAME_RETRY_ATTEMPTS).toBeGreaterThanOrEqual(4);
    expect(RENAME_RETRY_DELAY_MS).toBeGreaterThanOrEqual(250);
  });

  // FileShare semantics are only enforced by Windows; a POSIX rename ignores open handles, so the
  // holder below cannot obstruct anything there (the C# twin's holder test skips POSIX the same way).
  it.skipIf(process.platform !== "win32")(
    "an atomic write SURVIVES a transient reader holding the destination open (the x2 lost-write regression)",
    async () => {
      const dir = freshDir();
      const target = path.join(dir, "credentials.json");
      writeFileAtomicSync(target, Buffer.from("old"));

      // A real subprocess holds the destination open for reading — exactly what a peer's
      // fs.readFileSync / .NET File.ReadAllBytes / an AV scanner does — long enough that the
      // FIRST rename attempt is guaranteed to land inside the hold (a single-attempt writer
      // fails EPERM here; that failure, swallowed by the provider, is what left an AS-revoked
      // predecessor in the shared store and surfaced as a D10 grace hit on the Windows CI leg).
      const holdMs = RENAME_RETRY_DELAY_MS + 150; // released before attempt #2's backoff expires
      const marker = path.join(dir, "holder-open");
      const holder = spawn(process.execPath, [
        "-e",
        `const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");fs.writeFileSync(process.argv[2],"open");setTimeout(()=>{fs.closeSync(fd);},${holdMs});`,
        target,
        marker,
      ]);
      try {
        const deadline = Date.now() + 15_000;
        while (!fs.existsSync(marker)) {
          if (Date.now() > deadline) throw new Error("holder subprocess never signalled readiness");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const started = Date.now();
        writeFileAtomicSync(target, Buffer.from("new")); // must survive the holder via retries
        const elapsed = Date.now() - started;

        expect(fs.readFileSync(target, "utf-8")).toBe("new");
        // The write genuinely went through the retry path: it cannot have completed before the
        // holder released (a 0 ms success here would mean the holder never obstructed — vacuous).
        expect(elapsed).toBeGreaterThanOrEqual(RENAME_RETRY_DELAY_MS);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
      } finally {
        holder.kill();
      }
    },
    30_000,
  );
});

describe.skipIf(process.platform === "win32")("POSIX owner-only permissions (0600 file / 0700 directory)", () => {
  it("creates the store directory 0700 and the written file 0600", () => {
    const dir = freshDir();
    const storeDir = path.join(dir, "store");
    const target = path.join(storeDir, "credentials.json");
    writeFileAtomicSync(target, Buffer.from("secret"));

    expect(fs.statSync(storeDir).mode & 0o777).toBe(OWNER_ONLY_DIRECTORY_MODE);
    expect(fs.statSync(target).mode & 0o777).toBe(OWNER_ONLY_FILE_MODE);
  });
});
