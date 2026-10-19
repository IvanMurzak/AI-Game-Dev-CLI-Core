// A stand-in "editor" for `test/editor-session.subprocess.test.ts`: records its launch, becomes
// "ready" after a short delay (writes <readyFile>), then idles until it is closed.
//
// Usage: node fake-editor.mjs <readyFile> <launchesLog>
// The launch line carries the session env, so the parent can check what the editor received.

import * as fs from "node:fs";

const [readyFile, launchesLog] = process.argv.slice(2);
fs.appendFileSync(
  launchesLog,
  `${JSON.stringify({ pid: process.pid, owner: process.env.AIGD_SESSION_OWNER, idle: process.env.AIGD_SESSION_IDLE_SECONDS, nonce: process.env.AIGD_SESSION_NONCE })}\n`,
);
setTimeout(() => fs.writeFileSync(readyFile, String(process.pid)), 400);
setInterval(() => {}, 1_000);
