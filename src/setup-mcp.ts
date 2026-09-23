import * as path from "node:path";

import type { EngineAdapter } from "./engine-adapter.js";
import { derivePinV2, derivePortV2 } from "./project-identity.js";
import { pinUrl, stripPinFromUrl } from "./routing.js";
import {
  agentRegistry,
  configPathsOf,
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
  /** The primary config file (the first of {@link configPaths}). */
  configPath: string;
  /**
   * Every config file the plan writes — one for most clients, several for a client whose config
   * location cannot be predicted (Antigravity: `~/.gemini/config/` AND `~/.gemini/antigravity/`).
   */
  configPaths: string[];
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

  const configPaths = configPathsOf(agent, input.projectRoot);
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
    configPath: configPaths[0]!,
    configPaths,
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

/** The golden-vector-gated writer for `plan` (the same instance configures, checks and removes). */
function planWriter(plan: SetupMcpPlan): JsonAiAgentConfig | TomlAiAgentConfig {
  const writer =
    plan.configFormat === "toml"
      ? new TomlAiAgentConfig({ serverName: plan.serverName, bodyPath: plan.bodyPath })
      : new JsonAiAgentConfig({ serverName: plan.serverName, bodyPath: plan.bodyPath });
  for (const [key, value] of Object.entries(plan.props)) {
    const required = plan.requiredKeys.includes(key);
    if (writer instanceof TomlAiAgentConfig) writer.setProperty(key, toTomlValue(value), required);
    else writer.setProperty(key, value, required);
  }
  for (const key of plan.removeKeys) writer.setPropertyToRemove(key);
  return writer;
}

/** Which of a plan's config files were written and which failed ({@link writeSetupMcpPlanPaths}). */
export interface SetupMcpWriteOutcome {
  written: string[];
  failed: string[];
}

/**
 * Write the plan to EVERY one of its config files (creating missing directories/files, preserving
 * every other entry) and report per file — one failure never hides another's success or vice versa.
 */
export function writeSetupMcpPlanPaths(plan: SetupMcpPlan, io: AgentConfigFs = nodeFs): SetupMcpWriteOutcome {
  const writer = planWriter(plan);
  const outcome: SetupMcpWriteOutcome = { written: [], failed: [] };
  for (const configPath of plan.configPaths) {
    (writer.configure(configPath, io) ? outcome.written : outcome.failed).push(configPath);
  }
  return outcome;
}

/** Write the plan to all of its config files. Returns true only when EVERY file was written. */
export function writeSetupMcpPlan(plan: SetupMcpPlan, io: AgentConfigFs = nodeFs): boolean {
  return writeSetupMcpPlanPaths(plan, io).failed.length === 0;
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
      /** The primary config file written (the first of {@link configPaths}). */
      configPath: string;
      /** Every config file written (Antigravity: both of its candidate locations). */
      configPaths: string[];
      /**
       * Regenerate only: the OTHER agent configs of this project that carried the previous project key
       * and were moved to the new one before the previous key was revoked.
       */
      rewrittenConfigPaths?: string[];
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

    const io = opts.fs ?? nodeFs;
    const { written, failed } = writeSetupMcpPlanPaths(plan, io);

    // Regenerate (§7): the other agent configs of this project still carry the OLD key, and revoking it
    // would lock every one of them out — so move them to the new key first.
    let rewrittenConfigPaths: string[] | undefined;
    let notRewritten: string[] = [];
    if (key?.revokePrevious && key.previousKey) {
      const moved = rewritePreviousProjectKey({
        serverName: plan.serverName,
        projectRoot,
        pin,
        previousKey: key.previousKey,
        newKey: key.key,
        skipPaths: plan.configPaths,
        io,
      });
      rewrittenConfigPaths = moved.written;
      notRewritten = moved.failed;
    }

    // Revoke the old key only once the new key is cached AND every config that held the old key was
    // rewritten — an unwritten config still carries the old key, so revoking it would lock the agent
    // out. A revoke failure (or a throw from an injected resolver's callback) is reported, never fatal.
    if (key?.revokePrevious) {
      if (failed.length > 0 || notRewritten.length > 0) {
        const stuck = [...failed, ...notRewritten].join(", ");
        warnings.push(
          `The config(s) ${stuck} could not be written with the new project key, so the previous project key was left active.`,
        );
      } else {
        try {
          const revokeWarning = await key.revokePrevious();
          if (revokeWarning) warnings.push(revokeWarning);
        } catch (err) {
          warnings.push(`Revoking the previous project key failed (${err instanceof Error ? err.message : String(err)}).`);
        }
      }
    }

    if (failed.length > 0) {
      const partial = written.length > 0 ? ` (written: ${written.join(", ")})` : "";
      return {
        kind: "failure",
        warnings,
        error: new Error(`Could not write the ${agent.name} config ${failed.join(", ")}${partial}.`),
      };
    }

    emitProgress(opts.onProgress, { phase: "done", message: `${agent.name} configured (${plan.configPaths.join(", ")})` });

    return {
      kind: "success",
      agentId: agent.id,
      configPath: plan.configPath,
      configPaths: plan.configPaths,
      rewrittenConfigPaths,
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

/** The inputs {@link rewritePreviousProjectKey} needs (all resolved by {@link setupMcp}). */
interface RewritePreviousKeyInput {
  serverName: string;
  projectRoot: string;
  pin: string;
  previousKey: string;
  newKey: string;
  /** The configs setup-mcp itself just wrote with the new key (not rewritten again). */
  skipPaths: readonly string[];
  io: AgentConfigFs;
}

/**
 * Regenerate (§7): move every OTHER agent config of this project that still authenticates with the
 * previous project key — an http entry pinned to this pin whose `Authorization` header (Codex:
 * `http_headers`) is `Bearer <previous key>` — to the new key, touching nothing else in the file.
 * Then verify the world: any existing config whose bytes still contain the previous key (a failed
 * write, an unpinned entry, a renamed server entry, an unparsable file) is reported in `failed`, and
 * the caller must then NOT revoke the previous key.
 */
function rewritePreviousProjectKey(input: RewritePreviousKeyInput): SetupMcpWriteOutcome {
  const { io, pin } = input;
  const outcome: SetupMcpWriteOutcome = { written: [], failed: [] };
  const previousHeader = `Bearer ${input.previousKey}`;
  const seen = new Set(input.skipPaths);
  for (const agent of agentRegistry) {
    for (const configPath of configPathsOf(agent, input.projectRoot)) {
      if (seen.has(configPath)) continue;
      seen.add(configPath);
      if (!io.existsSync(configPath)) continue;

      const options = { serverName: input.serverName, bodyPath: agent.bodyPath };
      const writer = agent.configFormat === "toml" ? new TomlAiAgentConfig(options) : new JsonAiAgentConfig(options);
      const entry: Record<string, unknown> | null = writer.readServerEntry(configPath, io);
      const headersKey = httpHeadersKeyOf(agent);
      const headers = entry?.[headersKey];
      const url = entry?.["url"] ?? entry?.["serverUrl"];
      if (headers && typeof headers === "object" && !Array.isArray(headers) && typeof url === "string" && pinUrl(url, pin) === url) {
        const record = headers as Record<string, string>;
        const name = Object.keys(record).find((k) => k.toLowerCase() === "authorization" && record[k] === previousHeader);
        if (name) {
          const updated = { ...record, [name]: `Bearer ${input.newKey}` };
          writer.setProperty(headersKey, updated, false);
          if (writer.configure(configPath, io)) outcome.written.push(configPath);
        }
      }

      let text: string;
      try {
        text = io.readFileSync(configPath);
      } catch {
        continue; // unreadable now ⇒ it cannot present the previous key either
      }
      if (text.includes(input.previousKey)) {
        outcome.written = outcome.written.filter((p) => p !== configPath);
        outcome.failed.push(configPath);
      }
    }
  }
  return outcome;
}

/** Which agent config to inspect/remove ({@link getMcpConfigStatus}, {@link removeMcpConfig}). */
export interface McpConfigTargetOptions {
  adapter: EngineAdapter;
  /** The AI-agent client id (see {@link getAgentIds}). */
  agentId: string;
  /** Transport the config is expected to use; defaults to `http`. Status only. */
  transport?: McpTransport;
  /** The project root; defaults to `cwd` / `process.cwd()`. */
  projectPath?: string;
  /** An explicit base URL override (hosted or local). Status only. */
  url?: string;
  /** `--no-pin`: expect an unpinned URL / no `project=` arg. Status only. */
  noPin?: boolean;
  /** The explicit PAT a stdio config carries as `token=`. Status only. */
  token?: string;
  /** Timeout (ms) a stdio config carries; defaults to 10000. Status only. */
  timeoutMs?: number;
  /** `authorization` mode arg a stdio config carries; defaults to `none`. Status only. */
  authorization?: string;
  cwd?: string;
  fs?: AgentConfigFs;
}

/** The result of {@link getMcpConfigStatus}. */
export type McpConfigStatusResult =
  | {
      kind: "success";
      agentId: string;
      /** Configured ⇔ at least one candidate file exists AND every existing one is configured. */
      configured: boolean;
      /** Every candidate config file (for display — all of them, not just the existing ones). */
      configPaths: string[];
      /** The candidate files that exist. */
      existingPaths: string[];
      /** Existing files without a correctly configured entry (stale / misconfigured / unparsable). */
      misconfiguredPaths: string[];
    }
  | { kind: "failure"; error: Error };

/** The result of {@link removeMcpConfig}. */
export type RemoveMcpConfigResult =
  | {
      kind: "success";
      agentId: string;
      configPaths: string[];
      /** Existing files the entry was removed from. */
      removedPaths: string[];
      /** Existing files that still carry the entry after the attempt (unwritable / unparsable). */
      failedPaths: string[];
    }
  | { kind: "failure"; error: Error };

function resolveTarget(opts: McpConfigTargetOptions): { agent: AgentDefinition; projectRoot: string } | Error {
  const agent = getAgentById(opts.agentId);
  if (!agent) return new Error(`Unknown agent "${opts.agentId}". Available: ${getAgentIds().join(", ")}`);
  return { agent, projectRoot: path.resolve(opts.projectPath ?? opts.cwd ?? process.cwd()) };
}

/**
 * Is `agentId` configured for the project? The expected entry is what {@link setupMcp} writes for the
 * same transport / URL / pin (the credential header is not part of the check — a key rotates). For a
 * client with several candidate files (Antigravity): configured ⇔ at least one exists AND every
 * existing one carries a correct entry — a missing file is ignored, a stale one makes the agent
 * "not configured" so a Configure repairs both. Never creates or modifies a file. Never throws.
 */
export function getMcpConfigStatus(opts: McpConfigTargetOptions): McpConfigStatusResult {
  try {
    const target = resolveTarget(opts);
    if (target instanceof Error) return { kind: "failure", error: target };
    const { agent, projectRoot } = target;
    const plan = resolveSetupMcpPlan({
      adapter: opts.adapter,
      agent,
      transport: opts.transport ?? "http",
      projectRoot,
      pin: derivePinV2(projectRoot),
      port: derivePortV2(projectRoot),
      timeoutMs: opts.timeoutMs ?? 10000,
      authorization: opts.authorization ?? "none",
      token: opts.token,
      url: opts.url,
      noPin: opts.noPin === true,
    });
    const io = opts.fs ?? nodeFs;
    const writer = planWriter(plan);
    const existingPaths = plan.configPaths.filter((p) => io.existsSync(p));
    const misconfiguredPaths = existingPaths.filter((p) => !writer.isConfigured(p, io));
    return {
      kind: "success",
      agentId: agent.id,
      configured: existingPaths.length > 0 && misconfiguredPaths.length === 0,
      configPaths: plan.configPaths,
      existingPaths,
      misconfiguredPaths,
    };
  } catch (err) {
    return { kind: "failure", error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/**
 * Remove the server entry (plus deprecated / duplicate entries) from EVERY existing candidate config
 * file of `agentId`. Never creates a file to remove from it and never deletes a file. A file that still
 * carries the entry afterwards is reported in `failedPaths`. Never throws.
 */
export function removeMcpConfig(opts: McpConfigTargetOptions): RemoveMcpConfigResult {
  try {
    const target = resolveTarget(opts);
    if (target instanceof Error) return { kind: "failure", error: target };
    const { agent, projectRoot } = target;
    const io = opts.fs ?? nodeFs;
    const options = { serverName: opts.adapter.serverName, bodyPath: agent.bodyPath };
    const writer = agent.configFormat === "toml" ? new TomlAiAgentConfig(options) : new JsonAiAgentConfig(options);
    const configPaths = configPathsOf(agent, projectRoot);
    const removedPaths: string[] = [];
    const failedPaths: string[] = [];
    for (const configPath of configPaths) {
      if (!io.existsSync(configPath)) continue;
      if (writer.unconfigure(configPath, io)) removedPaths.push(configPath);
      if (writer.isDetected(configPath, io)) failedPaths.push(configPath);
    }
    return { kind: "success", agentId: agent.id, configPaths, removedPaths, failedPaths };
  } catch (err) {
    return { kind: "failure", error: err instanceof Error ? err : new Error(String(err)) };
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
