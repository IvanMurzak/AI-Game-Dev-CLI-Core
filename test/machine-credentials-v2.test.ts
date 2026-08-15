import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CREDENTIALS_FILE_NAME,
  MachineCredentialStore,
  MachineCredentialStoreUnreadableError,
  adoptToV2,
  applyV1CompatMirror,
  documentSchemaVersion,
  effectiveFamilies,
  identityCredentialCodec,
  type MachineCredentials,
} from "../src/index.js";

/**
 * Schema v2 store contract (unified-machine-auth 04 §1): families, v1 compat mirror, v1→v2
 * adoption, version passthrough, unknown-field preservation, and the structured "store
 * unreadable" state. Golden vectors are compared as PARSED VALUES (indent asymmetry, 04 §1).
 */

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-cred-v2-"));
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
  v2Document: MachineCredentials;
  v1Document: MachineCredentials;
  v1DocumentAdoptedToV2: MachineCredentials;
};

function rawDocument(dir: string): MachineCredentials {
  return JSON.parse(fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME), "utf-8")) as MachineCredentials;
}

describe("schema v2 — round-trip (golden vector)", () => {
  it("writes then reads back the canonical v2 document value-identically", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write(vectors.v2Document);
    expect(store.read()).toEqual(vectors.v2Document);
    // And the on-disk JSON parses to the same values (2-space indent is irrelevant by contract).
    expect(rawDocument(dir)).toEqual(vectors.v2Document);
  });

  it("an old v1 reader of a v2 write sees the plugin family's tokens at top level (compat mirror)", () => {
    const dir = freshDir();
    new MachineCredentialStore(dir, identityCredentialCodec).write(vectors.v2Document);
    // Simulate the shipped v1 reader: key on top-level accessToken/refreshToken/expiresAt only.
    const raw = rawDocument(dir);
    expect(raw.accessToken).toBe(vectors.v2Document.families?.plugin?.accessToken);
    expect(raw.refreshToken).toBe(vectors.v2Document.families?.plugin?.refreshToken);
    expect(raw.expiresAt).toBe(vectors.v2Document.families?.plugin?.expiresAt);
    // The mirror must be the PLUGIN family, not the agent family (family-distinct vector values).
    expect(raw.accessToken).not.toBe(vectors.v2Document.families?.agent?.accessToken);
  });
});

describe("schema v2 — version passthrough (04 §1, 06 §Rollback)", () => {
  it("write() persists the document's ACTUAL version — v2 stays 2, a future v3 stays 3", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);

    store.write(vectors.v2Document);
    expect(rawDocument(dir).version).toBe(2);

    store.write({ ...vectors.v2Document, version: 3 });
    expect(rawDocument(dir).version).toBe(3);
  });

  it("a v1-shaped document without a version still lands as version 1 (status quo for old callers)", () => {
    const dir = freshDir();
    new MachineCredentialStore(dir, identityCredentialCodec).write({ accessToken: "a", refreshToken: "r" });
    expect(rawDocument(dir).version).toBe(1);
  });

  it("a families-bearing document can NEVER land as version 1 (hybrid guard) and defaults to 2", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);

    // Caller bug: families + explicit version 1 — the forbidden hybrid must not hit disk.
    store.write({ ...vectors.v2Document, version: 1 });
    expect(rawDocument(dir).version).toBe(2);

    // Families + no version defaults to 2.
    const { version: _v, ...unversioned } = vectors.v2Document;
    store.write(unversioned);
    expect(rawDocument(dir).version).toBe(2);
  });

  it("documentSchemaVersion is the single passthrough rule", () => {
    expect(documentSchemaVersion({})).toBe(1);
    expect(documentSchemaVersion({ accessToken: "a" })).toBe(1);
    expect(documentSchemaVersion({ version: 1 })).toBe(1);
    expect(documentSchemaVersion({ families: {} })).toBe(2);
    expect(documentSchemaVersion({ version: 2, families: {} })).toBe(2);
    expect(documentSchemaVersion({ version: 1, families: {} })).toBe(2); // hybrid guard
    expect(documentSchemaVersion({ version: 3, families: {} })).toBe(3);
  });
});

