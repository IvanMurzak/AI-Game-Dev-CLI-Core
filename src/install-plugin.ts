import * as fs from "node:fs";
import * as path from "node:path";

import { filesWithExt, type EngineAdapter, type ProjectMarkerSpec } from "./engine-adapter.js";
import { resolveProjectPathLadder } from "./validation.js";

/**
 * The **install-plugin resolution policy** (auth-fixes design 02 §T5 / defect B1) — the shared logic
 * that decides WHICH directory an engine plugin installs into, and verifies it is actually that
 * engine's project. It closes B1 (unity `install-plugin` used to demand an explicit path): the project
 * path resolves `path? → --path? → cwd`, then the adapter's marker probe confirms the directory is a
 * real project — and on failure the error lists EXACTLY what was checked, so the user knows why.
 *
 * Ancestor walk-up is deliberately OUT OF SCOPE (decision M5) — the cwd fallback closes the UX gap
 * without the ambiguity a walk-up introduces. This module is the pure resolution/probe decision; the
 * engine-specific copy/junction of the plugin stays in each CLI.
 */

/** The outcome of probing a directory for an engine's project markers. */
export interface MarkerProbeResult {
  /** True when at least one of the adapter's markers matched. */
  found: boolean;
  /** The marker spec that matched (when {@link found}). */
  matched?: ProjectMarkerSpec;
  /** Human-readable descriptions of every location that was checked (for the failure message). */
  checked: string[];
}

/** Probe `projectRoot` against `markers`; the first match wins. Never throws (an unreadable dir = miss). */
export function probeProjectMarkers(projectRoot: string, markers: readonly ProjectMarkerSpec[]): MarkerProbeResult {
  const checked: string[] = [];
  for (const marker of markers) {
    switch (marker.kind) {
      case "file": {
        const candidate = path.join(projectRoot, marker.relativePath);
        checked.push(candidate);
        if (existsFile(candidate)) return { found: true, matched: marker, checked };
        break;
      }
      case "ext": {
        const dir = marker.dir ? path.join(projectRoot, marker.dir) : projectRoot;
        checked.push(path.join(dir, `*${marker.ext}`));
        if (dirHasFileWithExt(dir, marker.ext)) return { found: true, matched: marker, checked };
        break;
      }
      case "csproj-ref": {
        checked.push(`${path.join(projectRoot, "*.csproj")} (referencing ${marker.packagePrefix}*)`);
        if (rootCsprojReferences(projectRoot, marker.packagePrefix)) return { found: true, matched: marker, checked };
        break;
      }
      default: {
        // Exhaustiveness guard: a new ProjectMarkerSpec kind must be handled explicitly above.
        const unhandled: never = marker;
        throw new Error(`Unhandled project marker kind: ${JSON.stringify(unhandled)}`);
      }
    }
  }
  return { found: false, checked };
}

/** Options for {@link resolveInstallTarget}. */
export interface ResolveInstallTargetOptions {
  adapter: EngineAdapter;
  /** The positional `[path]` argument (highest priority). */
  positional?: string;
  /** The `--path <path>` flag (second priority). */
  path?: string;
  /** cwd override (tests); defaults to `process.cwd()` (the final fallback — closes B1). */
  cwd?: string;
  /**
   * When true (default), require the resolved directory to pass the marker probe. When false, resolve
   * the path but return a `warning` instead of failing on a marker miss (a not-yet-initialised project
   * tree is a valid, rarer flow — mirrors the Unreal CLI's warn-not-refuse behaviour).
   */
  requireMarker?: boolean;
}

/** The resolved, verified install target (or a clear failure listing what was checked). */
export type ResolveInstallTargetResult =
  | {
      kind: "success";
      /** The absolute resolved project root. */
      projectRoot: string;
      /** How the path was resolved (which of the ladder rungs won). */
      source: "positional" | "path" | "cwd";
      /** The probe result (found === true when `requireMarker`, else may be a miss with a warning). */
      probe: MarkerProbeResult;
      /** Present when the directory did NOT match a marker but `requireMarker` was false. */
      warning?: string;
    }
  | { kind: "failure"; error: Error };

/**
 * Resolve + verify an install target. Resolution ladder (T5): explicit positional path, then `--path`,
 * then cwd. Then probe the adapter's markers; on a miss with `requireMarker` (the default) fail with a
 * message that lists every location checked. Never throws.
 */
export function resolveInstallTarget(opts: ResolveInstallTargetOptions): ResolveInstallTargetResult {
  const requireMarker = opts.requireMarker !== false;
  try {
    const ladder = resolveProjectPathLadder({
      positional: opts.positional,
      path: opts.path,
      cwd: opts.cwd,
    });

    if (!fs.existsSync(ladder.projectPath)) {
      return { kind: "failure", error: new Error(`Project path does not exist: ${ladder.projectPath}`) };
    }

    const probe = probeProjectMarkers(ladder.projectPath, opts.adapter.markers);
    if (!probe.found) {
      const message =
        `Not a valid ${opts.adapter.engine} project at ${ladder.projectPath} ` +
        `(resolved via ${ladder.source}). Checked for: ${probe.checked.join(", ")}. ` +
        `Pass the project path explicitly (a positional arg or --path), or run from the project root.`;
      if (requireMarker) return { kind: "failure", error: new Error(message) };
      return { kind: "success", projectRoot: ladder.projectPath, source: ladder.source, probe, warning: message };
    }

    return { kind: "success", projectRoot: ladder.projectPath, source: ladder.source, probe };
  } catch (err) {
    return { kind: "failure", error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function existsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function dirHasFileWithExt(dir: string, ext: string): boolean {
  return filesWithExt(dir, ext).length > 0;
}

const XML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when any `*.csproj` directly in `dir` (non-recursive) contains an `Include="<prefix>…"`
 * attribute — the prefix matched case-insensitively, tolerant of single or double quotes and of
 * whitespace around `=`. XML comments are ignored, so a commented-out reference is not a match.
 * Unreadable dirs/files count as a miss (never throws).
 */
function rootCsprojReferences(dir: string, packagePrefix: string): boolean {
  const pattern = new RegExp(`\\bInclude\\s*=\\s*["']\\s*${escapeRegExp(packagePrefix)}`, "i");
  return filesWithExt(dir, ".csproj").some((name) => {
    try {
      return pattern.test(fs.readFileSync(path.join(dir, name), "utf8").replace(XML_COMMENT_RE, ""));
    } catch {
      return false; // unreadable csproj — a miss; keep scanning the rest
    }
  });
}
