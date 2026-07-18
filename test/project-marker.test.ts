import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readProjectMarker,
  writeProjectMarker,
  projectMarkerPath,
  requireProjectPath,
  requireExistingPath,
  resolveProjectPathLadder,
} from "../src/index.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-marker-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("project-marker", () => {
  it("returns null when absent, writes + reads back, and merges preserving prior keys", () => {
    expect(readProjectMarker(tmp)).toBeNull();

    writeProjectMarker(tmp, { serverTarget: "https://ai-game.dev", portOverride: 23940 });
    expect(readProjectMarker(tmp)).toMatchObject({ serverTarget: "https://ai-game.dev", portOverride: 23940 });
    expect(fs.existsSync(projectMarkerPath(tmp))).toBe(true);

    writeProjectMarker(tmp, { serverTarget: "http://localhost:23940" });
    const merged = readProjectMarker(tmp)!;
    expect(merged.serverTarget).toBe("http://localhost:23940");
    expect(merged.portOverride).toBe(23940); // preserved
  });

  it("omits undefined-valued fields (C# WhenWritingNull parity)", () => {
    writeProjectMarker(tmp, { serverTarget: "https://ai-game.dev", portOverride: undefined });
    const raw = fs.readFileSync(projectMarkerPath(tmp), "utf-8");
    expect(raw).not.toContain("portOverride");
  });
});

describe("validation", () => {
  it("requireProjectPath resolves a non-empty string, rejects empty/non-string", () => {
    expect(requireProjectPath("x").ok).toBe(true);
    expect(requireProjectPath("").ok).toBe(false);
    expect(requireProjectPath(42).ok).toBe(false);
  });

  it("requireExistingPath checks existence", () => {
    expect(requireExistingPath(tmp).ok).toBe(true);
    expect(requireExistingPath(path.join(tmp, "nope")).ok).toBe(false);
  });

  it("resolveProjectPathLadder honours positional → path → cwd", () => {
    expect(resolveProjectPathLadder({ positional: "a", path: "b", cwd: "c" }).source).toBe("positional");
    expect(resolveProjectPathLadder({ path: "b", cwd: "c" }).source).toBe("path");
    expect(resolveProjectPathLadder({ cwd: tmp }).source).toBe("cwd");
  });
});