describe("schema v2 — v1 read-compat and adoption (04 §1 / F11.1, golden vector)", () => {
  it("a v1 file reads as families.legacy through the effectiveFamilies view (no write happens)", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write(vectors.v1Document);
    const before = fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME));

    const read = store.read();
    expect(read).not.toBeNull();
    const families = effectiveFamilies(read!);
    expect(families.legacy).toEqual({
      accessToken: vectors.v1Document.accessToken,
      refreshToken: vectors.v1Document.refreshToken,
      expiresAt: vectors.v1Document.expiresAt,
    });
    expect(families.legacy?.clientId).toBeUndefined(); // unknown by definition (04 §1)
    expect(families.legacy?.scope).toBeUndefined();

    // Reading is a VIEW — the v1 file itself is untouched.
    expect(fs.readFileSync(path.join(dir, CREDENTIALS_FILE_NAME)).equals(before)).toBe(true);
  });

  it("adoptToV2 upgrades the golden v1 document to exactly the golden v2 adoption result", () => {
    expect(adoptToV2(vectors.v1Document)).toEqual(vectors.v1DocumentAdoptedToV2);
  });

  it("the first write by updated code (rotate) upgrades a v1 document to v2 + mirror on disk", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write(vectors.v1Document);

    store.rotate("rotated-access", "rotated-refresh", "2026-12-01T00:00:00.000Z");

    const raw = rawDocument(dir);
    expect(raw.version).toBe(2);
    // The old credential continued as families.legacy and carries the rotated material.
    expect(raw.families?.legacy).toEqual({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    // Mirror follows the plugin-plane (legacy, as the only plugin-plane credential).
    expect(raw.accessToken).toBe("rotated-access");
    expect(raw.refreshToken).toBe("rotated-refresh");
    // Identity + unknown fields survived the adoption.
    expect(raw.serverTarget).toBe(vectors.v1Document.serverTarget);
    expect(raw.subject).toBe(vectors.v1Document.subject);
    expect(raw.futureUnknownField).toBe("must-survive-adoption");
  });
});

describe("schema v2 — mirror emission (04 §1)", () => {
  it("writeFamily('plugin') emits the top-level mirror of exactly the plugin family", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.writeFamily(
      "agent",
      { accessToken: "agent-a", refreshToken: "agent-r", expiresAt: "2026-10-01T00:00:00.000Z", clientId: "unity-mcp-plugin", scope: "mcp:agent" },
      { serverTarget: "https://ai-game.dev", subject: "usr_1" },
    );
    store.writeFamily("plugin", {
      accessToken: "plugin-a",
      refreshToken: "plugin-r",
      expiresAt: "2026-10-02T00:00:00.000Z",
      clientId: "unity-mcp-plugin",
      scope: "mcp:plugin",
    });

    const raw = rawDocument(dir);
    expect(raw.version).toBe(2);
    expect(raw.accessToken).toBe("plugin-a");
    expect(raw.refreshToken).toBe("plugin-r");
    expect(raw.expiresAt).toBe("2026-10-02T00:00:00.000Z");
    expect(raw.families?.agent?.accessToken).toBe("agent-a"); // other family untouched
    expect(raw.serverTarget).toBe("https://ai-game.dev");
    expect(raw.subject).toBe("usr_1");
  });

  it("an agent-only document has NO top-level token mirror (no plugin-plane credential exists)", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.writeFamily("agent", {
      accessToken: "agent-a",
      refreshToken: "agent-r",
      clientId: "unity-mcp-plugin",
      scope: "mcp:agent",
    });
    const raw = rawDocument(dir);
    expect(raw.version).toBe(2);
    expect("accessToken" in raw).toBe(false);
    expect("refreshToken" in raw).toBe(false);
    expect("expiresAt" in raw).toBe(false);
    expect(raw.families?.agent?.accessToken).toBe("agent-a");
  });

  it("write() normalizes a STALE top-level mirror on every v2 write (choke-point rule)", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write({
      version: 2,
      accessToken: "stale-mirror", // lies about the plugin family
      families: { plugin: { accessToken: "true-a", refreshToken: "true-r", clientId: "c", scope: "mcp:plugin" } },
    });
    const raw = rawDocument(dir);
    expect(raw.accessToken).toBe("true-a");
    expect(raw.refreshToken).toBe("true-r");
  });

  it("applyV1CompatMirror leaves a v1 document untouched (its top-level fields ARE the credential)", () => {
    const v1 = { version: 1, accessToken: "a", refreshToken: "r", serverTarget: "s" };
    expect(applyV1CompatMirror(v1)).toEqual(v1);
  });
});

