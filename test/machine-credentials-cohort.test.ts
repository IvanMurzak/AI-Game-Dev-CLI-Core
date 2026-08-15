import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIALS_FILE_NAME,
  MachineCredentialStore,
  adoptToV2,
  effectiveFamilies,
  identityCredentialCodec,
  type MachineCredentials,
} from "../src/index.js";

/**
 * One case per `06-migration-rollout.md` cohort row that has a store FILE-SHAPE (v1-only reader,
 * mixed writer, legacy family) — O4 REVISED: "no cohort regresses below status quo at any
 * intermediate step", each verified here against the committed `MachineCredentials.GoldenVectors.json`
 * shared with the C# twin (task x1). The TS twin of `MachineCredentialsCohortTests.cs`.
 */

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-cred-cohort-"));
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
) as {
  v1Document: MachineCredentials;
  cohortMixedVersionsOldWriterCollapse: {
    document: MachineCredentials;
    reAdoptedOnNextUpdatedWrite: MachineCredentials;
  };
};

function rawDocument(dir: string): MachineCredentials {
  return JSON.parse(fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME), "utf-8")) as MachineCredentials;
}

describe("cohort — credential minted by own plugin (v1 file), 06 row 1", () => {
  it("an old (v1-only) reader and an updated reader see IDENTICAL token values — status quo", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write(vectors.v1Document);

    // The OLD reader simulation: raw top-level fields only (no families concept).
    const raw = rawDocument(dir);
    const oldReaderAccessToken = raw.accessToken;
    const oldReaderRefreshToken = raw.refreshToken;

    // The UPDATED reader: the effectiveFamilies VIEW (04 §1 v1 read-compat) — a plain v1 document's
    // `families` key stays absent on disk (TS `read()` does not auto-adopt, unlike the C# store's
    // `TryRead()`); `effectiveFamilies` is the primitive updated code uses to see families.legacy
    // without a write, so this is the correct "updated reader" simulation, not `.families` directly.
    const updated = store.read()!;
    const families = effectiveFamilies(updated);
    expect(families.legacy?.accessToken).toBe(oldReaderAccessToken);
    expect(families.legacy?.refreshToken).toBe(oldReaderRefreshToken);
    expect(families.legacy?.accessToken).toBe(vectors.v1Document.accessToken);
  });
});

describe("cohort — mixed versions (updated writer + old reader), 06 row 4", () => {
  it("an old-writer collapse to pure v1 heals to the golden re-adopted shape on the next updated write", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    const { document: collapsed, reAdoptedOnNextUpdatedWrite: expectedHealed } = vectors.cohortMixedVersionsOldWriterCollapse;

    // Plant the collapsed pure-v1 on-disk shape, exactly as an old C# Rotate() (that predates the
    // families schema and drops families.* on write) would have left it.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CREDENTIALS_FILE_NAME), JSON.stringify(collapsed));
    expect(collapsed.version).toBe(1); // sanity: the vector really is v1-shaped

    // The next updated-component touch: read, adoptToV2 (families.legacy in-memory — the same
    // primitive rotate()/writeFamily() use internally; a bare read()+write() is a NO-OP passthrough
    // in TS, unlike the C# store where TryRead() auto-adopts on every read), write (persists v2 +
    // mirror) — 04 §1 "first write by updated code upgrades".
    const credentials = store.read()!;
    const adopted = adoptToV2(credentials);
    store.write(adopted);

    const raw = rawDocument(dir);
    expect(raw.version).toBe(expectedHealed.version);
    expect(raw.accessToken).toBe(expectedHealed.accessToken);
    expect(raw.refreshToken).toBe(expectedHealed.refreshToken);
    expect(raw.serverTarget).toBe(expectedHealed.serverTarget);
    expect(raw.subject).toBe(expectedHealed.subject);
    expect(raw.families?.legacy).toEqual(expectedHealed.families?.legacy);

    // Provenance was genuinely lost by the collapse (clientId/scope) — same as any legacy family.
    expect(store.read()?.families?.legacy?.clientId).toBeUndefined();
    expect(store.read()?.families?.legacy?.scope).toBeUndefined();
  });
});
