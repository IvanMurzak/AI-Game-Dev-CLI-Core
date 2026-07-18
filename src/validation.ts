import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Small, side-effect-free input-validation helpers shared by the cli-core library API. Each returns a
 * discriminated union so call sites pattern-match without throwing across the public boundary
 * (matches the three CLIs' `lib/validation.ts`). The project-path resolution ladder here backs the
 * T5 `install-plugin` policy (design 02 §T5): resolve `path? → --path? → cwd`, then marker-probe.
 */

/** A validated, absolute path result. */
export type ValidatedPath = { ok: true; projectPath: string } | { ok: false; error: Error };

/** Require a non-empty string and resolve it to an absolute path. */
export function requireProjectPath(raw: unknown): ValidatedPath {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: new Error("A project path is required and must be a non-empty string.") };
  }
  return { ok: true, projectPath: path.resolve(raw) };
}

/** Require a non-empty path that also exists on disk (does not need to host an engine project). */
export function requireExistingPath(raw: unknown): ValidatedPath {
  const outer = requireProjectPath(raw);
  if (!outer.ok) return outer;
  if (!fs.existsSync(outer.projectPath)) {
    return { ok: false, error: new Error(`Project path does not exist: ${outer.projectPath}`) };
  }
  return outer;
}

/**
 * Resolve the T5 project-path ladder — an explicit positional arg, then a `--path` flag, then the
 * current working directory — and resolve the winner to an absolute path. The `--path`/`cwd` fallback
 * is exactly what closes defect B1 (unity `install-plugin` used to demand an explicit path).
 * `cwd` is injectable for deterministic tests. Never throws.
 */
export function resolveProjectPathLadder(opts: {
  positional?: string;
  path?: string;
  cwd?: string;
}): { source: "positional" | "path" | "cwd"; projectPath: string } {
  const positional = nonEmpty(opts.positional);
  if (positional) return { source: "positional", projectPath: path.resolve(positional) };
  const flag = nonEmpty(opts.path);
  if (flag) return { source: "path", projectPath: path.resolve(flag) };
  return { source: "cwd", projectPath: path.resolve(opts.cwd ?? process.cwd()) };
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
