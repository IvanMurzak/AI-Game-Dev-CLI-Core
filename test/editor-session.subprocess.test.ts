import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { EditorSession } from "../src/editor-session.js";
import { isProcessAlive, readProcessStart } from "../src/process.js";
import { unityAdapter } from "../src/engine-adapter.js";

/**
 * Real processes for the editor session: several `node` CLI processes start cold against one
 * project at the same time (exactly one editor may launch), the lease identifies the real editor
 * process by its OS start time, and `closeOwned` stops it.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(repoRoot, "test", "fixtures");

let root: string;
const editorPids: number[] = [];

beforeAll(() => {
  // The runners import dist/ (plain node, outside vitest's transpiler): rebuild when stale.
  const out = path.join(repoRoot, "dist", "editor-session.js");
  const sources = ["editor-session.ts", "process.ts", "credential-lock.ts", "engine-adapter.ts", "index.ts"].map((f) =>
    path.join(repoRoot, "src", f),
  );
  if (!fs.existsSync(out) || sources.some((s) => fs.statSync(s).mtimeMs > fs.statSync(out).mtimeMs)) {
    const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", path.join(repoRoot, "tsconfig.json")], { cwd: repoRoot, stdio: "inherit" });
  }
}, 180_000);

afterEach(() => {
  for (const pid of editorPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function runCli(readyFile: string, launchesLog: string): Promise<{ ok: boolean; source?: string; pid?: number; reason?: string; message?: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(fixtures, "session-runner.mjs"), root, readyFile, launchesLog],
      { timeout: 90_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}\n${stderr}`));
        else resolve(JSON.parse(stdout.trim().split("\n").pop()!));
      },
    );
  });
}

describe("EditorSession with real processes", () => {
  it("three concurrent cold `exec` processes launch one editor; closeOwned stops it", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "editor-session-proc-"));
    const readyFile = path.join(root, "ready");
    const launchesLog = path.join(root, "launches.log");

    const results = await Promise.all([1, 2, 3].map(() => runCli(readyFile, launchesLog)));
    const launches = fs
      .readFileSync(launchesLog, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { pid: number; owner: string; idle: string; nonce: string });
    editorPids.push(...launches.map((l) => l.pid));

    expect(results.every((r) => r.ok), JSON.stringify(results)).toBe(true);
    expect(launches).toHaveLength(1);
    expect(results.filter((r) => r.source === "started")).toHaveLength(1);
    const editor = launches[0]!;
    expect(editor).toMatchObject({ owner: "cli", idle: "42" });

    const session = new EditorSession({
      adapter: unityAdapter,
      projectRoot: root,
      probeReady: async () => undefined,
    });
    const lease = await session.ownedSession();
    expect(lease?.pid).toBe(editor.pid);
    expect(lease?.nonce).toBe(editor.nonce);
    expect(lease?.processStart).toBe(await readProcessStart(editor.pid));

    // POSIX: SIGTERM ends it. Windows: WM_CLOSE cannot reach a windowless process, so `force` does.
    const closed = await session.closeOwned({ timeoutMs: 3_000, force: true });
    expect(closed).toMatchObject({ kind: "closed", pid: editor.pid });
    expect(isProcessAlive(editor.pid)).toBe(false);
    expect(session.readLease()).toBeUndefined();
  }, 120_000);
});
