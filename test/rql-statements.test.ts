import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RQL_MUTATE_TOOL,
  RQL_QUERY_TOOL,
  RQL_SCHEMA_TOOL,
  isRqlMutation,
  rqlStages,
  rqlTextVerb,
  rqlToolCall,
  rqlToolFor,
  splitRqlStatements,
  stripRqlToolNames,
} from "../src/index.js";

// Vendored from shared/RQL fixtures/statements/cases.json (spec §14): every runtime splits request text exactly so.
interface StatementCase {
  name: string;
  rql: string;
  statements: string[];
}
const cases = (
  JSON.parse(fs.readFileSync(new URL("./fixtures/rql-statements-cases.json", import.meta.url), "utf-8")) as {
    cases: StatementCase[];
  }
).cases;

describe("splitRqlStatements (RQL conformance cases)", () => {
  it("has the vendored cases", () => {
    expect(cases.length).toBeGreaterThan(10);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(splitRqlStatements(c.rql)).toEqual(c.statements);
  });

  it("trims as .NET does: U+0085 is whitespace, U+FEFF is not", () => {
    expect(splitRqlStatements("\u0085a\u0085; b")).toEqual(["a", "b"]);
    expect(splitRqlStatements("﻿a; b")).toEqual(["﻿a", "b"]);
  });

  it("does not cap the statement count (RQL reports too many itself)", () => {
    const text = Array.from({ length: 25 }, (_, i) => `s${i} | count`).join("; ");
    expect(splitRqlStatements(text)).toHaveLength(25);
  });

  it("empty statements, a trailing semicolon, blank text", () => {
    expect(splitRqlStatements("a | count;; ;b | count")).toEqual(["a | count", "b | count"]);
    expect(splitRqlStatements("a | count;")).toEqual(["a | count"]);
    expect(splitRqlStatements("a | count ;\n")).toEqual(["a | count"]);
    expect(splitRqlStatements("")).toEqual([""]);
    expect(splitRqlStatements("  ")).toEqual([""]);
    expect(splitRqlStatements(" ; ;")).toEqual([""]);
  });

  it("semicolons in strings, identifiers and brackets; quotes of the other kind inside a string", () => {
    expect(splitRqlStatements(`a | where n == "it's; ok"; b`)).toEqual([`a | where n == "it's; ok"`, "b"]);
    expect(splitRqlStatements(`a | where n == 'say "x;"'; b`)).toEqual([`a | where n == 'say "x;"'`, "b"]);
    expect(splitRqlStatements("a | where n == \"x\\\\\"; b")).toEqual(["a | where n == \"x\\\\\"", "b"]);
    expect(splitRqlStatements("a | where f([1; 2], {k: \";\"}); b")).toEqual(["a | where f([1; 2], {k: \";\"})", "b"]);
    expect(splitRqlStatements('a | where n == "unterminated; b')).toEqual(['a | where n == "unterminated; b']);
  });

  it("RQL has no comments: comment-like text does not hide a separator", () => {
    expect(splitRqlStatements("a | count -- note; b | count")).toEqual(["a | count -- note", "b | count"]);
    expect(splitRqlStatements("a | count // note; b | count")).toEqual(["a | count // note", "b | count"]);
    expect(splitRqlStatements("a | count /* x; */ b")).toEqual(["a | count /* x", "*/ b"]);
  });

  it("a backslash in a backtick identifier is no escape", () => {
    expect(splitRqlStatements("a | select `x\\`; b")).toEqual(["a | select `x\\`", "b"]);
  });
});

describe("rqlToolFor / rqlTextVerb", () => {
  it("routes reads to rql-query and any statement ending in set / call to rql-mutate", () => {
    expect(rqlToolFor("objects | count")).toBe(RQL_QUERY_TOOL);
    expect(rqlToolFor("objects | count; scenes | count")).toBe(RQL_QUERY_TOOL);
    expect(rqlToolFor("objects | set x = 1")).toBe(RQL_MUTATE_TOOL);
    expect(rqlToolFor("objects | count; editor | call Save()")).toBe(RQL_MUTATE_TOOL);
    expect(rqlToolFor("objects | set x = 1;")).toBe(RQL_MUTATE_TOOL);
  });

  it("mixed reads and writes go to rql-mutate wherever the write is", () => {
    expect(rqlToolFor("a | set x = 1; b | count")).toBe(RQL_MUTATE_TOOL);
    expect(rqlToolFor("a | count; b | count; c | call F()")).toBe(RQL_MUTATE_TOOL);
    expect(rqlToolFor("a | where x == 1 || y == 2 | set z = 3")).toBe(RQL_MUTATE_TOOL);
    expect(rqlToolFor("a | set x = 1 | count")).toBe(RQL_QUERY_TOOL);
  });

  it("a `;` or a verb inside a string does not route", () => {
    expect(rqlToolFor('objects | where name == "x; set"')).toBe(RQL_QUERY_TOOL);
    expect(rqlToolFor('objects | where name == "a;b | set y = 1"')).toBe(RQL_QUERY_TOOL);
  });

  it("ignores a pasted tool name on any statement", () => {
    expect(rqlToolFor("rql-mutate objects | count")).toBe(RQL_QUERY_TOOL);
    expect(rqlToolFor("rql-query a | count; rql-mutate b | set x = 1")).toBe(RQL_MUTATE_TOOL);
  });

  it("call wins over set; reads give no verb", () => {
    expect(rqlTextVerb("a | set x = 1; b | call F()")).toBe("call");
    expect(rqlTextVerb("a | set x = 1; b | count")).toBe("set");
    expect(rqlTextVerb("a | count")).toBeUndefined();
    expect(rqlTextVerb("")).toBeUndefined();
  });
});

