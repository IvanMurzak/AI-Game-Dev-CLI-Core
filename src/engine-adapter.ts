import * as path from "node:path";

import { normalizeServerBase } from "./token-refresher.js";

/**
 * The **engine-adapter contract** (auth-fixes design 02 §T7 / decision D1+D4) — the single typed seam
 * that carries every per-engine difference so the rest of cli-core (agents-registry, setup-mcp,
 * install-plugin, enroll, server-download) stays engine-agnostic. There is **zero engine-specific
 * hard-coding anywhere outside an {@link EngineAdapter} definition**: the three CLIs each pass their
 * adapter into the shared policy functions.
 *
 * What the adapter parameterizes (the §T7 list):
 *   - **serverName** — the MCP server-entry name written into agent configs
 *     (`ai-game-developer` for Unity/Godot, `unreal-mcp` for Unreal).
 *   - **project markers** — how to recognise this engine's project root
 *     (`Packages/manifest.json` / any `*.uproject` / `project.godot`), used by the T5 install-plugin
 *     marker probe.
 *   - **stdio support flag + stdio-args vector** — whether the plugin supports the stdio transport
 *     (Godot is http-only) and the exact server args a stdio config emits.
 *   - **install-dir layout** — where the RID-matched `gamedev-mcp-server` binary is installed
 *     (`Library/mcp-server/<rid>` vs `Intermediate/UnrealMCP/server/<rid>` vs `.ai-game-dev/server`).
 *   - **login project-sink** — the {@link EngineAdapter.loginServerTarget} that yields the AS-root
 *     `serverTarget` recorded on the credential (b2 security review MED-2 — NEVER a pinned hub URL).
 *   - **OAuth client_id** — the per-product device-flow client id.
 */

/** The three supported engines. */
export type EngineId = "unity" | "unreal" | "godot";

/** Base name of the shared MCP server binary released from `IvanMurzak/GameDev-MCP-Server`. */
export const SERVER_BINARY_BASENAME = "gamedev-mcp-server";

/**
 * How to recognise an engine's project root. `file` matches an exact relative path; `ext` matches any
 * file with the given extension inside `dir` (default the project root) — the shape a `*.uproject`
 * probe needs, since the file's basename is the user's project name.
 */
export type ProjectMarkerSpec =
  | { kind: "file"; relativePath: string }
  | { kind: "ext"; ext: string; dir?: string };

/** Parameters for building a stdio server-args vector. */
export interface StdioArgsParams {
  /** The deterministic local port (from ProjectIdentity, or an override). */
  port: number;
  /** The plugin/client timeout in ms. */
  timeoutMs: number;
  /** The `authorization` mode arg value (`none` / `required`). */
  authorization: string;
  /** The token to embed as `token=<t>` — only when an explicit PAT opt-in requires it. */
  token?: string;
}

/** The typed per-engine seam every cli-core policy function consumes. */
export interface EngineAdapter {
  /** Which engine this adapter is for. */
  readonly engine: EngineId;
  /** OAuth product client id (`unity-mcp-cli` / `unreal-mcp-cli` / `godot-cli`). */
  readonly clientId: string;
  /** The canonical MCP server-entry name written under an agent config's body path. */
  readonly serverName: string;
  /** Ordered project-root marker probes (T5); the first match identifies the project. */
  readonly markers: readonly ProjectMarkerSpec[];
  /** Whether this engine's plugin supports the stdio transport (Godot is http-only — decision M6). */
  readonly stdioSupported: boolean;
  /** Build the stdio server-args vector for this engine. */
  stdioArgs(params: StdioArgsParams): string[];
  /** The RID-matched server-binary install directory for a project root (engine-specific layout). */
  serverInstallDir(projectRoot: string, platform?: NodeJS.Platform, arch?: string): string;
  /** The absolute server-binary path for a project root. */
  serverBinaryPath(projectRoot: string, platform?: NodeJS.Platform, arch?: string): string;
  /**
   * The login/enroll project-sink `serverTarget`: reduce any connection URL to the **AS root** to
   * record on the credential (b2 MED-2). A pinned `/mcp/p/<pin>` hub URL is NEVER recorded — the pin
   * is a routing segment, not an auth base; recording it would send `{base}/oauth/token` refresh to
   * the wrong URL and break auth. Composes {@link normalizeServerBase} with a pin-strip so a pinned
   * URL, a canonical `/mcp` URL, and a bare host all collapse to the same AS root.
   */
  loginServerTarget(connectionUrl: string): string;
}

/** The RID string (`<os>-<arch>`) for a platform/arch — the GameDev-MCP-Server release-asset RID. */
export function ridForPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform === "win32") return "win-x64";
  if (platform === "darwin") return arch === "arm64" ? "osx-arm64" : "osx-x64";
  return "linux-x64";
}

/** The server executable file name for a platform (`gamedev-mcp-server` / `…​.exe`). */
export function serverExecutableName(platform: NodeJS.Platform = process.platform): string {
  return `${SERVER_BINARY_BASENAME}${platform === "win32" ? ".exe" : ""}`;
}

