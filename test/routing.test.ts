import { describe, expect, it } from "vitest";

import { pinUrl, stripPinFromUrl } from "../src/index.js";

describe("routing — pinUrl / stripPinFromUrl", () => {
  it("appends /p/<pin> to a hub URL, preserving scheme/host/port and path", () => {
    expect(pinUrl("https://ai-game.dev/mcp", "34ea75f2")).toBe("https://ai-game.dev/mcp/p/34ea75f2");
    expect(pinUrl("http://localhost:23940", "deadbeef")).toBe("http://localhost:23940/p/deadbeef");
  });

  it("replaces an existing trailing pin rather than stacking", () => {
    expect(pinUrl("https://ai-game.dev/mcp/p/aaaaaaaa", "34ea75f2")).toBe("https://ai-game.dev/mcp/p/34ea75f2");
  });

  it("does not treat a non-pin trailing segment as a pin", () => {
    // 'notapin!' is not 8-hex → not stripped; /p/<pin> is appended after it.
    expect(pinUrl("https://ai-game.dev/mcp/foo", "34ea75f2")).toBe("https://ai-game.dev/mcp/foo/p/34ea75f2");
  });

  it("stripPinFromUrl removes a trailing pin (round-trips with pinUrl)", () => {
    const pinned = pinUrl("https://ai-game.dev/mcp", "34ea75f2");
    expect(stripPinFromUrl(pinned)).toBe("https://ai-game.dev/mcp");
    expect(stripPinFromUrl("https://ai-game.dev/mcp")).toBe("https://ai-game.dev/mcp");
  });
});
