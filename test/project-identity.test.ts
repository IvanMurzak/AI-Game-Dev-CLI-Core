import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  MAX_PORT,
  MIN_PORT,
  PIN_LENGTH,
  PORT_RANGE,
  derivePin,
  derivePinV2,
  derivePort,
  derivePortV2,
  deriveProjectIdentity,
  deriveProjectIdentityV2,
  deriveProjectPathHash,
  deriveProjectPathHashV2,
  normalize,
  normalizeV2,
  toLowerInvariant,
} from "../src/index.js";

/**
 * Cross-language parity is THE point of the identity module: this TS port MUST reproduce every
 * pin/port in the C# reference's committed golden-vector files byte-for-byte. Those files are
 * vendored VERBATIM under `test/golden-vectors/` (copied from
 * `MCP-Plugin-dotnet/McpPlugin/src/AgentConfig/ProjectIdentity.GoldenVectors{,.v2}.json`, the c1
 * artifact). We read and parse the vendored files here rather than re-typing the vectors so parity
 * is gated against the exact same bytes LIB is gated against — re-sync = re-copy the two JSON files.
 */

interface GoldenVector {
  path: string;
  pin: string;
  port: number;
  note: string;
}

interface GoldenFile {
  vectors: GoldenVector[];
  unicodeDivergence: {
    cases: Array<{
      path: string;
      canonical: { pin: string; port: number };
      jsNaiveToLowerCase: { pin: string; port: number };
    }>;
  };
  separatorEquivalence?: {
    pairs: Array<{ backslash: string; forwardSlash: string; pin: string; port: number }>;
  };
}

