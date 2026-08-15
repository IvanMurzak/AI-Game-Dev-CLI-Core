import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CREDENTIALS_FILE_NAME, MachineCredentialStore, identityCredentialCodec, type MachineCredentials } from "../src/index.js";

/**
 * v2→v1-mirror readability (x1 scope item): an old-reader simulation that sees ONLY top-level
 * fields, against the shared golden vector.
 *
 * This is deliberately a SEPARATE, non-vacuous test from the existing "an old v1 reader of a v2
 * write sees the plugin family's tokens at top level" check in `machine-credentials-v2.test.ts`:
 * that test writes `vectors.v2Document` AS-IS, whose top-level fields already happen to match
 * `families.plugin` in the committed vector (it doubles as the round-trip fixture) — so removing
 * the mirror-application step from `write()` does NOT redden it (verified locally: a mandated
 * mirror-drop plant left that test green while `write() normalizes a STALE top-level mirror on
 * every v2 write` correctly went red instead). The test below strips the top-level triple from the
 * vector BEFORE writing, so the ONLY way the on-disk top level ends up correct is the real mirror
 * step — this is the discriminating "an old-reader-simulation vector fails if the v1 mirror is
 * dropped" case the x1 DoD calls for.
 */

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-cred-mirror-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const vectors = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "golden-vectors", "MachineCredentials.GoldenVectors.json"), "utf-8"),
) as { v2Document: MachineCredentials };

function rawDocument(dir: string): MachineCredentials {
  return JSON.parse(fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME), "utf-8")) as MachineCredentials;
}

describe("v2→v1-mirror readability (old-reader simulation, non-vacuous under a mirror-drop plant)", () => {
  it("an old v1-only reader sees the plugin family at top level even when the CALLER never set the mirror", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);

    // Strip the pre-baked top-level triple from the vector: this input has NO mirror at all — the
    // only source of truth for the top-level fields is `families.plugin`. If write() ever stopped
    // calling applyV1CompatMirror, the on-disk top level would be undefined here, not merely stale.
    const { accessToken: _a, refreshToken: _r, expiresAt: _e, ...withoutMirror } = vectors.v2Document;
    expect("accessToken" in withoutMirror).toBe(false);

    store.write(withoutMirror);

    const raw = rawDocument(dir);
    const pluginExpected = vectors.v2Document.families?.plugin;
    expect(raw.accessToken).toBe(pluginExpected?.accessToken);
    expect(raw.refreshToken).toBe(pluginExpected?.refreshToken);
    expect(raw.expiresAt).toBe(pluginExpected?.expiresAt);

    // Family-distinct vector values: must not be the agent family's tokens.
    expect(raw.accessToken).not.toBe(vectors.v2Document.families?.agent?.accessToken);
  });
});
