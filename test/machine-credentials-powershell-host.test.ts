import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DPAPI_POWERSHELL_HOST_ENV,
  MachineCredentialStore,
  MachineCredentialStoreUnwritableError,
  applyV1CompatMirror,
  dpapiCredentialCodec,
  powerShellHostCandidates,
  resetPowerShellHostCache,
} from "../src/index.js";

/**
 * PowerShell host resolution for the Windows DPAPI codec — the regression suite for the customer
 * incident where a successful OAuth login was followed, every single time, by
 * `Error: spawnSync powershell.exe ENOENT`.
 *
 * Root cause: `dpapiTransform` spawned the bare name `"powershell.exe"`, resolved through PATH. On
 * a machine whose PATH has lost `%SystemRoot%\System32\WindowsPowerShell\v1.0` the spawn fails —
 * and because `write()` (the login-commit path) did not map codec failures the way `readState()`
 * does, the raw errno error escaped into the app and the user could never get past login.
 *
 * **The spawn legs here are deliberately NOT mocked.** `node:child_process` is the mechanism under
 * test: a mocked spawn would pass for a reason production does not have. They are Windows-gated
 * because the DPAPI codec only exists on Windows; the resolver-order legs are pure env+fs and run
 * everywhere.
 *
 * Env mutation is safe here: vitest runs each test FILE in its own process and the tests in a file
 * sequentially, and every mutation is restored in a `finally`.
 */

const isWindows = process.platform === "win32";

const createdDirs: string[] = [];

