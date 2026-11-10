// Reads the machine credential store of the current HOME / USERPROFILE with the platform codec, as
// an engine CLI does, and prints the outcome as one JSON line. Its stderr must stay empty.
//
// Usage: node read-store.mjs

import { MachineCredentialStore, MachineCredentialStoreUnreadableError } from "../../dist/index.js";

const store = new MachineCredentialStore();
let result;
try {
  result = { status: store.read() === null ? "missing" : "ok" };
} catch (err) {
  result = { status: "unreadable", readError: err instanceof MachineCredentialStoreUnreadableError ? err.message : `unexpected: ${err}` };
}
process.stdout.write(JSON.stringify({ path: store.credentialsPath, ...result }) + "\n");
