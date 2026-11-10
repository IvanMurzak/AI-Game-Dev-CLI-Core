// A stand-in editor for the process-tree kill test: starts a child (a "shader compiler") and
// records its pid, then idles until killed.
//
// On Windows libuv puts a node process's non-detached children in a kill-on-close job, so they die
// with it — unlike a real editor's children. Detached, the child outlives its parent the way a real
// editor's does, and only `taskkill /T` (which walks the parent-pid tree) reaches it. On POSIX the
// child stays in the parent's process group, which is what the group kill must reach.
//
// Usage: node tree-parent.mjs <childPidFile>

import { spawn } from "node:child_process";
import * as fs from "node:fs";

const [childPidFile] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
  detached: process.platform === "win32",
});
child.once("spawn", () => fs.writeFileSync(childPidFile, String(child.pid)));
setInterval(() => {}, 1_000);
