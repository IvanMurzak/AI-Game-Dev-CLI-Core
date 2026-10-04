import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DPAPI_POWERSHELL_HOST_ENV,
  MachineCredentialStore,
  MachineCredentialStoreUnwritableError,
  dpapiCredentialCodec,
  resetPowerShellHostCache,
} from "../src/index.js";
// Internal test hook — deliberately not part of the package's public API.
import { setDpapiTimeoutsForTests } from "../src/machine-credentials.js";

/**
 * GlitchTip desktop #1260: a sign-in the user had just APPROVED failed with
 * `MachineCredentialStoreUnwritableError` caused by `spawnSync …\powershell.exe ETIMEDOUT` — the
 * DPAPI codec's cold PowerShell start overran its single 20 s budget on an old laptop, and the
 * login commit gave up.
 *
 * The spawn here is REAL (`execFileSync` with a real `timeout` kill) — only the host is a stand-in,
 * selected through the documented `AIGD_DPAPI_POWERSHELL` override: a script that is slow the FIRST
 * time it runs (a cold start) and fast afterwards, echoing its input back so the "encryption" is the
 * identity. POSIX-only because the stand-in is a shell script; the budgets are shrunk through the
 * test hook because a real-spawn test cannot wait 20 s.
 */

const isWindows = process.platform === "win32";
const dirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-dpapi-timeout-"));
  dirs.push(dir);
  return dir;
}

/**
 * A stand-in PowerShell host. `coldRuns` = how many leading invocations hang (each one `exec`s
 * `sleep`, so the timeout kill hits the sleeping process itself and spawnSync returns at once).
 * Every invocation appends a line to `<dir>/calls`.
 */
function fakeHost(dir: string, coldRuns: number): string {
  const host = path.join(dir, "fake-powershell.sh");
  fs.writeFileSync(
    host,
    [
      "#!/bin/sh",
      `echo run >> "${dir}/calls"`,
      `n=$(wc -l < "${dir}/calls")`,
      `if [ "$n" -le ${coldRuns} ]; then exec sleep 30; fi`,
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

let savedOverride: string | undefined;

beforeEach(() => {
  savedOverride = process.env[DPAPI_POWERSHELL_HOST_ENV];
  resetPowerShellHostCache();
  // Generous on purpose. Under a loaded full-suite run a shell can take longer than 300 ms just to
  // START — the kill then lands before the stand-in has recorded its run, and the "warm" retry
  // looks cold. The first budget must comfortably cover shell start-up; `sleep 30` is what overruns it.
  setDpapiTimeoutsForTests({ first: 2000, writeRetry: 15_000 });
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env[DPAPI_POWERSHELL_HOST_ENV];
  else process.env[DPAPI_POWERSHELL_HOST_ENV] = savedOverride;
  setDpapiTimeoutsForTests(undefined);
  resetPowerShellHostCache();
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe.skipIf(isWindows)("DPAPI codec — a host that times out once (GlitchTip #1260)", () => {
  it("retries the timed-out host once and the login-commit write succeeds", () => {
    const dir = freshDir();
    process.env[DPAPI_POWERSHELL_HOST_ENV] = fakeHost(dir, 1);
    const store = new MachineCredentialStore(freshDir(), dpapiCredentialCodec);

    store.write({ accessToken: "at", refreshToken: "rt", serverTarget: "https://ai-game.dev" } as never);

    expect(calls(dir)).toBe(2); // the killed cold start + the warm retry
    expect(store.read()).toMatchObject({ accessToken: "at", refreshToken: "rt" });
  });

  it("still fails CLOSED with the structured error when every attempt times out", () => {
    const dir = freshDir();
    process.env[DPAPI_POWERSHELL_HOST_ENV] = fakeHost(dir, 99);
    setDpapiTimeoutsForTests({ first: 2000, writeRetry: 2000 });
    const baseDir = freshDir();
    const store = new MachineCredentialStore(baseDir, dpapiCredentialCodec);

    let thrown: unknown;
    try {
      store.write({ accessToken: "at" } as never);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MachineCredentialStoreUnwritableError);
    expect(((thrown as Error).cause as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
    expect(calls(dir)).toBe(2); // exactly one retry — never a loop
    expect(fs.readdirSync(baseDir)).toEqual([]); // nothing written
  });

  it("does NOT retry a READ: readState sits on hot paths, so one budget then `unreadable`", () => {
    // TD ruling: `readState()` runs on the connectivity probe and every tool call; a synchronous
    // retry there could stall the event loop for the sum of the budgets. A cold read stays the
    // pre-#1260 single attempt and degrades to the structured, recoverable `unreadable` state.
    const dir = freshDir();
    process.env[DPAPI_POWERSHELL_HOST_ENV] = fakeHost(dir, 1);
    const baseDir = freshDir();
    const store = new MachineCredentialStore(baseDir, dpapiCredentialCodec);
    fs.writeFileSync(store.credentialsPath, Buffer.from("not-really-a-dpapi-blob"));

    const state = store.readState();

    expect(state.status).toBe("unreadable");
    expect(calls(dir)).toBe(1); // no second, longer attempt on the read path
  });
});
