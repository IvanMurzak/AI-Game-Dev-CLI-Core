import * as os from "node:os";
import * as path from "node:path";

import type { JsonNode } from "./agent-config.js";

/**
 * The registry of AI-agent MCP clients the CLIs can configure — the engine-agnostic port of the
 * three CLIs' `utils/agents.ts` registry (config path + format + body path + the per-client
 * transport-entry shape). It carries **no engine specifics**: the server-entry name, the stdio-args
 * vector, and the server-binary path all come from the {@link EngineAdapter} the setup-mcp policy
 * passes in. Each entry only knows the CLIENT's quirks (where its config file lives, whether it uses
 * `url`/`serverUrl`, `type: 'http'` vs `'streamableHttp'`, a `tools: ['*']` allowlist, …).
 */

/** A JSON value stored on a client's server entry. */
export type AgentPropValue = JsonNode;

/** The properties written onto a client's server entry (the transport-specific shape). */
export type AgentProps = Record<string, AgentPropValue>;

/** One AI-agent MCP client. */
export interface AgentDefinition {
  /** Stable client id (`claude-code`, `cursor`, `codex`, …). */
  readonly id: string;
  /** Human-readable client name. */
  readonly name: string;
  /** Relative skills path for this client, or null when it has no skills directory. */
  readonly skillsPath: string | null;
  /** Display string for the client's config file location. */
  readonly configPathDisplay: string;
  /** Config file format. */
  readonly configFormat: "json" | "toml";
  /** The body path the server entry nests under (e.g. `mcpServers`, `servers`, `mcp`, `mcp_servers`). */
  readonly bodyPath: string;
  /**
   * Whether this client can complete native MCP OAuth (RFC 9728) itself. `undefined`/`true` (the
   * default) means the config is credential-free — the client authorizes natively, so writing a
   * static `Authorization` header would both fail (hosted endpoint 401s a plugin token) and suppress
   * the client's own OAuth. `false` marks a client that cannot do MCP OAuth (it may receive a header
   * via the explicit PAT fallback). See design 03 Flow A / decision D11 / M7.
   */
  readonly supportsOAuth?: boolean;
  /** Absolute config-file path for a project root (some clients ignore it — user-global config). */
  getConfigPath(projectPath: string): string;
  /** Build the stdio server-entry props from the resolved server binary path + args vector. */
  getStdioProps(serverPath: string, args: string[]): AgentProps;
  /** Build the http server-entry props from the (pinned) URL + optional auth headers. */
  getHttpProps(url: string, headers: Record<string, string> | undefined): AgentProps;
  /** Keys to strip from an existing entry when writing a stdio config. */
  readonly stdioRemoveKeys: readonly string[];
  /** Keys to strip from an existing entry when writing an http config. */
  readonly httpRemoveKeys: readonly string[];
}

/** Keys that identify the transport and are marked required-for-configuration by the setup-mcp policy. */
export const REQUIRED_PROP_KEYS: ReadonlySet<string> = new Set(["type", "command", "url", "serverUrl", "args"]);

function appData(): string {
  return process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
}
function home(): string {
  return os.homedir();
}
function isWindows(): boolean {
  return process.platform === "win32";
}
function isMac(): boolean {
  return process.platform === "darwin";
}

const withHeaders = (headers: Record<string, string> | undefined): AgentProps =>
  headers ? { headers } : {};

/**
 * The built-in AI-agent registry (ported from the CLIs; superset across the three). The stdio `args`
 * vector and the server-entry name are supplied by the adapter, so entries stay engine-neutral.
 */
