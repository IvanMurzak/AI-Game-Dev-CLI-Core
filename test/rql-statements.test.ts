import * as fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RQL_MAX_STATEMENTS,
  RQL_MUTATE_TOOL,
  RQL_QUERY_TOOL,
  rqlTextVerb,
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
    const text = Array.from({ length: RQL_MAX_STATEMENTS + 1 }, (_, i) => `s${i} | count`).join("; ");
    expect(RQL_MAX_STATEMENTS).toBe(10);
    expect(splitRqlStatements(text)).toHaveLength(11);
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
