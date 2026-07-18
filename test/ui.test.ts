import { describe, expect, it } from "vitest";

import { renderTable, truncate, emitProgress } from "../src/index.js";

describe("ui — renderTable", () => {
  it("renders a box-drawn table sized to the widest cell", () => {
    const out = renderTable(["ID", "Location"], [["claude-code", ".mcp.json"], ["codex", ".codex/config.toml"]]);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^┌.*┐$/);
    expect(lines[lines.length - 1]).toMatch(/^└.*┘$/);
    expect(out).toContain("claude-code");
    expect(out).toContain(".codex/config.toml");
    // Every rendered line is the same width (aligned columns).
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });
});

describe("ui — truncate", () => {
  it("truncates with an ellipsis, never exceeding max", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a-very-long-value", 6)).toBe("a-ver…");
    expect(truncate("x", 0)).toBe("");
  });
});

describe("progress — emitProgress", () => {
  it("forwards events and swallows a throwing sink", () => {
    const seen: string[] = [];
    emitProgress((e) => seen.push(e.phase), { phase: "start", message: "m" });
    expect(seen).toEqual(["start"]);
    expect(() =>
      emitProgress(() => {
        throw new Error("boom");
      }, { phase: "x", message: "m" }),
    ).not.toThrow();
    expect(() => emitProgress(undefined, { phase: "x", message: "m" })).not.toThrow();
  });
});
