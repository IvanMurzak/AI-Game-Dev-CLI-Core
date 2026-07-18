import { describe, expect, it } from "vitest";

import { parseZip } from "../src/index.js";
import { makeZip } from "./zip-builder.js";

describe("unzip — parseZip", () => {
  it("reads STORED entries", () => {
    const zip = makeZip({ "a.txt": "hello", "dir/b.txt": "world" });
    const entries = parseZip(zip);
    const map = new Map(entries.map((e) => [e.path, e.bytes.toString("utf-8")]));
    expect(map.get("a.txt")).toBe("hello");
    expect(map.get("dir/b.txt")).toBe("world");
  });

  it("reads DEFLATE entries", () => {
    const payload = "x".repeat(5000);
    const zip = makeZip({ "big.txt": payload }, { deflate: true });
    const entries = parseZip(zip);
    expect(entries[0]!.bytes.toString("utf-8")).toBe(payload);
  });

  it("throws on a non-zip buffer", () => {
    expect(() => parseZip(Buffer.from("not a zip at all"))).toThrow(/End Of Central Directory/);
  });
});
