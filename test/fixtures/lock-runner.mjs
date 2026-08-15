// Real-subprocess runner for the lock-protocol plants (unified-machine-auth 04 §2 / §5).
//
// Spawned as a plain `node` child by `test/lock-protocol.subprocess.test.ts`, so it exercises the
// BUILT library (`dist/`) with the REAL contract constants — no vitest harness, no test-only
// timing overrides: exactly what a CLI/App process does in production.
//
// Usage: node lock-runner.mjs <mode> <storeDir> <eventsFile> <holdMs>
//   mode "hold":    acquire → ACQUIRED → sleep holdMs → INTACT|STOLEN → release → RELEASED
//   mode "acquire": acquire → ENTER    → sleep holdMs → INTACT|STOLEN → release → EXIT
//                   (CredentialLockBusyError → BUSY; anything else → ERROR)
//
// Events are appended to <eventsFile> as `<TAG> <pid> <epochMs>` lines; O_APPEND keeps the
// interleaving of these short writes atomic enough for the parent to reconstruct a total order.

import * as fs from "node:fs";
import * as path from "node:path";
import { CREDENTIALS_LOCK_FILE_NAME, CredentialLockBusyError, MachineCredentialLock, parseLockContent } from "../../dist/credential-lock.js";

const [mode, storeDir, eventsFile, holdMsRaw] = process.argv.slice(2);
if (!mode || !storeDir || !eventsFile || !holdMsRaw) {
  console.error("usage: node lock-runner.mjs <hold|acquire> <storeDir> <eventsFile> <holdMs>");
  process.exit(2);
}
const holdMs = Number(holdMsRaw);

function emit(tag) {
  fs.appendFileSync(eventsFile, `${tag} ${process.pid} ${Date.now()}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True while the on-disk lock still names THIS process as the holder. */
function lockIsOwn() {
  try {
    const parsed = parseLockContent(fs.readFileSync(path.join(storeDir, CREDENTIALS_LOCK_FILE_NAME)));
    return parsed !== undefined && parsed.pid === process.pid;
  } catch {
    return false;
  }
}

const lock = new MachineCredentialLock(storeDir); // REAL constants — no test overrides.

try {
  await lock.acquire();
  emit(mode === "hold" ? "ACQUIRED" : "ENTER");
  await sleep(holdMs);
  emit(lockIsOwn() ? "INTACT" : "STOLEN");
  lock.release();
  emit(mode === "hold" ? "RELEASED" : "EXIT");
  process.exit(0);
} catch (err) {
  if (err instanceof CredentialLockBusyError) {
    emit("BUSY");
    process.exit(3);
  }
  emit("ERROR");
  console.error(err);
  process.exit(1);
}