describe("schema v2 — unknown-field preservation (regression, 04 §1)", () => {
  it("unknown fields survive at document level, family level, and as whole unknown families", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    const document: MachineCredentials = {
      version: 2,
      serverTarget: "https://ai-game.dev",
      unknownTopLevel: { nested: true },
      families: {
        plugin: { accessToken: "a", refreshToken: "r", clientId: "c", scope: "mcp:plugin", unknownInFamily: 7 },
        futureFamily: { accessToken: "f", clientId: "c2", scope: "mcp:future" },
      },
    };
    store.write(document);

    const read = store.read();
    expect(read?.unknownTopLevel).toEqual({ nested: true });
    expect(read?.families?.plugin?.unknownInFamily).toBe(7);
    expect(read?.families?.futureFamily?.accessToken).toBe("f");
  });

  it("unknown fields survive rotate() on a v2 document, and non-target families are untouched", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write({
      version: 2,
      unknownTopLevel: "keep",
      families: {
        agent: { accessToken: "agent-a", refreshToken: "agent-r", clientId: "c", scope: "mcp:agent" },
        plugin: { accessToken: "old-a", refreshToken: "old-r", clientId: "c", scope: "mcp:plugin", unknownInFamily: "keep2" },
      },
    });

    store.rotate("new-a", "new-r", "2027-01-01T00:00:00.000Z");

    const raw = rawDocument(dir);
    expect(raw.unknownTopLevel).toBe("keep");
    // Rotation landed in the PLUGIN family (plugin-plane), preserving its unknown field...
    expect(raw.families?.plugin).toEqual({
      accessToken: "new-a",
      refreshToken: "new-r",
      expiresAt: "2027-01-01T00:00:00.000Z",
      clientId: "c",
      scope: "mcp:plugin",
      unknownInFamily: "keep2",
    });
    // ...the agent family is untouched, and the mirror follows the plugin family.
    expect(raw.families?.agent?.accessToken).toBe("agent-a");
    expect(raw.accessToken).toBe("new-a");
  });
});

