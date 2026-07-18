import { describe, expect, it } from "vitest";

import { isValidSemver, parseSemver, version } from "../src/index.js";

describe("parseSemver", () => {
  it("parses a well-formed core version", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("parses versions with multi-digit and zero components", () => {
    expect(parseSemver("10.0.42")).toEqual({ major: 10, minor: 0, patch: 42 });
    expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseSemver("  1.4.0  ")).toEqual({ major: 1, minor: 4, patch: 0 });
  });

  it("rejects leading zeros, partial, and non-numeric versions", () => {
    for (const bad of ["1.2", "1.2.3.4", "01.2.3", "v1.2.3", "1.2.3-rc.1", "", "abc"]) {
      expect(parseSemver(bad)).toBeNull();
    }
  });
});

describe("isValidSemver", () => {
  it("accepts valid and rejects invalid core versions", () => {
    expect(isValidSemver("2.0.1")).toBe(true);
    expect(isValidSemver("1.2")).toBe(false);
  });
});

describe("version", () => {
  it("exposes a valid semver string", () => {
    expect(isValidSemver(version)).toBe(true);
  });
});
