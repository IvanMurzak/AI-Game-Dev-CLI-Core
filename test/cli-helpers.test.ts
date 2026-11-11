import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JsonParseError,
  RQL_MUTATE_TOOL,
  RQL_QUERY_TOOL,
  RQL_SCHEMA_TOOL,
  UPDATE_CHECK_CACHE_TTL_MS,
  checkForNpmUpdate,
  compareNumericVersions,
  decodeQueryFile,
  emitProgress,
  fetchLatestNpmVersion,
  isNewerVersion,
  isNumericVersion,
  isRqlMutation,
  isRunningViaNpx,
  npmGlobalInstallCommand,
  parseJsonStrict,
  rqlLastVerb,
  rqlStages,
  stripToolName,
} from "../src/index.js";

const created: string[] = [];
function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-helpers-"));
  created.push(dir);
  return path.join(dir, name);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

function registry(version: string | undefined, status = 200): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(version === undefined ? {} : { version }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("numeric versions", () => {
  it("accepts dot-separated digits only", () => {
    expect(isNumericVersion("1")).toBe(true);
    expect(isNumericVersion("1.2")).toBe(true);
    expect(isNumericVersion("1.2.3.4")).toBe(true);
    expect(isNumericVersion("v1.2.3")).toBe(false);
    expect(isNumericVersion("1.2.3-beta")).toBe(false);
    expect(isNumericVersion("")).toBe(false);
  });

  it("compares component by component, a missing component is 0", () => {
    expect(compareNumericVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareNumericVersions("1.2", "1.2.0")).toBe(0);
    expect(compareNumericVersions("1.2.3", "1.10.0")).toBe(-1);
    expect(compareNumericVersions("2.0.0", "1.99.99")).toBe(1);
    expect(isNewerVersion("1.2.3", "1.2.4")).toBe(true);
    expect(isNewerVersion("1.2.4", "1.2.3")).toBe(false);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
  });
});

describe("npm update check", () => {
  it("fetches /<pkg>/latest from the registry", async () => {
    const fetchImpl = registry("9.9.9");
    await expect(fetchLatestNpmVersion("unity-mcp-cli", { fetchImpl })).resolves.toBe("9.9.9");
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe("https://registry.npmjs.org/unity-mcp-cli/latest");
  });

  it("uses the global fetch by default (CLI tests mock globalThis.fetch)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ version: "1.0.0" }), { status: 200 }));
    await expect(fetchLatestNpmVersion("godot-cli")).resolves.toBe("1.0.0");
  });

  it("throws on a non-OK status or a body without a version", async () => {
    await expect(fetchLatestNpmVersion("x", { fetchImpl: registry("1.0.0", 503) })).rejects.toThrow(/503/);
    await expect(fetchLatestNpmVersion("x", { fetchImpl: registry(undefined) })).rejects.toThrow(/No version field/);
  });

  it("reports a newer version and caches it; a fresh cache answers without the network", async () => {
    const cacheFile = tempFile("cli-update.json");
    const fetchImpl = registry("2.0.0");
    const now = () => 1_000_000;
    expect(await checkForNpmUpdate("1.0.0", { packageName: "p", cacheFile, fetchImpl, now })).toEqual({
      current: "1.0.0",
      latest: "2.0.0",
    });
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))).toEqual({ latestVersion: "2.0.0", lastChecked: 1_000_000 });

    const offline = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await checkForNpmUpdate("1.0.0", { packageName: "p", cacheFile, fetchImpl: offline, now })).toEqual({
      current: "1.0.0",
      latest: "2.0.0",
    });
    expect(offline).not.toHaveBeenCalled();
    expect(await checkForNpmUpdate("2.0.0", { packageName: "p", cacheFile, fetchImpl: offline, now })).toBeNull();
  });

  it("refetches once the cache is older than a day; ignores a corrupt cache; never throws", async () => {
    const cacheFile = tempFile("cli-update.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: "2.0.0", lastChecked: 0 }));
    const fetchImpl = registry("3.0.0");
    const later = () => UPDATE_CHECK_CACHE_TTL_MS + 1;
    expect(await checkForNpmUpdate("1.0.0", { packageName: "p", cacheFile, fetchImpl, now: later })).toEqual({
      current: "1.0.0",
      latest: "3.0.0",
    });

    fs.writeFileSync(cacheFile, "{corrupt");
    expect(await checkForNpmUpdate("3.0.0", { packageName: "p", cacheFile, fetchImpl })).toBeNull();

    const failing = registry("1.0.0", 500);
    expect(await checkForNpmUpdate("1.0.0", { packageName: "p", cacheFile: tempFile("none.json"), fetchImpl: failing })).toBeNull();
  });

  it("prints the update command alone and detects npx", () => {
    expect(npmGlobalInstallCommand("godot-cli")).toBe("npm i -g godot-cli");
    expect(isRunningViaNpx({ npm_execpath: "/usr/lib/node_modules/npm/bin/npx-cli.js" })).toBe(true);
    expect(isRunningViaNpx({ npm_command: "exec" })).toBe(true);
    expect(isRunningViaNpx({})).toBe(false);
  });
});