describe("structured 'store unreadable' state (04 §1)", () => {
  const GARBAGE = Buffer.from([0x00, 0x01, 0xfe, 0xba, 0xad, 0xf0, 0x0d, 0x42, 0x99, 0x03]);

  it(
    "a corrupted at-rest blob yields status 'unreadable' via the DEFAULT codec — never a crash, never a delete " +
      "(real DPAPI unprotect failure on Windows; corrupted-content failure on POSIX)",
    { timeout: 120_000 },
    () => {
      const dir = freshDir();
      const credPath = path.join(dir, CREDENTIALS_FILE_NAME);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(credPath, GARBAGE);

      const store = new MachineCredentialStore(dir); // platform-default codec
      const state = store.readState();
      expect(state.status).toBe("unreadable");
      if (state.status === "unreadable") {
        expect(state.reason).toMatch(/decrypt|pars/i);
      }

      // The file exists — and that must never be read as signed-in — and is byte-for-byte intact.
      expect(store.exists).toBe(true);
      expect(fs.readFileSync(credPath).equals(GARBAGE)).toBe(true);
    },
  );

  it("read() surfaces the typed unreadable error, and background writers fail CLOSED without touching the file", () => {
    const dir = freshDir();
    const credPath = path.join(dir, CREDENTIALS_FILE_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credPath, "this is not JSON {{{{");
    const store = new MachineCredentialStore(dir, identityCredentialCodec);

    expect(() => store.read()).toThrow(MachineCredentialStoreUnreadableError);
    expect(() => store.rotate("a", "r")).toThrow(MachineCredentialStoreUnreadableError);
    expect(() =>
      store.writeFamily("plugin", { accessToken: "a", refreshToken: "r", clientId: "c", scope: "mcp:plugin" }),
    ).toThrow(MachineCredentialStoreUnreadableError);

    // Nothing overwrote or deleted the unreadable store.
    expect(fs.readFileSync(credPath, "utf-8")).toBe("this is not JSON {{{{");
  });

  it("only an EXPLICIT re-authorization may replace an unreadable store (writeFamily replaceUnreadable)", () => {
    const dir = freshDir();
    const credPath = path.join(dir, CREDENTIALS_FILE_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(credPath, "corrupted!!");
    const store = new MachineCredentialStore(dir, identityCredentialCodec);

    const written = store.writeFamily(
      "plugin",
      { accessToken: "fresh-a", refreshToken: "fresh-r", clientId: "c", scope: "mcp:plugin" },
      { serverTarget: "https://ai-game.dev", replaceUnreadable: true },
    );
    expect(written.families?.plugin?.accessToken).toBe("fresh-a");
    expect(store.readState().status).toBe("ok");
  });

  it("the 'unreadable' reason never leaks store content (B1): V8 parse errors quote input bytes", () => {
    const dir = freshDir();
    const credPath = path.join(dir, CREDENTIALS_FILE_NAME);
    fs.mkdirSync(dir, { recursive: true });
    // Decrypt SUCCEEDS (identity codec) but JSON.parse fails — on Node 22, V8's "Unexpected token"
    // message quotes the first ~10 chars of the parsed input, i.e. these token-like head bytes.
    const tokenLike = "eyJhbGciOi-SECRET-TOKEN-BYTES this is not JSON";
    fs.writeFileSync(credPath, tokenLike);
    const store = new MachineCredentialStore(dir, identityCredentialCodec);

    const state = store.readState();
    expect(state.status).toBe("unreadable");
    if (state.status === "unreadable") {
      // The reason is a UI/telemetry surface — no byte of the store content may reach it.
      expect(state.reason).not.toContain("eyJhbGciOi");
      expect(state.reason).not.toContain("SECRET");
      // Programmatic access to the parse error stays available on cause.
      expect(state.cause).toBeInstanceOf(SyntaxError);
    }

    // The typed error's message rides the same reason and must be equally clean.
    let thrown: unknown;
    try {
      store.read();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MachineCredentialStoreUnreadableError);
    expect((thrown as Error).message).not.toContain("eyJhbGciOi");
    expect((thrown as Error).message).not.toContain("SECRET");
  });

  it("a missing store is 'missing' — the unreadable state is never conflated with an empty store", () => {
    const store = new MachineCredentialStore(freshDir(), identityCredentialCodec);
    expect(store.readState().status).toBe("missing");
    expect(store.read()).toBeNull();
  });
});

describe("rotate() — v2 plugin-plane semantics", () => {
  it("rotate on an empty store creates a v2 document with families.legacy + mirror", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.rotate("a", "r");
    const raw = rawDocument(dir);
    expect(raw.version).toBe(2);
    expect(raw.families?.legacy?.accessToken).toBe("a");
    expect(raw.accessToken).toBe("a");
    expect(raw.refreshToken).toBe("r");
  });

  it("rotate without expiresAt CLEARS a stale expiry in both the family and the mirror", () => {
    const dir = freshDir();
    const store = new MachineCredentialStore(dir, identityCredentialCodec);
    store.write({
      version: 2,
      families: { plugin: { accessToken: "a", refreshToken: "r", expiresAt: "2026-01-01T00:00:00.000Z", clientId: "c", scope: "mcp:plugin" } },
    });
    store.rotate("a2", "r2");
    const raw = rawDocument(dir);
    expect("expiresAt" in (raw.families?.plugin ?? {})).toBe(false);
    expect("expiresAt" in raw).toBe(false);
    expect(raw.accessToken).toBe("a2");
  });
});
