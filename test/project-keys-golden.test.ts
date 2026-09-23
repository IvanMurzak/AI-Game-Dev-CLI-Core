import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectKeyStore, PROJECT_KEYS_FILE_NAME, identityCredentialCodec, projectKeyCacheKey, type ProjectKeyEntry } from "../src/index.js";
import { issuerOrigin } from "../src/project-keys.js";

/**
 * Cross-language parity with the C# `ProjectKeyStore` (MCP-Plugin-dotnet), gated by the golden vector
 * authored there and vendored byte-identical (`McpPlugin/src/AgentConfig/project-keys.golden.json`).
 * Compares PARSED values — the two writers indent differently.
 */
const golden = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "golden-vectors", "project-keys.golden.json"), "utf-8"),
) as {
  issuerOrigins: Array<{ input: string; origin: string }>;
  invalidIssuers: string[];
  entryNames: Array<{ issuer: string; pin: string; name: string }>;
  invalidPins: string[];
  document: Record<string, unknown>;
  lookups: Array<{ issuer: string; pin: string; expectKey: string | null; expectSub?: string; expectKeyId?: string }>;
  put: { entry: ProjectKeyEntry; after: Record<string, unknown> };
  putIntoEmpty: { entry: ProjectKeyEntry; after: Record<string, unknown> };
};

const dirs: string[] = [];
function storeWith(document?: unknown): ProjectKeyStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-pkg-"));
  dirs.push(dir);
  if (document !== undefined) fs.writeFileSync(path.join(dir, PROJECT_KEYS_FILE_NAME), JSON.stringify(document));
  return new ProjectKeyStore(dir, identityCredentialCodec);
}
function readDoc(store: ProjectKeyStore): unknown {
  return JSON.parse(fs.readFileSync(store.filePath, "utf-8"));
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("project-keys golden vectors (C# ⇄ TS parity)", () => {
  it.each(golden.issuerOrigins)("issuer origin of $input", ({ input, origin }) => {
    expect(issuerOrigin(input)).toBe(origin);
  });

  it.each(golden.invalidIssuers)("rejects invalid issuer %j", (issuer) => {
    expect(() => projectKeyCacheKey(issuer, "aabbccdd")).toThrow();
  });

  it.each(golden.entryNames)("entry name for ($issuer, $pin)", ({ issuer, pin, name }) => {
    expect(projectKeyCacheKey(issuer, pin)).toBe(name);
  });

  it.each(golden.invalidPins)("rejects invalid pin %j", (pin) => {
    expect(() => projectKeyCacheKey("https://ai-game.dev", pin)).toThrow();
  });

  it.each(golden.lookups)("lookup ($issuer, $pin) in the golden document", ({ issuer, pin, expectKey, expectSub, expectKeyId }) => {
    const entry = storeWith(golden.document).get(issuer, pin);
    if (expectKey === null) {
      expect(entry).toBeUndefined();
      return;
    }
    expect(entry?.key).toBe(expectKey);
    expect(entry?.sub).toBe(expectSub);
    expect(entry?.keyId).toBe(expectKeyId);
  });

  it("put replaces one entry, preserving unknown top-level + entry fields and other entries", () => {
    const store = storeWith(golden.document);
    store.put(golden.put.entry);
    expect(readDoc(store)).toEqual(golden.put.after);
  });

  it("put into an empty store writes the canonical v1 document", () => {
    const store = storeWith();
    store.put(golden.putIntoEmpty.entry);
    expect(readDoc(store)).toEqual(golden.putIntoEmpty.after);
  });
});
