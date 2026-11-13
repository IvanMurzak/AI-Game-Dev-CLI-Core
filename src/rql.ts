/**
 * RQL text from an engine CLI's command line: which rql-* tool a query goes to, and how a query file
 * is read. Engine-neutral: what a save writes on disk, the usage examples and the error hints stay in
 * each CLI.
 */

export const RQL_QUERY_TOOL = "rql-query";
export const RQL_MUTATE_TOOL = "rql-mutate";
export const RQL_SCHEMA_TOOL = "rql-schema";

/**
 * The query's top-level stages (split on `|` outside strings, `backtick` identifiers, parentheses,
 * brackets and braces; `||` is RQL's or, not a stage break), trimmed.
 */
export function rqlStages(query: string): string[] {
  const stages: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (quote) {
      if (ch === "\\" && quote !== "`") i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "|" && query[i + 1] === "|") {
      i++;
    } else if (ch === "|" && depth === 0) {
      stages.push(query.slice(start, i).trim());
      start = i + 1;
    }
  }
  stages.push(query.slice(start).trim());
  return stages;
}

/** `set` or `call` when the query's last stage is one (it changes the editor), else `undefined` (it only reads). */
export function rqlLastVerb(query: string): "set" | "call" | undefined {
  const stages = rqlStages(query);
  const verb = /^(set|call)\b/i.exec(stages[stages.length - 1] ?? "")?.[1];
  return verb?.toLowerCase() as "set" | "call" | undefined;
}

/** A query whose last stage is `set` or `call` changes the editor (rql-mutate); any other only reads (rql-query). */
export function isRqlMutation(query: string): boolean {
  return rqlLastVerb(query) !== undefined;
}

/**
 * The query without a leading tool name: tool texts write "rql-query <source> | ...", and agents
 * paste that whole into `rql`.
 */
export function stripToolName(query: string): string {
  return query.replace(/^\s*rql-(query|mutate)\s+/, "");
}

/** A query file's text: UTF-8, or UTF-16 with a byte-order mark (Windows PowerShell 5.1 writes `>` files so). */
export function decodeQueryFile(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  return bytes.toString("utf-8").replace(/^﻿/, "");
}