export const agentRegistry: readonly AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    skillsPath: ".claude/skills",
    configPathDisplay: ".mcp.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: (p) => path.join(p, ".mcp.json"),
    getStdioProps: (serverPath, args) => ({ command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["type", "url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    skillsPath: null,
    configPathDisplay: "~/Claude/claude_desktop_config.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: () =>
      isWindows()
        ? path.join(appData(), "Claude", "claude_desktop_config.json")
        : path.join(home(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "cursor",
    name: "Cursor",
    skillsPath: ".cursor/skills",
    configPathDisplay: ".cursor/mcp.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: (p) => path.join(p, ".cursor", "mcp.json"),
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "vscode-copilot",
    name: "Visual Studio Code (Copilot)",
    skillsPath: ".github/skills",
    configPathDisplay: ".vscode/mcp.json",
    configFormat: "json",
    bodyPath: "servers",
    getConfigPath: (p) => path.join(p, ".vscode", "mcp.json"),
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "vs-copilot",
    name: "Visual Studio (Copilot)",
    skillsPath: ".github/skills",
    configPathDisplay: ".vs/mcp.json",
    configFormat: "json",
    bodyPath: "servers",
    getConfigPath: (p) => path.join(p, ".vs", "mcp.json"),
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "rider-junie",
    name: "Rider (Junie)",
    skillsPath: ".junie/skills",
    configPathDisplay: ".junie/mcp/mcp.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: (p) => path.join(p, ".junie", "mcp", "mcp.json"),
    getStdioProps: (serverPath, args) => ({ enabled: true, type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ enabled: true, type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["disabled", "url"],
    httpRemoveKeys: ["disabled", "command", "args"],
  },
  {
    id: "github-copilot-cli",
    name: "GitHub Copilot CLI",
    skillsPath: ".github/skills",
    configPathDisplay: "~/.copilot/mcp-config.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: () => path.join(home(), ".copilot", "mcp-config.json"),
    getStdioProps: (serverPath, args) => ({ command: serverPath, args, tools: ["*"] }),
    getHttpProps: (url, headers) => ({ type: "http", url, tools: ["*"], ...withHeaders(headers) }),
    stdioRemoveKeys: ["url", "type"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "gemini",
    name: "Gemini",
    skillsPath: ".gemini/skills",
    configPathDisplay: ".gemini/settings.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: (p) => path.join(p, ".gemini", "settings.json"),
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    skillsPath: ".agent/skills",
    configPathDisplay: "~/.gemini/config/mcp_config.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    // Antigravity does not model an auth header — the `headers` param is intentionally ignored.
    getConfigPath: () => path.join(home(), ".gemini", "config", "mcp_config.json"),
    getStdioProps: (serverPath, args) => ({ disabled: false, command: serverPath, args }),
    getHttpProps: (url) => ({ disabled: false, serverUrl: url }),
    stdioRemoveKeys: ["url", "serverUrl", "type"],
    httpRemoveKeys: ["command", "args", "url", "type"],
  },
  {
    id: "cline",
    name: "Cline",
    skillsPath: ".cline/skills",
    configPathDisplay: "~/Code/globalStorage/.../cline_mcp_settings.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: () => {
      if (isWindows()) {
        return path.join(
          appData(),
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        );
      }
      const base = isMac()
        ? path.join(home(), "Library", "Application Support", "Code", "User", "globalStorage")
        : path.join(home(), ".config", "Code", "User", "globalStorage");
      return path.join(base, "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
    },
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "streamableHttp", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "open-code",
    name: "Open Code",
    skillsPath: ".opencode/skills",
    configPathDisplay: "opencode.json",
    configFormat: "json",
    bodyPath: "mcp",
    getConfigPath: (p) => path.join(p, "opencode.json"),
    getStdioProps: (serverPath, args) => ({ type: "local", enabled: true, command: [serverPath, ...args] }),
    getHttpProps: (url, headers) => ({ type: "remote", enabled: true, url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url", "args"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "codex",
    name: "Codex",
    skillsPath: ".agents/skills",
    configPathDisplay: ".codex/config.toml",
    configFormat: "toml",
    bodyPath: "mcp_servers",
    // Codex TOML http config models no auth header, and its stdio args carry no token (M7).
    getConfigPath: (p) => path.join(p, ".codex", "config.toml"),
    getStdioProps: (serverPath, args) => ({
      enabled: true,
      command: serverPath,
      args: args.filter((a) => !a.startsWith("token=")),
      tool_timeout_sec: 300,
    }),
    getHttpProps: (url) => ({ enabled: true, url, tool_timeout_sec: 300, startup_timeout_sec: 30 }),
    stdioRemoveKeys: ["url", "type", "startup_timeout_sec"],
    httpRemoveKeys: ["command", "args", "type"],
  },
  {
    id: "unity-ai",
    name: "Unity AI",
    skillsPath: null,
    configPathDisplay: "UserSettings/mcp.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: (p) => path.join(p, "UserSettings", "mcp.json"),
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
  {
    id: "custom",
    name: "Custom (generic MCP client)",
    skillsPath: null,
    configPathDisplay: "mcp.json",
    configFormat: "json",
    bodyPath: "mcpServers",
    getConfigPath: (p) => path.join(p, "mcp.json"),
    getStdioProps: (serverPath, args) => ({ type: "stdio", command: serverPath, args }),
    getHttpProps: (url, headers) => ({ type: "http", url, ...withHeaders(headers) }),
    stdioRemoveKeys: ["url"],
    httpRemoveKeys: ["command", "args"],
  },
] as const;

/** Look up an agent by id. */
export function getAgentById(id: string): AgentDefinition | undefined {
  return agentRegistry.find((a) => a.id === id);
}

/** Every registered agent id. */
export function getAgentIds(): string[] {
  return agentRegistry.map((a) => a.id);
}
