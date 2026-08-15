// Real-subprocess worker for the mixed-language refresh concurrency suite (unified-machine-auth
// 04 §5, task x2). Spawned as a plain `node` child by `test/concurrency-suite.subprocess.test.ts`
// next to C# workers (MCP-Plugin-dotnet `McpPlugin.Tests.RefreshHarness`), all contending on ONE
// shared machine credential store against the suite's local fake authorization server.
//
// It drives the BUILT library (`dist/`) — the real MachineCredentialStore (identity codec: both
// languages share one plaintext at-rest format; DPAPI parity is task x1's suite), the real
// MachineCredentialLock with the REAL 15/60/75 s contract constants (no overrides in the green
// suite), the real HttpTokenRefresher, and the real MachineCredentialProvider refresh loop.
//
// Usage: node concurrency-worker.mjs '<json-config>'
//   config: {
//     mode: "hammer" | "once",
//     storeDir, eventsFile, serverBase, clientId,
//     skewMs, loopDelayMs, maxDurationMs, stopFile,
//     noLock: boolean,          // hammer only — the lock-DISABLED plant composition
//     scaled: null | { timeoutMs, staleMs, budgetMs }   // once only — plant-3 retry scaling
//   }
//
// Events are appended to <eventsFile> as `<TAG> <pid> <epochMs> [detail]` lines (O_APPEND — the
// same protocol as lock-runner.mjs). Tags: READY, TOKEN (detail = access token), UNREADABLE,
// RETRY (a transient read glitch being retried), DONE (detail = "<refreshes> <distinct>"),
// ONCE-OK (detail = "<refreshes>"), BUSY, DEAD (detail = base64 reason), ERROR (base64 detail),
// LOST-WRITE (base64 provider warning: a rotation was received but persisting it to the store
// failed/was skipped — the store still holds the PREDECESSOR, the exact client-visible loss the
// D10 window absorbs), LOST-RESPONSE (base64 provider warning: the refresh HTTP attempt itself
// failed — if the AS had already committed, the predecessor stays current here too), WARN (any
// other provider warning, base64).
// Exits: 0 ok · 1 error · 3 busy (lock budget exhausted) · 5 dead (sign-in required).

import * as fs from "node:fs";

import {
  MachineCredentialStore,
  MachineCredentialStoreUnreadableError,
  identityCredentialCodec,
} from "../../dist/machine-credentials.js";
import { CredentialLockBusyError, MachineCredentialLock } from "../../dist/credential-lock.js";
import { HttpTokenRefresher } from "../../dist/token-refresher.js";
import { LoginRequiredError, MachineCredentialProvider } from "../../dist/credential-provider.js";

const configRaw = process.argv[2];
if (!configRaw) {
  process.stderr.write("usage: node concurrency-worker.mjs '<json-config>'\n");
  process.exit(1);
}
const config = JSON.parse(configRaw);

const emit = (tag, detail) => {
  const suffix = detail === undefined ? "" : ` ${detail}`;
  fs.appendFileSync(config.eventsFile, `${tag} ${process.pid} ${Date.now()}${suffix}\n`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (value) => Buffer.from(String(value), "utf-8").toString("base64");

// Consecutive-failure tolerance for the lock-free store read that getAccessToken performs by
// design (03 F3.1): a read raced by a peer's atomic replace may transiently fail without meaning
// the family is dead. A REAL dead family is memoized by the provider, so it keeps failing every
// iteration and exhausts the cap; a glitch heals on the next loop.
const TRANSIENT_CAP = 10;

async function main() {
  const store = new MachineCredentialStore(config.storeDir, identityCredentialCodec);

  const scaled = config.scaled ?? null;
  if (scaled !== null && !(scaled.timeoutMs < scaled.staleMs && scaled.staleMs < scaled.budgetMs)) {
    // 04 §2: scaled-down variants must preserve the ordering invariant timeout < stale < budget.
    throw new Error(`scaled constants violate the ordering invariant: ${JSON.stringify(scaled)}`);
  }

  const lock = config.noLock
    ? // The lock-DISABLED plant composition: same provider, same store, same refresher — the
      // critical section simply runs without mutual exclusion. Duck-typed: the provider only
      // calls withLock() on this seam.
      { withLock: async (fn) => await fn() }
    : new MachineCredentialLock(
        config.storeDir,
        scaled === null
          ? { onWarning: () => {} }
          : { onWarning: () => {}, staleMs: scaled.staleMs, acquireBudgetMs: scaled.budgetMs },
      );

  const inner = new HttpTokenRefresher({
    defaultServerBaseUrl: config.serverBase,
    ...(scaled === null ? {} : { timeoutMs: scaled.timeoutMs }),
  });
  let refreshes = 0;
  const refresher = {
    refresh: async (request) => {
      const result = await inner.refresh(request);
      if (result.ok) refreshes += 1;
      return result;
    },
  };

  // Client-side LOSS observability (the suite's attribution channel): a provider warning that a
  // received rotation could not be persisted — or that the refresh HTTP attempt itself failed —
  // is the client-visible record that the store may still hold a predecessor the AS has already
  // revoked. The suite requires every green-run D10 grace hit to map onto one of these records;
  // a grace hit with NO such record anywhere in the fleet would be a serialization hole.
  const classifyWarning = (message) => {
    if (message.startsWith("Persisting")) return "LOST-WRITE";
    if (message.startsWith("Token refresh error") || message.startsWith("Account credential refresh failed")) {
      return "LOST-RESPONSE";
    }
    return "WARN";
  };

  const provider = new MachineCredentialProvider(store, refresher, {
    refreshSkewMs: config.skewMs,
    lock,
    defaultClientId: config.clientId,
    onWarning: (message) => emit(classifyWarning(message), b64(message)),
    onTelemetry: () => {},
  });

  emit("READY");

  if (config.mode === "once") {
    await provider.refresh({ family: "plugin" });
    emit("ONCE-OK", String(refreshes));
    return 0;
  }

  const deadline = Date.now() + config.maxDurationMs;
  let lastToken = null;
  let distinct = 0;
  let consecutiveFailures = 0;

  while (Date.now() < deadline && !fs.existsSync(config.stopFile)) {
    try {
      const token = await provider.getAccessToken({ family: "plugin" });
      consecutiveFailures = 0;
      if (token !== lastToken) {
        lastToken = token;
        distinct += 1;
        emit("TOKEN", token);
      }
    } catch (err) {
      if (err instanceof CredentialLockBusyError) {
        emit("BUSY");
        return 3;
      }
      if (err instanceof MachineCredentialStoreUnreadableError) {
        consecutiveFailures += 1;
        emit("UNREADABLE", b64(err.message));
        if (consecutiveFailures >= TRANSIENT_CAP) return 1;
        await sleep(50);
        continue;
      }
      if (err instanceof LoginRequiredError) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= TRANSIENT_CAP) {
          emit("DEAD", b64(err.message));
          return 5;
        }
        emit("RETRY", b64(err.message));
        await sleep(50);
        continue;
      }
      emit("ERROR", b64(err?.stack ?? String(err)));
      return 1;
    }
    await sleep(config.loopDelayMs);
  }

  emit("DONE", `${refreshes} ${distinct}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    try {
      if (err instanceof CredentialLockBusyError) {
        emit("BUSY");
        process.exit(3);
      }
      if (err instanceof LoginRequiredError) {
        emit("DEAD", b64(err.message));
        process.exit(5);
      }
      emit("ERROR", b64(err?.stack ?? String(err)));
    } catch {
      // the events file itself failed — nothing left to report through
    }
    process.exit(1);
  },
);