describe("stripRqlToolNames", () => {
  it("strips the tool name of each statement", () => {
    expect(stripRqlToolNames("rql-query actors | count; rql-query levels | count")).toBe("actors | count; levels | count");
    expect(stripRqlToolNames("rql-mutate a | set x = 1;\n b | count")).toBe("a | set x = 1; b | count");
  });

  it("leaves one statement as stripToolName does (untrimmed tail kept)", () => {
    expect(stripRqlToolNames("  rql-query console | count  ")).toBe("console | count  ");
    expect(stripRqlToolNames("console | count")).toBe("console | count");
  });
});

describe("rqlStages (the same scanner)", () => {
  it("splits on top-level | only; || is or", () => {
    expect(rqlStages('a | where n == "x|y" || (b | c) | count')).toEqual(['a', 'where n == "x|y" || (b | c)', "count"]);
    expect(rqlStages("a | select `p|q`")).toEqual(["a", "select `p|q`"]);
  });
});

describe("isRqlMutation (deprecated)", () => {
  it("agrees with rqlToolFor, multi-statement text included", () => {
    expect(isRqlMutation("a | count; b | set x = 1")).toBe(true);
    expect(isRqlMutation("a | count; b | count")).toBe(false);
  });
});

describe("rqlToolCall", () => {
  const noQuery = "No query given: example-cli rql 'objects | count'";

  it("routes reads, writes and multi-statement text", () => {
    expect(rqlToolCall("a | count", {}, noQuery)).toEqual({ toolName: RQL_QUERY_TOOL, input: { query: "a | count" } });
    expect(rqlToolCall("a | count; b | set x = 1", { dryRun: true, maxTargets: 5 }, noQuery)).toEqual({
      toolName: RQL_MUTATE_TOOL,
      input: { query: "a | count; b | set x = 1", dry_run: true, max_targets: 5 },
    });
    expect(rqlToolCall("a | set x = 1", { dryRun: false }, noQuery)).toEqual({
      toolName: RQL_MUTATE_TOOL,
      input: { query: "a | set x = 1" },
    });
  });

  it("strips a pasted tool name from each statement before routing and sending", () => {
    expect(rqlToolCall("a | count; rql-mutate b | set x = 1", {}, noQuery)).toEqual({
      toolName: RQL_MUTATE_TOOL,
      input: { query: "a | count; b | set x = 1" },
    });
    expect(rqlToolCall("rql-query a | count", {}, noQuery)).toEqual({ toolName: RQL_QUERY_TOOL, input: { query: "a | count" } });
  });

  it("schema: with or without a type, never with a query", () => {
    expect(rqlToolCall(undefined, { schema: true }, noQuery)).toEqual({ toolName: RQL_SCHEMA_TOOL, input: {} });
    expect(rqlToolCall(undefined, { schema: "Light" }, noQuery)).toEqual({ toolName: RQL_SCHEMA_TOOL, input: { type: "Light" } });
    expect(rqlToolCall("a | count", { schema: true }, noQuery)).toHaveProperty("usage");
    expect(rqlToolCall(undefined, { schema: "objects | count" }, noQuery)).toHaveProperty("usage");
  });

  it("usage errors: no query, and --dry-run / --max-targets on reads", () => {
    expect(rqlToolCall(undefined, {}, noQuery)).toEqual({ usage: noQuery });
    expect(rqlToolCall("  ", {}, noQuery)).toEqual({ usage: noQuery });
    expect(rqlToolCall(" ; ;\u0085", {}, noQuery)).toEqual({ usage: noQuery });
    expect(rqlToolCall("a | count", { dryRun: true }, noQuery)).toHaveProperty("usage");
    expect(rqlToolCall("a | count", { maxTargets: 1 }, noQuery)).toHaveProperty("usage");
  });
});