describe("parseJsonStrict", () => {
  it("parses valid JSON", () => {
    expect(parseJsonStrict('{"a":1}')).toEqual({ value: { a: 1 }, raw: '{"a":1}', wasStringified: false });
  });

  it("throws a JsonParseError with the position and a pointer snippet", () => {
    let error: unknown;
    try {
      parseJsonStrict('{"a":1,}');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(JsonParseError);
    const e = error as JsonParseError;
    expect(e.position).toBe(7);
    expect(e.message).toMatch(/^Invalid JSON at position 7: /);
    expect(e.snippet).toBe('{"a":1,}\n       ^');
  });
});

describe("RQL command-line routing", () => {
  it("names the three rql tools", () => {
    expect([RQL_QUERY_TOOL, RQL_MUTATE_TOOL, RQL_SCHEMA_TOOL]).toEqual(["rql-query", "rql-mutate", "rql-schema"]);
  });

  it("splits top-level stages only (not inside strings, identifiers, brackets, or ||)", () => {
    expect(rqlStages('objects | where name == "a|b" | count')).toEqual(["objects", 'where name == "a|b"', "count"]);
    expect(rqlStages("objects | where (a || b) | `x|y` | f([1|2])")).toEqual(["objects", "where (a || b)", "`x|y`", "f([1|2])"]);
    expect(rqlStages("a || b")).toEqual(["a || b"]);
    expect(rqlStages('a | where s == "q\\"|" | b')).toEqual(["a", 'where s == "q\\"|"', "b"]);
  });

  it("a last stage set / call is a mutation", () => {
    expect(rqlLastVerb("objects | set x = 1")).toBe("set");
    expect(rqlLastVerb("editor | CALL Save()")).toBe("call");
    expect(rqlLastVerb("objects | settings")).toBeUndefined();
    expect(isRqlMutation('objects | where name == "set" | count')).toBe(false);
    expect(isRqlMutation("objects | call Foo()")).toBe(true);
  });

  it("strips a pasted tool name", () => {
    expect(stripToolName("  rql-query console | count")).toBe("console | count");
    expect(stripToolName("rql-mutate objects | set a = 1")).toBe("objects | set a = 1");
    expect(stripToolName("rql-schema x")).toBe("rql-schema x");
  });

  it("decodes UTF-8 (with or without BOM) and UTF-16 LE / BE query files", () => {
    const text = 'objects | where name == "Ü"';
    expect(decodeQueryFile(Buffer.from(text, "utf-8"))).toBe(text);
    expect(decodeQueryFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf-8")]))).toBe(text);
    expect(decodeQueryFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]))).toBe(text);
    const be = Buffer.from(text, "utf16le").swap16();
    expect(decodeQueryFile(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(text);
  });
});

describe("emitProgress (generic)", () => {
  it("forwards a CLI's own event type and swallows a throwing sink", () => {
    type Narrow = { phase: "a" | "b"; message: string };
    const seen: Narrow[] = [];
    emitProgress<Narrow>((e) => seen.push(e), { phase: "a", message: "m" });
    expect(seen).toEqual([{ phase: "a", message: "m" }]);
    expect(() =>
      emitProgress<Narrow>(() => {
        throw new Error("sink");
      }, { phase: "b", message: "m" }),
    ).not.toThrow();
    expect(() => emitProgress(undefined, { phase: "x", message: "m" })).not.toThrow();
  });
});
