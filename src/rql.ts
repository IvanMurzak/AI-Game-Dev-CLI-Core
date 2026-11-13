/**
 * RQL text from an engine CLI's command line: which rql-* tool a query goes to, and how a query file
 * is read. Engine-neutral: what a save writes on disk, the usage examples and the error hints stay in
 * each CLI.
 */

export const RQL_QUERY_TOOL = "rql-query";
export const RQL_MUTATE_TOOL = "rql-mutate";
export const RQL_SCHEMA_TOOL = "rql-schema";

/**
 * The text cut at each top-level `sep`: one outside string literals (either quote, backslash escapes honoured; an
 * unterminated one runs to the end), `backtick` identifiers (no escapes) and parentheses, brackets and braces. `||`
 * (RQL's or) is never a break. RQL has no comments. The one lexical scan behind {@link rqlStages} and
 * {@link splitRqlStatements}; segments come back untrimmed.
 */
function splitTopLevel(text: string, sep: "|" | ";"): string[] {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < text.length && text[i] !== ch; i++) if (ch !== "`" && text[i] === "\\") i++;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "|" && text[i + 1] === "|") {
      i++;
    } else if (ch === sep && depth === 0) {
      segments.push(text.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(text.slice(start));
  return segments;
}

/** The query's top-level stages (cut at `|` as {@link splitTopLevel} does; `||` is RQL's or), trimmed. */
export function rqlStages(query: string): string[] {
  return splitTopLevel(query, "|").map((s) => s.trim());
}

/** `set` or `call` when the query's last stage is one (it changes the editor), else `undefined` (it only reads). */
export function rqlLastVerb(query: string): "set" | "call" | undefined {
  const stages = rqlStages(query);
  const verb = /^(set|call)\b/i.exec(stages[stages.length - 1] ?? "")?.[1];
  return verb?.toLowerCase() as "set" | "call" | undefined;
}

/**
 * True when the text changes the editor (rql-mutate): some statement ends in `set` or `call`.
 * @deprecated Use {@link rqlToolFor} (or {@link rqlToolCall}); this is `rqlToolFor(text) === RQL_MUTATE_TOOL`.
 */
export function isRqlMutation(query: string): boolean {
  return rqlToolFor(query) === RQL_MUTATE_TOOL;
}

/**
 * The query without a leading tool name: tool texts write "rql-query <source> | ...", and agents
 * paste that whole into `rql`.
 */
export function stripToolName(query: string): string {
  return query.replace(/^\s*rql-(query|mutate)\s+/, "");
}

/**
 * The statements of RQL request text, exactly as RQL splits them (spec §14, `RqlParser.SplitStatements`; conformance
 * cases `fixtures/statements/cases.json`): cut at `;` as {@link splitTopLevel} does, trimmed, blank ones dropped.
 * Text without a separator is one statement; text of nothing but separators and blanks is one blank statement (RQL
 * reports the empty query). No statement cap: RQL reports too many itself.
 */
export function splitRqlStatements(text: string): string[] {
  const segments = splitTopLevel(text, ";").map(trimRql);
  if (segments.length === 1) return segments;
  const statements = segments.filter((s) => s !== "");
  return statements.length > 0 ? statements : segments.slice(0, 1);
}

/** .NET `String.Trim()` (RQL's trim): JavaScript's `trim()` also strips U+FEFF and keeps U+0085. */
function trimRql(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isRqlWhiteSpace(s.charCodeAt(a))) a++;
  while (b > a && isRqlWhiteSpace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** .NET `char.IsWhiteSpace`. */
function isRqlWhiteSpace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

/**
 * The text without a leading tool name on any of its statements ("rql-query actors | count; rql-query levels | count":
 * tool texts write the name, and agents paste it once per statement). Text of one statement comes back as
 * {@link stripToolName} returns it; several are re-joined with "; ".
 */
export function stripRqlToolNames(text: string): string {
  const statements = splitRqlStatements(text);
  return statements.length === 1 ? stripToolName(text) : statements.map(stripToolName).join("; ");
}

/**
 * The write RQL text asks for: `call` when any statement ends in call (a call may write nothing on purpose), else `set`
 * when any ends in set, else `undefined` (it only reads).
 */
export function rqlTextVerb(text: string): "set" | "call" | undefined {
  const verbs = splitRqlStatements(text).map((s) => rqlLastVerb(stripToolName(s)));
  return verbs.includes("call") ? "call" : verbs.includes("set") ? "set" : undefined;
}

/**
 * The rql-* tool for RQL text: rql-mutate when any statement ends in set / call, else rql-query. rql-mutate refuses
 * text in which another statement only reads (nothing runs), so that mix fails with RQL's own message instead of
 * running its reads.
 */
export function rqlToolFor(text: string): typeof RQL_QUERY_TOOL | typeof RQL_MUTATE_TOOL {
  return rqlTextVerb(text) === undefined ? RQL_QUERY_TOOL : RQL_MUTATE_TOOL;
}

/** The command-line options of an engine CLI's `rql` command that pick the tool and its input. */
export interface RqlCallOptions {
  /** `--schema [type]`: `true` without a type. */
  schema?: string | boolean;
  dryRun?: boolean;
  maxTargets?: number;
}

/** An rql-* tool and its input. */
export interface RqlToolCall {
  toolName: typeof RQL_QUERY_TOOL | typeof RQL_MUTATE_TOOL | typeof RQL_SCHEMA_TOOL;
  input: Record<string, unknown>;
}

/**
 * The rql-* tool call for an engine CLI's `rql` command line, or a usage error: `--schema [type]` goes to rql-schema
 * (never together with a query), else the text goes to {@link rqlToolFor}'s tool; `--dry-run` / `--max-targets` only
 * with rql-mutate. `noQueryUsage` is the CLI's own message for a missing or blank query (it names the CLI and an
 * engine example). The query is passed through as given: strip a pasted tool name first ({@link stripRqlToolNames}).
 */
export function rqlToolCall(
  query: string | undefined,
  options: RqlCallOptions,
  noQueryUsage: string,
): RqlToolCall | { usage: string } {
  const { schema, dryRun, maxTargets } = options;
  if (schema !== undefined) {
    // `rql --schema 'objects | count'` hands the query to --schema as its value.
    if (query !== undefined || (typeof schema === "string" && /[|\s]/.test(schema.trim()))) {
      return { usage: "Pass either a query or --schema [type] (a type name), not both." };
    }
    return { toolName: RQL_SCHEMA_TOOL, input: typeof schema === "string" ? { type: schema } : {} };
  }
  if (query === undefined || query.trim() === "") return { usage: noQueryUsage };
  if (rqlToolFor(query) === RQL_QUERY_TOOL) {
    if (dryRun || maxTargets !== undefined) {
      return { usage: "--dry-run and --max-targets are for a query with a statement ending in set / call." };
    }
    return { toolName: RQL_QUERY_TOOL, input: { query } };
  }
  return {
    toolName: RQL_MUTATE_TOOL,
    input: { query, ...(dryRun ? { dry_run: true } : {}), ...(maxTargets !== undefined ? { max_targets: maxTargets } : {}) },
  };
}

/** A query file's text: UTF-8, or UTF-16 with a byte-order mark (Windows PowerShell 5.1 writes `>` files so). */
export function decodeQueryFile(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  return bytes.toString("utf-8").replace(/^﻿/, "");
}
