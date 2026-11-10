import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defaultSessionProcessOps } from "../src/editor-session.js";
import { isProcessAlive, killProcessTree, sleep, spawnDetached } from "../src/process.js";
import { fixtures } from "./dist-build.js";

/**
 * Real processes: a force kill takes the editor's children with it. The "editor" is started the way
 * an EditorSession starts one (detached) and starts a non-detached child of its own.
 */

let dir: string | undefined;
const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  dir = undefined;
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

async function startEditorWithChild(): Promise<{ parent: number; child: number }> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-core-tree-"));
  const childPidFile = path.join(dir, "child.pid");
  const parent = await spawnDetached(process.execPath, [path.join(fixtures, "tree-parent.mjs"), childPidFile], {
    cwd: dir,
    env: process.env,
    hideWindow: true,
  });
  started.push(parent);
  const ready = await waitFor(() => fs.existsSync(childPidFile) && fs.readFileSync(childPidFile, "utf-8") !== "", 15_000);
  expect(ready).toBe(true);
  const child = Number(fs.readFileSync(childPidFile, "utf-8"));
  started.push(child);
  expect(isProcessAlive(child)).toBe(true);
  return { parent, child };
}

describe("killProcessTree", () => {
  it("kills the process and the children it started", { timeout: 60_000 }, async () => {
    const { parent, child } = await startEditorWithChild();
    expect(await killProcessTree(parent)).toBe(true);
    expect(await waitFor(() => !isProcessAlive(parent), 10_000)).toBe(true);
    expect(await waitFor(() => !isProcessAlive(child), 10_000)).toBe(true);
  });

  it("the session's forceKill is the tree kill", { timeout: 60_000 }, async () => {
    const { parent, child } = await startEditorWithChild();
    expect(await defaultSessionProcessOps.forceKill(parent)).toBe(true);
    expect(await waitFor(() => !isProcessAlive(parent), 10_000)).toBe(true);
    expect(await waitFor(() => !isProcessAlive(child), 10_000)).toBe(true);
  });

  it("a pid that is already gone counts as killed", async () => {
    expect(await killProcessTree(2_147_483_000)).toBe(true);
  });
});
