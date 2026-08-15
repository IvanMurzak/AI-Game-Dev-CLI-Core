import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MachineCredentialStore, identityCredentialCodec, type MachineCredentials } from "../src/index.js";

/**
 * Per-family `clientId` fidelity against the shared golden vector (review B1, x1 fix round 1):
 * `families.agent.clientId` and `families.plugin.clientId` used to be identical
 * (`"unity-mcp-plugin"` on both), so ANY assertion that only checks "does the family have A
 * clientId" — or that round-trips `vectors.v2Document` through `write()`/`read()` and compares the
 * result back to the SAME parsed vector — passes under a cross-family clientId swap, because both
 * the written input and the expected value move together (verified locally: swapping the vector's
 * two `clientId` strings left every existing vector-driven test green, TS and C# alike — the swap
 * is invisible to a write-then-read echo by construction, since clientId has no independent
 * derivation to check against, unlike `ProjectIdentity.DerivePin`).
 *
 * These two literals are therefore deliberately HARDCODED here, redundantly with the vector, so a
 * future accidental re-symmetrization (or an authoring mistake that swaps which family gets which
 * id) reddens this file even though it would NOT redden `machine-credentials-v2.test.ts`'s
 * round-trip test. `writeFamily` is exercised (not a bulk `write(vectors.v2Document)`) so a
 * hypothetical per-family write-routing bug (family A's data landing under family B's key) is also
 * caught, not just a vector-authoring mistake.
 */

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-cred-clientid-"));
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

// Hardcoded independently of the vector parse used below — the whole point of this file.
const EXPECTED_AGENT_CLIENT_ID = "agd-app-8f3a1c2e";
const EXPECTED_PLUGIN_CLIENT_ID = "unity-mcp-plugin";

describe("per-family clientId fidelity (golden vector, non-echo, review B1)", () => {
  it("the vector itself pins the expected literal under each family (sanity — fails loudly if the vector drifts)", () => {
    expect(vectors.v2Document.families?.agent?.clientId).toBe(EXPECTED_AGENT_CLIENT_ID);
    expect(vectors.v2Document.families?.plugin?.clientId).toBe(EXPECTED_PLUGIN_CLIENT_ID);
    expect(EXPECTED_AGENT_CLIENT_ID).not.toBe(EXPECTED_PLUGIN_CLIENT_ID);
  });

  it("writeFamily keeps each family's clientId under its OWN family key — never the other's", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.writeFamily("agent", {
      accessToken: "a",
      refreshToken: "r",
      clientId: EXPECTED_AGENT_CLIENT_ID,
      scope: "mcp:agent",
    });
    store.writeFamily("plugin", {
      accessToken: "a2",
      refreshToken: "r2",
      clientId: EXPECTED_PLUGIN_CLIENT_ID,
      scope: "mcp:plugin",
    });

    const read = store.read()!;
    expect(read.families?.agent?.clientId).toBe(EXPECTED_AGENT_CLIENT_ID);
    expect(read.families?.plugin?.clientId).toBe(EXPECTED_PLUGIN_CLIENT_ID);
    // The discriminating check: NOT merely "the two differ" (a swap keeps them differing from
    // each other too) — each is pinned to ITS OWN hardcoded literal, so a swap mismatches here.
    expect(read.families?.agent?.clientId).not.toBe(EXPECTED_PLUGIN_CLIENT_ID);
    expect(read.families?.plugin?.clientId).not.toBe(EXPECTED_AGENT_CLIENT_ID);
  });
});
