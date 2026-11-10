import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  decideLocalFallback,
  machineCredentialStatus,
  signedInButUnusableMessage,
} from "../src/local-fallback.js";
import { CREDENTIALS_FILE_NAME, MachineCredentialStore, identityCredentialCodec } from "../src/machine-credentials.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function storeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-core-fallback-"));
  dirs.push(dir);
  return dir;
}

describe("decideLocalFallback", () => {
  it("uses the cloud whenever it has its sign-in, without reading the store", () => {
    let reads = 0;
    expect(decideLocalFallback({ cloudSignInMissing: false, credentialStatus: () => (reads++, "missing") })).toBe("use-cloud");
    expect(reads).toBe(0);
  });

  it("falls back only when the machine never signed in", () => {
    expect(decideLocalFallback({ cloudSignInMissing: true, credentialStatus: "missing" })).toBe("fallback");
    expect(decideLocalFallback({ cloudSignInMissing: true, credentialStatus: () => "missing" })).toBe("fallback");
  });

  it("refuses a signed-in machine whose sign-in cannot be used (ok but unusable, or unreadable)", () => {
    expect(decideLocalFallback({ cloudSignInMissing: true, credentialStatus: "ok" })).toBe("refuse-signed-in");
    expect(decideLocalFallback({ cloudSignInMissing: true, credentialStatus: "unreadable" })).toBe("refuse-signed-in");
  });

  it("the refusal message names the CLI's login", () => {
    expect(signedInButUnusableMessage("godot-cli")).toContain("Run `godot-cli login`");
  });
});

describe("machineCredentialStatus", () => {
  it("reads the store: missing, ok, unreadable", () => {
    const dir = storeDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    expect(machineCredentialStatus(store)).toBe("missing");
    store.write({ accessToken: "t" });
    expect(machineCredentialStatus(store)).toBe("ok");
    fs.writeFileSync(path.join(dir, CREDENTIALS_FILE_NAME), "{not json");
    expect(machineCredentialStatus(store)).toBe("unreadable");
  });

  it("a store that throws counts as unreadable, never missing", () => {
    const broken = { readState: () => { throw new Error("boom"); } } as unknown as MachineCredentialStore;
    expect(machineCredentialStatus(broken)).toBe("unreadable");
  });
});
