import * as path from "node:path";

import type { EngineAdapter } from "./engine-adapter.js";
import { derivePinV2, derivePortV2 } from "./project-identity.js";
import { pinUrl, stripPinFromUrl } from "./routing.js";
import {
  getAgentById,
  getAgentIds,
  REQUIRED_PROP_KEYS,
  type AgentDefinition,
  type AgentProps,
} from "./agents-registry.js";
import { JsonAiAgentConfig, TomlAiAgentConfig, type JsonNode, type TomlValue, type AgentConfigFs, nodeFs } from "./agent-config.js";
import { emitProgress, type ProgressCallback } from "./progress.js";

/**
 * The **setup-mcp policy** (auth-fixes design 02 §T4 / defects B4+B8, decision M7+M8) — the shared
 * logic that writes a project's AI-agent MCP-client config. It closes B4 by **pinning the URL by
 * default**: the http config points at `<base>/mcp/p/<pin-v2>` and the stdio config carries a
 * `project=<pin>` arg, so the config routes strictly to this project's engine instance even when the
 * account has several. `--no-pin` is the escape hatch (unpinned URL / no `project=` arg).
 *
 * **Credential policy (M7):** the default config is credential-free. A static `Authorization: Bearer`
 * header (http) or a `token=` arg (stdio) is emitted ONLY on an explicit `--token` opt-in (a PAT), or
 * for a client that cannot do native MCP OAuth (`supportsOAuth === false`). It is NEVER written merely
 * because the server requires auth — an OAuth-capable client authorizes natively (RFC 9728), and a
 * static header both fails against the hosted endpoint and suppresses that native flow.
 *
 * **Routing-vs-identity (M8):** the pin is a routing path segment, NOT part of the OAuth resource. The
 * canonical resource stays `https://ai-game.dev/mcp`; the pin lives only in the connection URL.
 *
 * {@link resolveSetupMcpPlan} is the PURE decision (no IO, fully testable); {@link setupMcp} runs the
 * plan and writes the file via the golden-vector-gated {@link JsonAiAgentConfig}/{@link TomlAiAgentConfig}.
 */

/** The default hosted MCP hub URL (the canonical OAuth resource — decision M8). */
export const DEFAULT_HOSTED_MCP_URL = "https://ai-game.dev/mcp";

/** The stdio `project=<pin>` arg name (mirrors C# `Consts.MCP.Server.Args.Project`). */
export const PROJECT_ARG_NAME = "project";

/** MCP transport. */
export type McpTransport = "http" | "stdio";

/** The pure inputs to {@link resolveSetupMcpPlan} (all resolution already done by the caller). */
export interface SetupMcpPlanInput {
  adapter: EngineAdapter;
  agent: AgentDefinition;
  transport: McpTransport;
  /** The absolute, resolved project root. */
  projectRoot: string;
  /** The v2 routing pin (derived from {@link projectRoot} unless supplied). */
  pin: string;
  /** The deterministic local port. */
  port: number;
  /** Plugin/client timeout (ms). */
  timeoutMs: number;
  /** The `authorization` mode arg (`none` / `required`). */
  authorization: string;
  /** An explicit PAT (`--token`); its presence is the ONLY thing that emits a static credential. */
  token?: string;
  /** An explicit base URL override (hosted or local). Defaults to {@link DEFAULT_HOSTED_MCP_URL}. */
  url?: string;
  /** The `--no-pin` escape hatch: write an unpinned URL / omit the `project=` arg. */
  noPin: boolean;
  /** The resolved server binary path (from the adapter); defaults to `adapter.serverBinaryPath`. */
  serverPath?: string;
}

/** The fully-resolved plan a caller can inspect before (or instead of) writing. */
export interface SetupMcpPlan {
  configPath: string;
  configFormat: "json" | "toml";
  bodyPath: string;
  serverName: string;
  transport: McpTransport;
  pinned: boolean;
  /** The resolved http URL (pinned unless `--no-pin`). Only for the http transport. */
  resolvedUrl?: string;
  /** The stdio server-args vector (incl. `project=<pin>` unless `--no-pin`). Only for stdio. */
  stdioArgs?: string[];
  /** Whether a static `Authorization` header / `token=` arg is emitted (M7). */
  emitAuthHeader: boolean;
  props: AgentProps;
  removeKeys: string[];
  requiredKeys: string[];
}

