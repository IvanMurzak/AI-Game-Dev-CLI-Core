import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIALS_FILE_NAME,
  MachineCredentialStore,
  identityCredentialCodec,
  type CredentialCodec,
  type MachineCredentials,
} from "../src/index.js";

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-cred-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const FULL: MachineCredentials = {
  accessToken: "access-abc",
  refreshToken: "refresh-xyz",
  expiresAt: "2026-01-01T00:00:00.000Z",
  serverTarget: "https://ai-game.dev",
  subject: "user-42",
};

/** A codec that wraps bytes with a marker so we can prove the codec is actually applied on disk. */
const taggingCodec: CredentialCodec = {
  encrypt: (plaintext) => Buffer.concat([Buffer.from("TAG:"), plaintext]),
  decrypt: (ciphertext) => ciphertext.subarray("TAG:".length),
};

describe("MachineCredentialStore — round-trip", () => {
  it("writes then reads back the FULL credential set, forcing version=1", () => {
    const store = new MachineCredentialStore(freshDir(), identityCredentialCodec);
    store.write(FULL);
    const read = store.read();
    expect(read).toMatchObject(FULL);
    expect(read?.version).toBe(1);
  });

  it("omits undefined fields (WhenWritingNull parity) and preserves unknown fields", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write({ accessToken: "a", serverTarget: undefined, custom: "keep-me" });
    const raw = fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME), "utf-8");
    expect(raw).not.toContain("serverTarget");
    expect(raw).not.toContain("refreshToken");
    const read = store.read();
    expect(read?.accessToken).toBe("a");
    expect(read?.custom).toBe("keep-me");
    expect("serverTarget" in (read ?? {})).toBe(false);
  });

  it("actually applies the codec to the on-disk bytes", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, taggingCodec);
    store.write(FULL);
    const raw = fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME));
    expect(raw.subarray(0, 4).toString()).toBe("TAG:");
    expect(store.read()).toMatchObject(FULL);
  });

  it("exists / delete behave, and reads of missing or empty files return null", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    expect(store.exists).toBe(false);
    expect(store.read()).toBeNull();

    store.write(FULL);
    expect(store.exists).toBe(true);

    fs.writeFileSync(path.join(dir, CREDENTIALS_FILE_NAME), "");
    expect(store.read()).toBeNull();

    store.delete();
    expect(store.exists).toBe(false);
    store.delete(); // no-op, no throw
  });
});

describe("MachineCredentialStore — atomic write / corruption safety (design 03 F4 / DoD)", () => {
  it("leaves no temp files behind after a successful write", () => {
    const dir = freshDir();
    new MachineCredentialStore(dir, identityCredentialCodec).write(FULL);
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("a failing (throwing) encrypt does NOT corrupt an existing good credential file", () => {
    const dir = freshDir();
    // First, a good write with a working codec.
    new MachineCredentialStore(dir, identityCredentialCodec).write(FULL);
    const before = fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME));

    // Now a write whose codec throws — must throw and NOT touch the existing file.
    const failing: CredentialCodec = {
      encrypt: () => {
        throw new Error("keystore unavailable");
      },
      decrypt: (c) => c,
    };
    const badStore = new MachineCredentialStore(dir, failing);
    expect(() => badStore.write({ accessToken: "should-not-land" })).toThrow(/keystore unavailable/);

    // The original good file is byte-for-byte intact, and readable.
    const after = fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME));
    expect(after.equals(before)).toBe(true);
    expect(new MachineCredentialStore(dir, identityCredentialCodec).read()).toMatchObject(FULL);

    // No temp files leaked.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a second successful write atomically replaces the first (last writer wins, no torn state)", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write({ accessToken: "first" });
    store.write({ accessToken: "second", subject: "s" });
    expect(store.read()).toMatchObject({ accessToken: "second", subject: "s" });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("MachineCredentialStore — rotate", () => {
  it("replaces token material while preserving identity + unknown fields", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write({ ...FULL, custom: "keep" });

    const rotated = store.rotate("new-access", "new-refresh", "2027-06-06T00:00:00.000Z");
    expect(rotated.accessToken).toBe("new-access");
    expect(rotated.refreshToken).toBe("new-refresh");
    expect(rotated.expiresAt).toBe("2027-06-06T00:00:00.000Z");
    expect(rotated.serverTarget).toBe(FULL.serverTarget);
    expect(rotated.subject).toBe(FULL.subject);

    const read = store.read();
    expect(read?.accessToken).toBe("new-access");
    expect(read?.serverTarget).toBe(FULL.serverTarget);
    expect(read?.custom).toBe("keep");
  });

  it("rotate on an empty store creates a fresh credential", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    const rotated = store.rotate("a", "r");
    expect(rotated.accessToken).toBe("a");
    expect(store.read()?.refreshToken).toBe("r");
  });
});

describe("MachineCredentialStore — real default-codec round-trip (platform at-rest form)", () => {
  it("round-trips through the platform default codec (real DPAPI on Windows / 0600 on POSIX)", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir); // default codec
    store.write(FULL);
    expect(store.read()).toMatchObject(FULL);

    if (process.platform === "win32") {
      // On Windows the on-disk bytes are DPAPI ciphertext, never the plaintext token.
      const raw = fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME));
      expect(raw.toString("utf-8")).not.toContain("access-abc");
    } else {
      // On POSIX the file is 0600.
      const mode = fs.statSync(path.join(dir, CREDENTIALS_FILE_NAME)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it.skipIf(process.platform !== "win32")(
    "Windows on-disk ciphertext is decryptable by an independent DPAPI unprotect (C# interop shape)",
    () => {
      const dir = freshDir();
      new MachineCredentialStore(dir).write(FULL);
      const cipher = fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME));
      const script =
        "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
        "$in=[Convert]::FromBase64String($env:AIGD_IN);" +
        "$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);" +
        "[System.Text.Encoding]::UTF8.GetString($out)";
      const plaintext = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf-8",
        env: { ...process.env, AIGD_IN: cipher.toString("base64") },
      });
      expect(plaintext).toContain("access-abc");
    },
  );
});
