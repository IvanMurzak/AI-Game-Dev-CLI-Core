import * as path from "node:path";

import type { EngineAdapter } from "./engine-adapter.js";
import { derivePinV2, derivePortV2 } from "./project-identity.js";
import { pinUrl, stripPinFromUrl } from "./routing.js";
import {
  getAgentById,
  getAgentIds,
  httpHeadersKeyOf,
  REQUIRED_PROP_KEYS,
  type AgentDefinition,
  type AgentProps,
} from "./agents-registry.js";
import { JsonAiAgentConfig, TomlAiAgentConfig, type JsonNode, type TomlValue, type AgentConfigFs, nodeFs } from "./agent-config.js";
import { emitProgress, type ProgressCallback } from "./progress.js";
import { toAuthServerRoot } from "./engine-adapter.js";
import { MachineCredentialStore } from "./machine-credentials.js";
import { MachineCredentialProvider } from "./credential-provider.js";
import { HttpTokenRefresher } from "./token-refresher.js";
import { isLoopbackHost } from "./oauth-authcode-flow.js";
import { getOrMintProjectKey, regenerateProjectKey, type ProjectKeyEngine, type ProjectKeyResult } from "./project-keys.js";

/**
 * The **setup-mcp policy** — the shared logic that writes a project's AI-agent MCP-client config.
 *
 * **Routing (B4/M8):** the http config points at `<base>/mcp/p/<pin-v2>` and the stdio config
 * carries a `project=<pin>` arg, so the config routes strictly to this project's engine instance even
 * when the account has several. `--no-pin` is the escape hatch. The pin is a routing path segment,
 * never part of the OAuth resource (the canonical resource stays `https://ai-game.dev/mcp`).
 *
 * **Credential policy (project-keys contract §7, owner rulings 2026-09-23):**
 *   - an explicit `--token` always wins (http `Authorization` header / stdio `token=` arg);
 *   - otherwise a **Cloud** http config (a non-loopback hub URL) carries `Authorization: Bearer
 *     agd_pk_…` — a non-expiring **project key** strictly bound to this project's pin, reused from
 *     `~/.ai-game-dev/project-keys.json` or minted with the machine credential — for EVERY client,
 *     through each client's own static-header mechanism (`headers`, Codex `http_headers`);
 *   - `--oauth` opts out: a URL-only config (the client authorizes natively, RFC 9728) and any
 *     previously written header is removed;
 *   - `--regenerate-key` mints a fresh key, overwrites the cache entry and rewrites the config;
 *   - with no machine login (or when minting fails) the config falls back to URL-only, with a warning;
 *   - stdio configs and local-server (loopback) configs are unchanged.
 *
 * {@link resolveSetupMcpPlan} is the PURE decision (no IO, fully testable); {@link setupMcp} resolves
 * the project key, runs the plan and writes the file via the golden-vector-gated
 * {@link JsonAiAgentConfig}/{@link TomlAiAgentConfig}.
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
  /** An explicit PAT (`--token`); wins over {@link projectKey}. */
  token?: string;
  /** The project key (`agd_pk_…`) for a Cloud http config. Ignored for stdio. */
  projectKey?: string;
  /** Remove any previously written auth header when none is emitted (a Cloud URL-only config). */
  clearAuthHeader?: boolean;
  /** An explicit base URL override (hosted or local). Defaults to {@link DEFAULT_HOSTED_MCP_URL}. */
  url?: string;
  /** The `--no-pin` escape hatch: write an unpinned URL / omit the `project=` arg. */
  noPin: boolean;
  /** The resolved server binary path (from the adapter); defaults to `adapter.serverBinaryPath`. */
  serverPath?: string;
}

