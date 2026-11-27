// A second process committing a FRESH plugin sign-in to a shared machine store, honoring the
// 04 §2 lock exactly as an engine CLI does (`test/plugin-cas.subprocess.test.ts`).
//
// Usage: node plugin-writer.mjs <storeDir> <refreshToken> <readyFile> <holdMs>
//   acquire the lock → create <readyFile> → sleep <holdMs> → write the plugin family → release.
// Holding the lock while the parent's conditional write waits for it proves the parent's check
// and write run under ONE hold: the parent can only see the store after this write.

import * as fs from "node:fs";
import { MachineCredentialLock, MachineCredentialStore } from "../../dist/index.js";

const [storeDir, refreshToken, readyFile, holdMsRaw] = process.argv.slice(2);
if (!storeDir || !refreshToken || !readyFile || !holdMsRaw) {
  console.error("usage: node plugin-writer.mjs <storeDir> <refreshToken> <readyFile> <holdMs>");
  process.exit(2);
}

const store = new MachineCredentialStore(storeDir);
const lock = new MachineCredentialLock(storeDir);
await lock.withLock(async () => {
  fs.writeFileSync(readyFile, String(process.pid));
  await new Promise((resolve) => setTimeout(resolve, Number(holdMsRaw)));
  store.writeFamily("plugin", {
    accessToken: `${refreshToken}-access`,
    refreshToken,
    clientId: "unreal-mcp-cli",
    scope: "mcp:plugin",
  });
});