function freshDir(prefix = "clicore-pshost-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

beforeEach(() => {
  resetPowerShellHostCache();
});

afterEach(() => {
  resetPowerShellHostCache();
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Apply `overrides` to `process.env`, run `body`, restore exactly. `undefined` deletes the key.
 *
 * Windows env casing: the real key may be `Path` OR `PATH`, and a caller that set only one of them
 * on a plain object would leave the other live. Node's Windows `process.env` is case-insensitive,
 * but we handle both spellings explicitly so the intent survives a future refactor onto a plain
 * object, and so the same helper behaves identically on POSIX.
 */
function withEnv(overrides: Record<string, string | undefined>, body: () => void): void {
  const keys = new Set<string>(Object.keys(overrides));
  if (keys.has("PATH") || keys.has("Path")) {
    keys.add("PATH");
    keys.add("Path");
  }
  const saved = new Map<string, string | undefined>();
  for (const key of keys) {
    saved.set(key, process.env[key]);
  }
  try {
    for (const key of keys) {
      const value = key in overrides ? overrides[key] : overrides["PATH"] ?? overrides["Path"];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    // Deliberately NO cache reset here: the cache must invalidate itself off the environment
    // fingerprint. Resetting would hide exactly the failure mode we are testing for.
    body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** The customer's machine: every PowerShell directory gone from PATH. */
function pathWithoutPowerShell(): string {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  return raw
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !/powershell/i.test(entry))
    .join(path.delimiter);
}

/** Create `file` (and its parents) as an empty placeholder binary. */
function touch(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
}

const WINDOWS_POWERSHELL_TAIL = path.join("WindowsPowerShell", "v1.0", "powershell.exe");

// ── 1. the decisive regression: a PATH with no PowerShell must still round-trip ────────────────

describe.skipIf(!isWindows)("DPAPI codec with the PowerShell directory stripped from PATH", () => {
  it(
    "write() → readState() still round-trips through a REAL powershell spawn (regression: spawnSync powershell.exe ENOENT)",
    { timeout: 120_000 },
    () => {
      const dir = freshDir();
      const strippedPath = pathWithoutPowerShell();
      // Guard: if PATH still contains a PowerShell directory the scenario is vacuous.
      expect(strippedPath.split(path.delimiter).some((e) => /powershell/i.test(e))).toBe(false);

      const credentials = {
        version: 2,
        serverTarget: "https://ai-game.dev",
        subject: "user-path-stripped",
        families: {
          plugin: {
            accessToken: "AT-no-powershell-on-path",
            refreshToken: "RT-no-powershell-on-path",
            expiresAt: "2099-01-01T00:00:00.000Z",
            clientId: "client-abc",
            scope: "mcp:plugin",
          },
        },
      };

      withEnv({ PATH: strippedPath, [DPAPI_POWERSHELL_HOST_ENV]: undefined }, () => {
        const store = new MachineCredentialStore(dir, dpapiCredentialCodec);
        store.write(credentials);

        // The bytes on disk really are DPAPI ciphertext, not plaintext that would fake a pass.
        const onDisk = fs.readFileSync(store.credentialsPath);
        expect(onDisk.includes(Buffer.from("AT-no-powershell-on-path", "utf-8"))).toBe(false);

        const state = store.readState();
        expect(state.status).toBe("ok");
        if (state.status !== "ok") return;
        // The written document carries the v1 compat mirror of the plugin family (04 §1).
        expect(state.credentials).toEqual(applyV1CompatMirror(credentials));
        expect(state.credentials.families?.plugin?.accessToken).toBe("AT-no-powershell-on-path");
        expect(state.credentials.families?.plugin?.refreshToken).toBe("RT-no-powershell-on-path");
      });
    },
  );
});

// ── 2/3. no resolvable host: structured error, and the store is left untouched ─────────────────

/** An environment in which NOTHING can resolve a PowerShell host. */
function noPowerShellAnywhereEnv(): Record<string, string | undefined> {
  const nowhere = path.join(freshDir("clicore-no-windows-"), "does-not-exist");
  return {
    [DPAPI_POWERSHELL_HOST_ENV]: undefined,
    SystemRoot: nowhere,
    windir: nowhere,
    PATH: "",
  };
}

describe.skipIf(!isWindows)("DPAPI codec with no PowerShell host resolvable at all", () => {
  it(
    "write() throws the structured unwritable error, not a raw ENOENT — and a WARM cache does not rescue it",
    { timeout: 120_000 },
    () => {
      const dir = freshDir();
      const store = new MachineCredentialStore(dir, dpapiCredentialCodec);

      // Warm the module-level host cache with a real, working resolution FIRST. If the cache could
      // leak across an environment change, this test would pass for the wrong reason.
      store.write({ accessToken: "warms-the-host-cache" });
      expect(store.exists).toBe(true);

      withEnv(noPowerShellAnywhereEnv(), () => {
        const blocked = new MachineCredentialStore(freshDir(), dpapiCredentialCodec);
        let thrown: unknown;
        try {
          blocked.write({ accessToken: "never-lands" });
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(MachineCredentialStoreUnwritableError);
        const error = thrown as MachineCredentialStoreUnwritableError;
        expect(error.message).toMatch(/machine credential store unwritable/);
        expect(error.message).toMatch(/WindowsPowerShell/);
        expect(error.message).toContain(DPAPI_POWERSHELL_HOST_ENV);
        // The raw spawn error is reachable for diagnostics but never in the user-facing message.
        expect(error.message).not.toMatch(/ENOENT/);
        expect(String((error.cause as Error | undefined)?.message ?? "")).toMatch(/PowerShell host/);
        // And the secret never rides along in the message.
        expect(error.message).not.toMatch(/never-lands/);
      });
    },
  );

  it(
    "an existing good credentials file survives byte-identically, with no new file and no temp sibling",
    { timeout: 120_000 },
    () => {
      const dir = freshDir();
      const store = new MachineCredentialStore(dir, dpapiCredentialCodec);
      store.write({ accessToken: "the-good-credential", refreshToken: "the-good-refresh" });

      const before = fs.readFileSync(store.credentialsPath);
      const entriesBefore = fs.readdirSync(dir).sort();

      withEnv(noPowerShellAnywhereEnv(), () => {
        expect(() => store.write({ accessToken: "must-not-land" })).toThrow(
          MachineCredentialStoreUnwritableError,
        );
      });

      expect(fs.readFileSync(store.credentialsPath).equals(before)).toBe(true);
      expect(fs.readdirSync(dir).sort()).toEqual(entriesBefore);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

      // And it is still the ORIGINAL credential, decryptable as before.
      const state = store.readState();
      expect(state.status).toBe("ok");
      if (state.status !== "ok") return;
      expect(state.credentials.accessToken).toBe("the-good-credential");
    },
  );
});

// ── 4. resolver preference order (pure env + fs — runs on every CI leg) ────────────────────────

describe("PowerShell host candidate resolution", () => {
  function fakeWindowsRoot(options: { system32?: boolean; sysWow64?: boolean }): {
    root: string;
    system32: string;
    sysWow64: string;
  } {
    const root = freshDir("clicore-fakewin-");
    const system32 = path.join(root, "System32", WINDOWS_POWERSHELL_TAIL);
    const sysWow64 = path.join(root, "SysWOW64", WINDOWS_POWERSHELL_TAIL);
    if (options.system32 !== false) touch(system32);
    if (options.sysWow64 !== false) touch(sysWow64);
    return { root, system32, sysWow64 };
  }

  it("prefers System32, then SysWOW64, then pwsh.exe, then powershell.exe", () => {
    const { root, system32, sysWow64 } = fakeWindowsRoot({});
    withEnv({ SystemRoot: root, windir: undefined, [DPAPI_POWERSHELL_HOST_ENV]: undefined }, () => {
      expect(powerShellHostCandidates()).toEqual([system32, sysWow64, "pwsh.exe", "powershell.exe"]);
    });
  });

  it("falls back to windir when SystemRoot is absent", () => {
    const { root, system32, sysWow64 } = fakeWindowsRoot({});
    withEnv({ SystemRoot: undefined, windir: root, [DPAPI_POWERSHELL_HOST_ENV]: undefined }, () => {
      expect(powerShellHostCandidates()).toEqual([system32, sysWow64, "pwsh.exe", "powershell.exe"]);
    });
  });

  it("skips an absolute candidate that does not exist (System32 host removed)", () => {
    const { root, sysWow64 } = fakeWindowsRoot({ system32: false });
    withEnv({ SystemRoot: root, windir: undefined, [DPAPI_POWERSHELL_HOST_ENV]: undefined }, () => {
      expect(powerShellHostCandidates()).toEqual([sysWow64, "pwsh.exe", "powershell.exe"]);
    });
  });

  it("offers only the bare names when no absolute host exists", () => {
    const { root } = fakeWindowsRoot({ system32: false, sysWow64: false });
    withEnv({ SystemRoot: root, windir: undefined, [DPAPI_POWERSHELL_HOST_ENV]: undefined }, () => {
      expect(powerShellHostCandidates()).toEqual(["pwsh.exe", "powershell.exe"]);
    });
  });

  it(`honours ${DPAPI_POWERSHELL_HOST_ENV} FIRST when it is an absolute path that exists`, () => {
    const { root, system32, sysWow64 } = fakeWindowsRoot({});
    const custom = touch(path.join(freshDir("clicore-custom-ps-"), "my-powershell.exe"));
    withEnv({ SystemRoot: root, windir: undefined, [DPAPI_POWERSHELL_HOST_ENV]: custom }, () => {
      expect(powerShellHostCandidates()).toEqual([custom, system32, sysWow64, "pwsh.exe", "powershell.exe"]);
    });
  });

  it("IGNORES a bare/relative override rather than spawning a PATH-resolved name from an env var", () => {
    const { root, system32, sysWow64 } = fakeWindowsRoot({});
    for (const relative of ["powershell.exe", path.join("tools", "powershell.exe"), "./powershell.exe"]) {
      withEnv({ SystemRoot: root, windir: undefined, [DPAPI_POWERSHELL_HOST_ENV]: relative }, () => {
        const candidates = powerShellHostCandidates();
        expect(candidates).toEqual([system32, sysWow64, "pwsh.exe", "powershell.exe"]);
        expect(candidates[0]).not.toBe(relative);
      });
    }
  });

  it("IGNORES an absolute override that does not exist", () => {
    const { root, system32, sysWow64 } = fakeWindowsRoot({});
    const missing = path.join(root, "nope", "powershell.exe");
    withEnv({ SystemRoot: root, windir: undefined, [DPAPI_POWERSHELL_HOST_ENV]: missing }, () => {
      const candidates = powerShellHostCandidates();
      expect(candidates).toEqual([system32, sysWow64, "pwsh.exe", "powershell.exe"]);
      expect(candidates).not.toContain(missing);
    });
  });

  it("IGNORES an empty/whitespace override", () => {
    const { root, system32, sysWow64 } = fakeWindowsRoot({});
    withEnv({ SystemRoot: root, windir: undefined, [DPAPI_POWERSHELL_HOST_ENV]: "   " }, () => {
      expect(powerShellHostCandidates()).toEqual([system32, sysWow64, "pwsh.exe", "powershell.exe"]);
    });
  });
});