/** The MCP-server arg names (mirror C# `Consts.MCP.Server.Args`). */
export const SERVER_ARG_NAMES = {
  port: "port",
  pluginTimeout: "plugin-timeout",
  clientTransport: "client-transport",
  authorization: "authorization",
  token: "token",
} as const;

/**
 * The shared stdio server-args vector (identical across engines — the arg names are the MCP server's,
 * not the engine's). A `token=` arg is appended only when a token is supplied (an explicit PAT
 * opt-in; the credential-free default omits it — decision M7).
 */
export function defaultStdioArgs(params: StdioArgsParams): string[] {
  const args = [
    `${SERVER_ARG_NAMES.port}=${params.port}`,
    `${SERVER_ARG_NAMES.pluginTimeout}=${params.timeoutMs}`,
    `${SERVER_ARG_NAMES.clientTransport}=stdio`,
    `${SERVER_ARG_NAMES.authorization}=${params.authorization}`,
  ];
  if (params.token) args.push(`${SERVER_ARG_NAMES.token}=${params.token}`);
  return args;
}

/**
 * Reduce a connection URL to the authorization-server root (the {@link EngineAdapter.loginServerTarget}
 * implementation shared by all adapters). Strips a trailing `/p/<8-hex>` routing-pin segment, then a
 * trailing `/mcp` (via {@link normalizeServerBase}), then a trailing slash — so
 * `https://ai-game.dev/mcp/p/34ea75f2`, `https://ai-game.dev/mcp`, and `https://ai-game.dev` all
 * collapse to `https://ai-game.dev`. Returns the input trimmed of a trailing slash when it cannot be
 * reduced (never returns empty for a non-empty input).
 */
export function toAuthServerRoot(connectionUrl: string): string {
  const raw = (connectionUrl ?? "").trim();
  if (!raw) return raw;
  const withoutPin = raw.replace(/\/+$/, "").replace(/\/p\/[0-9a-f]{8}$/i, "");
  return normalizeServerBase(withoutPin) ?? withoutPin.replace(/\/+$/, "");
}

// ── concrete adapters ───────────────────────────────────────────────────────────────────────────

/**
 * Unity: server-entry `ai-game-developer`; project marker `Packages/manifest.json`; stdio supported;
 * server installed under `<project>/Library/mcp-server/<rid>/` (matches the CLI's
 * `resolveServerBinaryPath`).
 */
export const unityAdapter: EngineAdapter = {
  engine: "unity",
  clientId: "unity-mcp-cli",
  serverName: "ai-game-developer",
  markers: [{ kind: "file", relativePath: path.join("Packages", "manifest.json") }],
  stdioSupported: true,
  stdioArgs: defaultStdioArgs,
  serverInstallDir: (root, platform, arch) =>
    path.join(path.resolve(root), "Library", "mcp-server", ridForPlatform(platform, arch)),
  serverBinaryPath: (root, platform, arch) =>
    path.join(unityAdapter.serverInstallDir(root, platform, arch), serverExecutableName(platform)),
  loginServerTarget: toAuthServerRoot,
};

/**
 * Unreal: server-entry `unreal-mcp`; project marker any `*.uproject` in the root; stdio supported;
 * server installed under `<project>/Intermediate/UnrealMCP/server/<rid>/` (matches the CLI's §6 layout).
 */
export const unrealAdapter: EngineAdapter = {
  engine: "unreal",
  clientId: "unreal-mcp-cli",
  serverName: "unreal-mcp",
  markers: [{ kind: "ext", ext: ".uproject" }],
  stdioSupported: true,
  stdioArgs: defaultStdioArgs,
  serverInstallDir: (root, platform, arch) =>
    path.join(path.resolve(root), "Intermediate", "UnrealMCP", "server", ridForPlatform(platform, arch)),
  serverBinaryPath: (root, platform, arch) =>
    path.join(unrealAdapter.serverInstallDir(root, platform, arch), serverExecutableName(platform)),
  loginServerTarget: toAuthServerRoot,
};

/**
 * Godot: server-entry `ai-game-developer`; project marker `project.godot`; **stdio NOT supported**
 * (http-only — decision M6); server installed FLAT under `<project>/.ai-game-dev/server/` (matches
 * the CLI's managed dir — no RID subfolder).
 */
export const godotAdapter: EngineAdapter = {
  engine: "godot",
  clientId: "godot-cli",
  serverName: "ai-game-developer",
  markers: [{ kind: "file", relativePath: "project.godot" }],
  stdioSupported: false,
  stdioArgs: defaultStdioArgs,
  serverInstallDir: (root) => path.join(path.resolve(root), ".ai-game-dev", "server"),
  serverBinaryPath: (root, platform) =>
    path.join(godotAdapter.serverInstallDir(root), serverExecutableName(platform)),
  loginServerTarget: toAuthServerRoot,
};

/** The built-in adapters, keyed by engine. */
export const engineAdapters: Readonly<Record<EngineId, EngineAdapter>> = {
  unity: unityAdapter,
  unreal: unrealAdapter,
  godot: godotAdapter,
};

/** Look up a built-in adapter by engine id. */
export function getEngineAdapter(engine: EngineId): EngineAdapter {
  return engineAdapters[engine];
}
