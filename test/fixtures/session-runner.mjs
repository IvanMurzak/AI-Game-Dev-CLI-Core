// One CLI call for `test/editor-session.subprocess.test.ts`: a plain `node` process running
// `EditorSession.ensure()` from the BUILT library against a project dir, with the fake editor.
//
// Usage: node session-runner.mjs <projectRoot> <readyFile> <launchesLog>
// Prints one JSON line: {"ok":true,"source":...,"pid":...} or {"ok":false,"reason":...,"message":...}.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorSession, unityAdapter } from "../../dist/index.js";

const [projectRoot, readyFile, launchesLog] = process.argv.slice(2);
const fakeEditor = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-editor.mjs");

const session = new EditorSession({
  adapter: { ...unityAdapter, editor: { args: () => [fakeEditor, readyFile, launchesLog] } },
  projectRoot,
  editorBinary: process.execPath,
  idleSeconds: 42,
  probeReady: async () => (fs.existsSync(readyFile) ? "ready" : undefined),
  readyIntervalMs: 100,
  readyTimeoutMs: 60_000,
});

try {
  const result = await session.ensure();
  console.log(JSON.stringify({ ok: true, source: result.source, pid: result.lease?.pid }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, reason: err.reason, message: err.message }));
}
