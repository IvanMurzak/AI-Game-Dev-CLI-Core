import * as fs from "node:fs";
import * as path from "node:path";

import { MACHINE_STORE_DIR_NAME } from "./machine-credentials.js";

/**
 * The tool-neutral, NON-SECRET, committable per-project marker at `<project>/.ai-game-dev/project.json`
 * — the TypeScript client of the shared C# `com.IvanMurzak.McpPlugin.AgentConfig.ProjectMarker`
 * (`MCP-Plugin-dotnet/McpPlugin/src/AgentConfig/ProjectMarker.cs`). It records the enrolled server
 * target (hosted vs local) and an optional explicit port override, so `ProjectIdentity` resolution and
 * every config writer (engine UI, CLIs, `configure`) agree on ONE source of truth and an override can
 * never silently diverge between the plugin and a terminal-written config.
 *
 * **Credentials are NEVER written here** — they live only in the machine credential store
 * (`credentials.json`, DPAPI/0600). The marker is safe to commit. Unknown fields are preserved on
 * read/merge for forward-compatibility. camelCase keys match the C# `JsonNamingPolicy.CamelCase`.
 */

/** Marker file name inside the `.ai-game-dev` directory (C# `ProjectMarker.FileName`). */
export const PROJECT_MARKER_FILE = "project.json";

/** The committable project-marker document (mirrors the C# `ProjectMarker` schema). */
export interface ProjectMarker {
  /** The server the project is enrolled against (hosted `https://ai-game.dev` or a local URL). */
  serverTarget?: string;
  /** The user's explicit local-port override (wins over the deterministic derived port). */
  portOverride?: number;
  /** Unknown fields are preserved on read/merge for forward-compatibility. */
  [key: string]: unknown;
}

/** Absolute path of the marker directory (`<project>/.ai-game-dev`). */
export function projectMarkerDir(projectPath: string): string {
  return path.join(projectPath, MACHINE_STORE_DIR_NAME);
}

/** Absolute path of the marker file (C# `ProjectMarker.PathFor`). */
export function projectMarkerPath(projectPath: string): string {
  return path.join(projectMarkerDir(projectPath), PROJECT_MARKER_FILE);
}

/** Read the marker, or null when it is absent / empty / unparsable. */
export function readProjectMarker(projectPath: string): ProjectMarker | null {
  const markerPath = projectMarkerPath(projectPath);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const raw = fs.readFileSync(markerPath, "utf-8");
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as ProjectMarker;
  } catch {
    return null;
  }
}

/**
 * Merge `marker` into any existing marker and write it back (creating `.ai-game-dev/` as needed).
 * Idempotent for identical inputs; preserves pre-existing keys. `undefined`-valued fields are omitted
 * (matching the C# `WhenWritingNull` policy). Returns the absolute marker path.
 */
export function writeProjectMarker(projectPath: string, marker: ProjectMarker): string {
  const dir = projectMarkerDir(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  const merged: ProjectMarker = { ...(readProjectMarker(projectPath) ?? {}), ...marker };
  const markerPath = projectMarkerPath(projectPath);
  fs.writeFileSync(markerPath, JSON.stringify(merged, undefinedOmittingReplacer, 2));
  return markerPath;
}

function undefinedOmittingReplacer(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}
