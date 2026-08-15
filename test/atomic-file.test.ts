import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OWNER_ONLY_DIRECTORY_MODE, OWNER_ONLY_FILE_MODE, tempSiblingPathFor, writeFileAtomicSync } from "../src/index.js";

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