/**
 * The pure setup-mcp decision. Computes the pinned URL / stdio args, the M7 credential decision, and
 * the exact server-entry props + remove-keys — with NO filesystem or network access.
 */
export function resolveSetupMcpPlan(input: SetupMcpPlanInput): SetupMcpPlan {
  const { adapter, agent, transport, pin, port, timeoutMs, authorization, noPin } = input;

  const supportsOAuth = agent.supportsOAuth !== false;
  const patOptIn = typeof input.token === "string" && input.token.length > 0;
  const token = patOptIn ? input.token! : "";
  // M7: a static credential is emitted ONLY on an explicit --token opt-in, or for a non-OAuth client.
  const emitAuthHeader = token.length > 0 && (patOptIn || !supportsOAuth);

  const configPath = agent.getConfigPath(input.projectRoot);
  const pinned = !noPin;

  let props: AgentProps;
  let removeKeys: readonly string[];
  let resolvedUrl: string | undefined;
  let stdioArgsVec: string[] | undefined;

  if (transport === "stdio") {
    const serverPath = input.serverPath ?? adapter.serverBinaryPath(input.projectRoot);
    stdioArgsVec = adapter.stdioArgs({
      port,
      timeoutMs,
      authorization,
      token: emitAuthHeader ? token : undefined,
    });
    if (pinned) stdioArgsVec.push(`${PROJECT_ARG_NAME}=${pin}`);
    props = agent.getStdioProps(serverPath, stdioArgsVec);
    removeKeys = agent.stdioRemoveKeys;
  } else {
    const base = input.url ?? DEFAULT_HOSTED_MCP_URL;
    resolvedUrl = pinned ? pinUrl(base, pin) : stripPinFromUrl(base);
    const headers = emitAuthHeader ? { Authorization: `Bearer ${token}` } : undefined;
    props = agent.getHttpProps(resolvedUrl, headers);
    removeKeys = agent.httpRemoveKeys;
  }

  const requiredKeys = Object.keys(props).filter((k) => REQUIRED_PROP_KEYS.has(k));

  return {
    configPath,
    configFormat: agent.configFormat,
    bodyPath: agent.bodyPath,
    serverName: adapter.serverName,
    transport,
    pinned,
    resolvedUrl,
    stdioArgs: stdioArgsVec,
    emitAuthHeader,
    props,
    removeKeys: [...removeKeys],
    requiredKeys,
  };
}

/** Write the plan to disk via the golden-vector-gated config writer. Returns true on success. */
export function writeSetupMcpPlan(plan: SetupMcpPlan, io: AgentConfigFs = nodeFs): boolean {
  if (plan.configFormat === "toml") {
    const writer = new TomlAiAgentConfig({ serverName: plan.serverName, bodyPath: plan.bodyPath });
    for (const [key, value] of Object.entries(plan.props)) {
      writer.setProperty(key, toTomlValue(value), plan.requiredKeys.includes(key));
    }
    for (const key of plan.removeKeys) writer.setPropertyToRemove(key);
    return writer.configure(plan.configPath, io);
  }
  const writer = new JsonAiAgentConfig({ serverName: plan.serverName, bodyPath: plan.bodyPath });
  for (const [key, value] of Object.entries(plan.props)) {
    writer.setProperty(key, value, plan.requiredKeys.includes(key));
  }
  for (const key of plan.removeKeys) writer.setPropertyToRemove(key);
  return writer.configure(plan.configPath, io);
}

/** Options for {@link setupMcp}. */
export interface SetupMcpOptions {
  adapter: EngineAdapter;
  /** The AI-agent client id (see {@link getAgentIds}). */
  agentId: string;
  /** Transport; defaults to `http`. */
  transport?: McpTransport;
  /** The project root; defaults to `process.cwd()`. Must exist. */
  projectPath?: string;
  /** An explicit PAT (`--token`) — the ONLY input that writes a static credential (M7). */
  token?: string;
  /** An explicit base URL override (hosted or local). */
  url?: string;
  /** `--no-pin`: write an unpinned URL / omit the `project=` arg (B4 escape hatch). */
  noPin?: boolean;
  /** Timeout (ms); defaults to 10000. */
  timeoutMs?: number;
  /** `authorization` mode arg value; defaults to `none`. */
  authorization?: string;
  /** Injectable clock/cwd/fs for tests. */
  cwd?: string;
  fs?: AgentConfigFs;
  onProgress?: ProgressCallback;
}