/** The credential a written config carries: an explicit PAT, a project key, or none (URL-only). */
export type SetupMcpCredential = "token" | "project-key" | "none";

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
  /** Whether a static `Authorization` header / `token=` arg is emitted. */
  emitAuthHeader: boolean;
  /** Which credential the config carries. */
  credential: SetupMcpCredential;
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

  // An explicit --token wins; a project key applies to the http transport only (stdio unchanged).
  const secret = input.token || (transport === "http" ? input.projectKey : undefined) || "";
  const credential: SetupMcpCredential = input.token ? "token" : secret ? "project-key" : "none";
  const emitAuthHeader = credential !== "none";

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
      token: emitAuthHeader ? secret : undefined,
    });
    if (pinned) stdioArgsVec.push(`${PROJECT_ARG_NAME}=${pin}`);
    props = agent.getStdioProps(serverPath, stdioArgsVec);
    // A stdio entry never carries a static http header: drop one a previous Cloud http config wrote
    // (a live project key would otherwise linger in the file, and Codex rejects `http_headers` on a
    // stdio server). Mirrors the C# writer's `ApplyStdioAuthorization`, which strips `headers`.
    removeKeys = [...agent.stdioRemoveKeys, httpHeadersKeyOf(agent)];
  } else {
    const base = input.url ?? DEFAULT_HOSTED_MCP_URL;
    resolvedUrl = pinned ? pinUrl(base, pin) : stripPinFromUrl(base);
    const headers = emitAuthHeader ? { Authorization: `Bearer ${secret}` } : undefined;
    props = agent.getHttpProps(resolvedUrl, headers);
    removeKeys =
      !emitAuthHeader && input.clearAuthHeader
        ? [...agent.httpRemoveKeys, httpHeadersKeyOf(agent)]
        : agent.httpRemoveKeys;
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
    credential,
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
  /** An explicit PAT (`--token`) — always wins over the project key. */
  token?: string;
  /** `--oauth`: write a URL-only config (native client OAuth), removing any previous auth header. */
  oauth?: boolean;
  /** `--regenerate-key`: mint a fresh project key (overwriting the cached one) and rewrite the config. */
  regenerateKey?: boolean;
  /** Display machine name recorded on a minted key; defaults to `os.hostname()`. */
  machineName?: string;
  /**
   * Resolves the project key for a Cloud http config. Defaults to {@link createProjectKeyResolver}
   * over the machine credential store; injectable for tests and for callers (the App) that own a
   * credential provider already.
   */
  projectKeyResolver?: ProjectKeyResolver;
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
      /** Which credential the written config carries. */
      credential: SetupMcpCredential;
      /** The server-side id of the project key written (credential `project-key` only). */
      projectKeyId?: string;
      /** Whether the project key was reused from the cache or freshly minted. */
      projectKeySource?: "reused" | "minted";
      warnings: string[];
    }
  | { kind: "failure"; error: Error; warnings: string[] };

/**
 * Configure an AI agent's MCP client for a project — resolve the agent + project + pin/port, resolve
 * the Cloud project key (§7), build the plan, and write it. Library-safe: never throws past the boundary. `projectPath` defaults to cwd
 * (closing the "path required" half of B1 for the config surface too).
 */
