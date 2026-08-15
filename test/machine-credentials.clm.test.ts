import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIALS_FILE_NAME,
  MachineCredentialStore,
  MachineCredentialStoreUnreadableError,
  dpapiCredentialCodec,
} from "../src/index.js";

/**
 * PowerShell **Constrained Language Mode** leg (unified-machine-auth 04 §1/§4): under WDAC/AppLocker
 * lockdown, `Add-Type` (and every .NET method call) is blocked, so the DPAPI codec's PowerShell
 * shell-out fails. The store must degrade GRACEFULLY: surface the structured "store unreadable"
 * state — never crash the caller with a raw spawn error, never delete, never overwrite until an
 * explicit re-authorization.
 *
 * This suite only runs on the dedicated CI leg, which locks powershell.exe down by setting the
 * machine-scoped `__PSLockdownPolicy=4` env var (the SystemPolicy debug hook reads MACHINE scope —
 * a process-scoped variable does NOT engage, verified 2026-08-14) and then sets `AIGD_EXPECT_CLM=1`.
 * When `AIGD_EXPECT_CLM=1` is present the suite is MANDATORY and first PROVES the lockdown engaged —
 * without that guard the whole leg would pass vacuously on a runner where the hook stopped working.
 */

const expectClm = process.env.AIGD_EXPECT_CLM === "1" && process.platform === "win32";
const describeClm = expectClm ? describe : describe.skip;

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-cred-clm-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describeClm("machine credential store under PowerShell Constrained Language Mode", () => {
  it("engagement guard: powershell.exe really is in ConstrainedLanguage (else this leg proves nothing)", () => {
    const mode = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "$ExecutionContext.SessionState.LanguageMode"],
      { encoding: "utf-8", timeout: 30000, windowsHide: true },
    ).trim();
    expect(mode).toBe("ConstrainedLanguage");
  });

  it(
    "reading an existing store degrades to the structured 'unreadable' state — never crash, never delete",
    { timeout: 120_000 },
    () => {
      const dir = freshDir();
      const credPath = path.join(dir, CREDENTIALS_FILE_NAME);
      // Any bytes: with the codec blocked, NO blob is decryptable — including a perfectly valid one.
      const blob = Buffer.from("01000000d08c9ddf0115d1118c7a00c04fc297eb-not-really-dpapi", "utf-8");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(credPath, blob);

      const store = new MachineCredentialStore(dir, dpapiCredentialCodec);
      const state = store.readState();
      expect(state.status).toBe("unreadable");

      // `exists` is true — which is exactly why exists is never a signed-in signal (04 §1).
      expect(store.exists).toBe(true);
      // The file survives byte-for-byte: no delete, no rewrite.
      expect(fs.readFileSync(credPath).equals(blob)).toBe(true);
    },
  );

  it(
    "read() throws the TYPED unreadable error and rotate() fails CLOSED without touching the file",
    { timeout: 120_000 },
    () => {
      const dir = freshDir();
      const credPath = path.join(dir, CREDENTIALS_FILE_NAME);
      const blob = Buffer.from("blocked-codec-blob", "utf-8");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(credPath, blob);

      const store = new MachineCredentialStore(dir, dpapiCredentialCodec);
      expect(() => store.read()).toThrow(MachineCredentialStoreUnreadableError);
      expect(() => store.rotate("new-access", "new-refresh")).toThrow(MachineCredentialStoreUnreadableError);
      expect(fs.readFileSync(credPath).equals(blob)).toBe(true);
    },
  );

  it(
    "write() of a fresh credential fails closed BEFORE touching disk (encrypt is blocked) — no half-writes, no litter",
    { timeout: 120_000 },
    () => {
      const dir = freshDir();
      const store = new MachineCredentialStore(dir, dpapiCredentialCodec);
      expect(() => store.write({ accessToken: "never-lands" })).toThrow();
      expect(store.exists).toBe(false);
      const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")) : [];
      expect(leftovers).toEqual([]);
    },
  );
});