/** The result of {@link setupMcp} (a discriminated union — no throw past the boundary). */
export type SetupMcpResult =
  | {
      kind: "success";
      agentId: string;
      configPath: string;
      transport: McpTransport;
      pinned: boolean;
      resolvedUrl?: string;
      emitAuthHeader: boolean;
      warnings: string[];
    }
  | { kind: "failure"; error: Error; warnings: string[] };

/**
 * Configure an AI agent's MCP client for a project — resolve the agent + project + pin/port, build the
 * T4 plan, and write it. Library-safe: never throws past the boundary. `projectPath` defaults to cwd
 * (closing the "path required" half of B1 for the config surface too).
 */
export function setupMcp(opts: SetupMcpOptions): SetupMcpResult {
  const warnings: string[] = [];
  try {
    if (!opts.agentId) {
      return { kind: "failure", warnings, error: new Error(`agentId is required. Available: ${getAgentIds().join(", ")}`) };
    }
    const agent = getAgentById(opts.agentId);
    if (!agent) {
      return { kind: "failure", warnings, error: new Error(`Unknown agent "${opts.agentId}". Available: ${getAgentIds().join(", ")}`) };
    }

    const transport: McpTransport = opts.transport ?? "http";
    if (transport === "stdio" && !opts.adapter.stdioSupported) {
      return {
        kind: "failure",
        warnings,
        error: new Error(`The ${opts.adapter.engine} plugin does not support the stdio transport — use http.`),
      };
    }

    const projectRoot = path.resolve(opts.projectPath ?? opts.cwd ?? process.cwd());
    const pin = derivePinV2(projectRoot);
    const port = derivePortV2(projectRoot);

    emitProgress(opts.onProgress, {
      phase: "start",
      message: `Configuring ${agent.name} (${transport}) for ${projectRoot}`,
    });

    const plan = resolveSetupMcpPlan({
      adapter: opts.adapter,
      agent,
      transport,
      projectRoot,
      pin,
      port,
      timeoutMs: opts.timeoutMs ?? 10000,
      authorization: opts.authorization ?? "none",
      token: opts.token,
      url: opts.url,
      noPin: opts.noPin === true,
    });

    if (transport === "http" && plan.emitAuthHeader && isProjectScoped(plan.configPath, projectRoot)) {
      warnings.push(
        `Wrote an access token into project-scoped config "${plan.configPath}" — it is under the project root and may be committed. Prefer an env-var / user-scope credential (design 03 Flow C).`,
      );
    }

    writeSetupMcpPlan(plan, opts.fs ?? nodeFs);

    emitProgress(opts.onProgress, { phase: "done", message: `${agent.name} configured (${plan.configPath})` });

    return {
      kind: "success",
      agentId: agent.id,
      configPath: plan.configPath,
      transport,
      pinned: plan.pinned,
      resolvedUrl: plan.resolvedUrl,
      emitAuthHeader: plan.emitAuthHeader,
      warnings,
    };
  } catch (err) {
    return { kind: "failure", warnings, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/** Convert a registry JSON prop value to a TOML value (codex only produces TOML-representable props). */
function toTomlValue(value: JsonNode): TomlValue {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) return value as number[];
  if (Array.isArray(value) && value.every((v) => typeof v === "boolean")) return value as boolean[];
  throw new Error(`Value is not representable in a TOML agent config: ${JSON.stringify(value)}`);
}

/** True when `configPath` is at/under `projectRoot` (separator/case-insensitive). */
function isProjectScoped(configPath: string, projectRoot: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const root = norm(projectRoot);
  const target = norm(configPath);
  return target === root || target.startsWith(root + "/");
}

export { getAgentIds, getAgentById };
