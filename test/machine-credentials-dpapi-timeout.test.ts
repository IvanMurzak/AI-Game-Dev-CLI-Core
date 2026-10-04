import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DPAPI_POWERSHELL_HOST_ENV,
  MachineCredentialStore,
  MachineCredentialStoreUnwritableError,
  commitAgentLogin,
  dpapiCredentialCodec,
  resetPowerShellHostCache,
  type MachineCredentials,
  type TokenExchangeClient,
} from "../src/index.js";
// Internal test hook — deliberately not part of the package's public API.
import { setDpapiTimeoutsForTests } from "../src/machine-credentials.js";

/**
 * GlitchTip desktop #1260: a sign-in the user had just APPROVED failed with
 * `MachineCredentialStoreUnwritableError` ← `spawnSync …\powershell.exe ETIMEDOUT` — the DPAPI
 * codec's cold PowerShell start overran its 20 s budget on an old laptop, inside the login commit.
 *
 * The fix pays the cold start in an ASYNC, LOCK-FREE warm-up before the commit takes the lock, so
 * the synchronous in-lock calls keep their single budget (a sync retry would stall the event loop
 * and break the lock's stale-ordering contract). The spawns here are REAL (`execFile` /
 * `execFileSync` with real timeout kills) — only the host is a stand-in, selected through the
 * documented `AIGD_DPAPI_POWERSHELL` override: a shell script that is SLOW on its first run (a cold
 * start) and fast afterwards, echoing its input so the "encryption" is the identity. POSIX-only
 * because the stand-in is a shell script; budgets are shrunk through the internal test hook.
 */

const isWindows = process.platform === "win32";
const dirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-dpapi-timeout-"));
  dirs.push(dir);
  return dir;
}

/**
 * A stand-in PowerShell host. The first `coldRuns` invocations sleep `coldSeconds` before answering
 * (a cold start); later ones answer at once. Every invocation appends a line to `<dir>/calls` FIRST,
 * so a run that is killed mid-sleep is still counted.
 */
function fakeHost(dir: string, coldRuns: number, coldSeconds: number): string {
  const host = path.join(dir, "fake-powershell.sh");
  fs.writeFileSync(
    host,
    [
      "#!/bin/sh",
      `echo run >> "${dir}/calls"`,
      `n=$(wc -l < "${dir}/calls")`,
      // sleep's stdio goes to /dev/null so a timeout kill of the shell closes the pipe at once.
      `if [ "$n" -le ${coldRuns} ]; then sleep ${coldSeconds} >/dev/null 2>&1; fi`,
      'printf "%s" "$AIGD_DPAPI_IN"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return host;
}

function calls(dir: string): number {
  const file = path.join(dir, "calls");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").trim().split("\n").length : 0;
}

const AGENT_CREDS: MachineCredentials = {
  accessToken: "agent-a",
  refreshToken: "agent-r",
  expiresAt: "2030-01-01T00:00:00.000Z",
  serverTarget: "https://ai-game.dev",
  subject: "usr_A",
};

/** Hold 1 (the agent family) is what #1260 failed on; a failing exchange stops right after it. */
const exchangeDown: TokenExchangeClient = { exchange: async () => ({ ok: false, reason: "down" }) };

let savedOverride: string | undefined;

beforeEach(() => {
  savedOverride = process.env[DPAPI_POWERSHELL_HOST_ENV];
  resetPowerShellHostCache();
  // The in-lock budget must comfortably cover a WARM shell start under a loaded full-suite run;
  // the cold run (3 s) is what overruns it.
  setDpapiTimeoutsForTests({ call: 1500, warmUp: 15_000 });
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env[DPAPI_POWERSHELL_HOST_ENV];
  else process.env[DPAPI_POWERSHELL_HOST_ENV] = savedOverride;
  setDpapiTimeoutsForTests(undefined);
  resetPowerShellHostCache();
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe.skipIf(isWindows)("DPAPI codec cold start (GlitchTip #1260)", { timeout: 30_000 }, () => {
  it("a login commit after a COLD start succeeds: the warm-up pays it before the lock", async () => {
    const dir = freshDir();
    process.env[DPAPI_POWERSHELL_HOST_ENV] = fakeHost(dir, 1, 3);
    const store = new MachineCredentialStore(freshDir(), dpapiCredentialCodec);

    const result = await commitAgentLogin({
      store,
      exchangeClient: exchangeDown,
      clientId: "agd_client_x",
      credentials: AGENT_CREDS,
    });

    expect(result.status).toBe("partial"); // hold 1 committed; only the (scripted) exchange failed
    expect(store.read()?.families?.agent?.accessToken).toBe("agent-a");
  });

  it("the warm-up never blocks the event loop and is a no-op once warm", async () => {
    const dir = freshDir();
    process.env[DPAPI_POWERSHELL_HOST_ENV] = fakeHost(dir, 1, 1);
    const store = new MachineCredentialStore(freshDir(), dpapiCredentialCodec);

    let ticked = false;
    const tick = new Promise<void>((resolve) =>
      setTimeout(() => {
        ticked = true;
        resolve();
      }, 50),
    );
    const warm = store.warmUpCodec().then(() => ticked);
    await tick;
    expect(await warm).toBe(true); // a timer fired DURING the 1 s cold run
    expect(calls(dir)).toBe(1);

    await store.warmUpCodec();
    expect(calls(dir)).toBe(1); // already warm: no second spawn
  });

  it("an in-lock write NEVER retries: one budget, then fail CLOSED with nothing written", () => {
    const dir = freshDir();
    process.env[DPAPI_POWERSHELL_HOST_ENV] = fakeHost(dir, 99, 30);
    const baseDir = freshDir();
    const store = new MachineCredentialStore(baseDir, dpapiCredentialCodec);

    let thrown: unknown;
    try {
      store.write({ accessToken: "at" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MachineCredentialStoreUnwritableError);
    expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
    expect(calls(dir)).toBe(1);
    expect(fs.readdirSync(baseDir)).toEqual([]);
  });

  it("a READ never retries either: one budget, then the structured `unreadable` state", () => {
    const dir = freshDir();
    process.env[DPAPI_POWERSHELL_HOST_ENV] = fakeHost(dir, 99, 30);
    const store = new MachineCredentialStore(freshDir(), dpapiCredentialCodec);
    fs.writeFileSync(store.credentialsPath, Buffer.from("not-really-a-dpapi-blob"));

    expect(store.readState().status).toBe("unreadable");
    expect(calls(dir)).toBe(1);
  });
});