function loadGolden(name: string): GoldenFile {
  const url = new URL(`./golden-vectors/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as GoldenFile;
}

const V1 = loadGolden("ProjectIdentity.GoldenVectors.json");
const V2 = loadGolden("ProjectIdentity.GoldenVectors.v2.json");

describe("ProjectIdentity v1 — golden-vector parity (byte-for-byte with the C# reference)", () => {
  for (const vector of V1.vectors) {
    it(`v1 pin+port match for ${JSON.stringify(vector.path)} (${vector.note})`, () => {
      expect(derivePin(vector.path)).toBe(vector.pin);
      expect(derivePort(vector.path)).toBe(vector.port);

      const identity = deriveProjectIdentity(vector.path);
      expect(identity.pin).toBe(vector.pin);
      expect(identity.port).toBe(vector.port);
      expect(identity.portIsOverridden).toBe(false);

      // The pin is the lowercase-hex prefix of the full 64-char project path hash.
      const full = deriveProjectPathHash(vector.path);
      expect(full).toHaveLength(64);
      expect(full).toMatch(/^[0-9a-f]{64}$/);
      expect(full.startsWith(vector.pin)).toBe(true);
    });
  }

  it("v1 reproduces the canonical U+0130 value and NOT the naive JS toLowerCase() value", () => {
    const divergence = V1.unicodeDivergence.cases[0];
    expect(divergence).toBeDefined();
    expect(derivePin(divergence!.path)).toBe(divergence!.canonical.pin);
    expect(derivePort(divergence!.path)).toBe(divergence!.canonical.port);
    expect(derivePin(divergence!.path)).not.toBe(divergence!.jsNaiveToLowerCase.pin);
    expect(derivePort(divergence!.path)).not.toBe(divergence!.jsNaiveToLowerCase.port);
  });

  it("v1 does NOT normalize separators: backslash and forward-slash Windows forms differ", () => {
    expect(derivePin("C:\\Users\\user\\my-game")).not.toBe(derivePin("C:/Users/user/my-game"));
    expect(derivePort("C:\\Users\\user\\my-game")).not.toBe(derivePort("C:/Users/user/my-game"));
  });
});

describe("ProjectIdentity v2 — golden-vector parity (byte-for-byte with the C# reference)", () => {
  for (const vector of V2.vectors) {
    it(`v2 pin+port match for ${JSON.stringify(vector.path)} (${vector.note})`, () => {
      expect(derivePinV2(vector.path)).toBe(vector.pin);
      expect(derivePortV2(vector.path)).toBe(vector.port);

      const identity = deriveProjectIdentityV2(vector.path);
      expect(identity.pin).toBe(vector.pin);
      expect(identity.port).toBe(vector.port);
      expect(identity.portIsOverridden).toBe(false);

      const full = deriveProjectPathHashV2(vector.path);
      expect(full).toHaveLength(64);
      expect(full.startsWith(vector.pin)).toBe(true);
    });
  }

  it("v2 reproduces the canonical U+0130 value and NOT the naive JS toLowerCase() value", () => {
    const divergence = V2.unicodeDivergence.cases[0];
    expect(divergence).toBeDefined();
    expect(derivePinV2(divergence!.path)).toBe(divergence!.canonical.pin);
    expect(derivePortV2(divergence!.path)).toBe(divergence!.canonical.port);
    expect(derivePinV2(divergence!.path)).not.toBe(divergence!.jsNaiveToLowerCase.pin);
  });

  it("v2 DEFINING property (B5 fix): backslash and forward-slash forms produce the SAME pin/port", () => {
    for (const pair of V2.separatorEquivalence?.pairs ?? []) {
      expect(derivePinV2(pair.backslash)).toBe(pair.pin);
      expect(derivePinV2(pair.forwardSlash)).toBe(pair.pin);
      expect(derivePinV2(pair.backslash)).toBe(derivePinV2(pair.forwardSlash));
      expect(derivePortV2(pair.backslash)).toBe(pair.port);
      expect(derivePortV2(pair.forwardSlash)).toBe(pair.port);
    }
  });

  it("v2 == v1 for paths with no backslash (POSIX)", () => {
    for (const p of ["/home/user/my-game", "/srv/games/space sim", "/home/İstanbul/game"]) {
      expect(derivePinV2(p)).toBe(derivePin(p));
      expect(derivePortV2(p)).toBe(derivePort(p));
    }
  });
});

describe("ProjectIdentity — normalization", () => {
  it("trims trailing separators (both / and \\) but keeps at least one char", () => {
    expect(normalize("/a/b/")).toBe("/a/b");
    expect(normalize("/a/b\\")).toBe("/a/b");
    expect(normalize("/a/b///")).toBe("/a/b");
    expect(normalize("/")).toBe("/");
  });

  it("v1 lowercases invariantly (ASCII folds; U+0130 preserved)", () => {
    expect(normalize("/Home/USER/My-Game")).toBe("/home/user/my-game");
    expect(toLowerInvariant("İ")).toBe("İ");
    expect("İ".toLowerCase()).not.toBe("İ"); // sanity: the naive fold DOES change it
  });

  it("v1 does not convert separators during normalization", () => {
    expect(normalize("C:\\A")).toBe("c:\\a");
    expect(normalize("C:/A")).toBe("c:/a");
    expect(normalize("C:\\A")).not.toBe(normalize("C:/A"));
  });

  it("v2 converts backslashes to forward slashes during normalization", () => {
    expect(normalizeV2("C:\\A")).toBe("c:/a");
    expect(normalizeV2("C:/A")).toBe("c:/a");
    expect(normalizeV2("C:\\A")).toBe(normalizeV2("C:/A"));
    // trailing backslash trimmed first, then the rest converted
    expect(normalizeV2("C:\\Users\\me\\")).toBe("c:/users/me");
  });
});

describe("ProjectIdentity — derivation surface", () => {
  it("an explicit port override wins for port but never for pin (v1 and v2)", () => {
    for (const derive of [deriveProjectIdentity, deriveProjectIdentityV2]) {
      const base = derive("/home/user/my-game");
      const overridden = derive("/home/user/my-game", 51234);
      expect(overridden.port).toBe(51234);
      expect(overridden.portIsOverridden).toBe(true);
      expect(overridden.pin).toBe(base.pin);
    }
  });

  it("null/undefined override yields the hash-derived port", () => {
    expect(deriveProjectIdentity("/home/user/my-game", null).port).toBe(23940);
    expect(deriveProjectIdentity("/home/user/my-game", undefined).port).toBe(23940);
    expect(deriveProjectIdentity("/home/user/my-game", null).portIsOverridden).toBe(false);
  });

  it("pin length + port range invariants hold", () => {
    expect(PIN_LENGTH).toBe(8);
    expect(PORT_RANGE).toBe(10000);
    expect(MAX_PORT - MIN_PORT + 1).toBe(PORT_RANGE);
    for (const p of ["/a", "/b", "/c/d/e", "C:\\x\\y", "/srv/games/space sim", "/home/İstanbul/game"]) {
      for (const port of [derivePort(p), derivePortV2(p)]) {
        expect(port).toBeGreaterThanOrEqual(MIN_PORT);
        expect(port).toBeLessThanOrEqual(MAX_PORT);
      }
      expect(derivePin(p)).toHaveLength(PIN_LENGTH);
      expect(derivePinV2(p)).toHaveLength(PIN_LENGTH);
    }
  });
});