export async function setupMcp(opts: SetupMcpOptions): Promise<SetupMcpResult> {
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

    const base = opts.url ?? DEFAULT_HOSTED_MCP_URL;
    const hasToken = typeof opts.token === "string" && opts.token.length > 0;
    const cloud = transport === "http" && isCloudUrl(base);
    if (opts.regenerateKey && (opts.oauth || hasToken || !cloud)) {
      return {
        kind: "failure",
        warnings,
        error: new Error(
          "--regenerate-key applies only to a Cloud http config without --oauth / --token " +
            "(project keys are not used for stdio or a local server).",
        ),
      };
    }

    emitProgress(opts.onProgress, {
      phase: "start",
      message: `Configuring ${agent.name} (${transport}) for ${projectRoot}`,
    });

    let key: Extract<ProjectKeyResult, { kind: "ok" }> | undefined;
    if (cloud && !hasToken && !opts.oauth) {
      const resolver = opts.projectKeyResolver ?? createProjectKeyResolver(opts.adapter);
      const outcome = await resolver({
        issuer: toAuthServerRoot(base),
        pin,
        engine: opts.adapter.engine,
        label: projectRoot,
        machineName: opts.machineName,
        regenerate: opts.regenerateKey === true,
      });
      if (outcome.kind === "ok") {
        key = outcome;
        warnings.push(...outcome.warnings);
      } else if (opts.regenerateKey) {
        return { kind: "failure", warnings, error: new Error(`Could not regenerate the project key: ${outcome.reason}`) };
      } else {
        warnings.push(
          `No project key written (${outcome.reason}) — the config is URL-only and the agent must sign in with its own OAuth. ` +
            "Sign in on this machine and run setup-mcp again to write a project key.",
        );
      }
    }

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
      projectKey: key?.key,
      // A Cloud config that ends up URL-only (--oauth, no login, failed mint) must not keep a stale
      // header — it would suppress the client's native OAuth. Local-server configs are untouched.
      clearAuthHeader: cloud,
      url: opts.url,
      noPin: opts.noPin === true,
    });

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
      credential: plan.credential,
      projectKeyId: key?.keyId,
      projectKeySource: key?.source,
      warnings,
    };
  } catch (err) {
    return { kind: "failure", warnings, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/** Convert a registry JSON prop value to a TOML value (codex only produces TOML-representable props). */
function toTomlValue(value: JsonNode): TomlValue {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string")) {
    return value as Record<string, string>; // an inline table — Codex `http_headers`
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  if (Array.isArray(value) && value.every((v) => typeof v === "number")) return value as number[];
  if (Array.isArray(value) && value.every((v) => typeof v === "boolean")) return value as boolean[];
  throw new Error(`Value is not representable in a TOML agent config: ${JSON.stringify(value)}`);
}

/**
 * True when `rawUrl` addresses a Cloud (hosted) hub — i.e. anything but a loopback / `localhost`
 * local server. Project keys are minted only for Cloud configs (§7: local-server mode unchanged).
 */
export function isCloudUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Only the engine-local server itself is excluded; a named dev stack (`agd.localhost`) is a Cloud.
  if (host === "localhost" || host === "0.0.0.0") return false;
  return !isLoopbackHost(host);
}

/** One project-key resolution request (built by {@link setupMcp}). */
export interface ProjectKeyRequest {
  /** The issuer (AS root) of the Cloud hub, e.g. `https://ai-game.dev`. */
  issuer: string;
  pin: string;
  engine: ProjectKeyEngine;
  /** Display label (the project folder path). */
  label?: string;
  machineName?: string;
  /** Force a fresh mint (`--regenerate-key`). */
  regenerate: boolean;
}

/** Resolves a project key for setup-mcp — never throws (see {@link ProjectKeyResult}). */
export type ProjectKeyResolver = (request: ProjectKeyRequest) => Promise<ProjectKeyResult>;

/**
 * The default {@link ProjectKeyResolver}: the machine credential store + provider (agent → plugin →
 * legacy family, refreshed under the store lock with the adapter's client id as the legacy default),
 * the `~/.ai-game-dev/project-keys.json` cache, and the HTTP mint/validate transport.
 */
export function createProjectKeyResolver(
  adapter: EngineAdapter,
  credentials?: MachineCredentialProvider,
): ProjectKeyResolver {
  return async ({ regenerate, ...request }) => {
    const provider =
      credentials ??
      new MachineCredentialProvider(
        new MachineCredentialStore(),
        new HttpTokenRefresher({ defaultServerBaseUrl: request.issuer }),
        { defaultClientId: adapter.clientId },
      );
    const options = { ...request, credentials: provider };
    return regenerate ? regenerateProjectKey(options) : getOrMintProjectKey(options);
  };
}

export { getAgentIds, getAgentById };
