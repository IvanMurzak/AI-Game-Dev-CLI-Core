import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  setupMcp,
  resolveSetupMcpPlan,
  isCloudUrl,
  DEFAULT_HOSTED_MCP_URL,
  unityAdapter,
  unrealAdapter,
  godotAdapter,
  agentRegistry,
  getAgentById,
  httpHeadersKeyOf,
  derivePinV2,
  type AgentDefinition,
  type JsonNode,
  type ProjectKeyRequest,
  type ProjectKeyResolver,
  type ProjectKeyResult,
  type SetupMcpOptions,
} from "../src/index.js";
import { MemFs } from "./mem-fs.js";

const PROJECT = path.resolve("/proj/my-game");
const PIN = derivePinV2(PROJECT);
const KEY = "agd_pk_TestProjectKey_0123456789abcdef";

function entry(fs: MemFs, configPath: string, bodyPath: string, serverName = "ai-game-developer"): Record<string, JsonNode> {
  const root = JSON.parse(fs.get(configPath.replace(/\\/g, "/"))!) as Record<string, JsonNode>;
  return (root[bodyPath] as Record<string, JsonNode>)[serverName] as Record<string, JsonNode>;
}

/** A recording resolver — tests NEVER reach the real machine store or network. */
function fakeResolver(result: ProjectKeyResult = { kind: "ok", key: KEY, keyId: "k1", pin: PIN, source: "minted", warnings: [] }) {
  const calls: ProjectKeyRequest[] = [];
  const resolver: ProjectKeyResolver = async (req) => {
    calls.push(req);
    return result;
  };
  return { resolver, calls };
}

function run(opts: Partial<SetupMcpOptions> & { agentId: string }, resolver = fakeResolver().resolver) {
  return setupMcp({ adapter: unityAdapter, projectPath: PROJECT, projectKeyResolver: resolver, ...opts });
}

/** The static Authorization header a written config carries for `agent`, or undefined. */
function writtenAuthorization(fs: MemFs, agent: AgentDefinition, configPath: string): string | undefined {
  const content = fs.get(configPath.replace(/\\/g, "/"))!;
  if (agent.configFormat === "toml") {
    const m = content.match(/^http_headers = \{ "Authorization" = "([^"]*)" \}$/m);
    return m?.[1];
  }
  const e = entry(fs, configPath, agent.bodyPath);
  const headers = e[httpHeadersKeyOf(agent)] as Record<string, string> | undefined;
  return headers?.["Authorization"];
}

describe("setup-mcp policy — T4 pinned URL default", () => {
  it("http default pins the URL to /mcp/p/<pin-v2> (B4 fix)", async () => {
    const fs = new MemFs();
    const res = await run({ agentId: "claude-code", fs });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    expect(res.resolvedUrl).toBe(`${DEFAULT_HOSTED_MCP_URL}/p/${PIN}`);
    expect(res.pinned).toBe(true);
    const e = entry(fs, res.configPath, "mcpServers");
    expect(e["url"]).toBe(`${DEFAULT_HOSTED_MCP_URL}/p/${PIN}`);
    expect(e["type"]).toBe("http");
  });

  it("--no-pin writes an unpinned URL (escape hatch)", async () => {
    const fs = new MemFs();
    const res = await run({ agentId: "claude-code", noPin: true, fs });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    expect(res.resolvedUrl).toBe(DEFAULT_HOSTED_MCP_URL);
    expect(res.pinned).toBe(false);
    expect(entry(fs, res.configPath, "mcpServers")["url"]).toBe(DEFAULT_HOSTED_MCP_URL);
  });

  it("stdio default adds project=<pin>; --no-pin omits it", () => {
    const base = {
      adapter: unityAdapter,
      agent: getAgentById("claude-code")!,
      transport: "stdio" as const,
      projectRoot: PROJECT,
      pin: PIN,
      port: 23940,
      timeoutMs: 10000,
      authorization: "none",
    };
    expect(resolveSetupMcpPlan({ ...base, noPin: false }).stdioArgs).toContain(`project=${PIN}`);
    expect(resolveSetupMcpPlan({ ...base, noPin: true }).stdioArgs!.some((a) => a.startsWith("project="))).toBe(false);
  });
});

describe("setup-mcp policy — Cloud project-key header for EVERY client (contract §7)", () => {
  // The plant gate: disabling the default project-key header path must redden this for every client.
  it.each(agentRegistry.map((a) => [a.id, a] as const))("%s: Cloud default writes Authorization: Bearer agd_pk_…", async (_id, agent) => {
    const fs = new MemFs();
    const { resolver, calls } = fakeResolver();
    const res = await run({ agentId: agent.id, fs }, resolver);
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    expect(res.credential).toBe("project-key");
    expect(res.emitAuthHeader).toBe(true);
    expect(res.projectKeyId).toBe("k1");
    expect(writtenAuthorization(fs, agent, res.configPath)).toBe(`Bearer ${KEY}`);
    expect(calls).toEqual([
      { issuer: "https://ai-game.dev", pin: PIN, engine: "unity", label: PROJECT, machineName: undefined, regenerate: false },
    ]);
  });

  it("codex writes the key through its documented `http_headers` inline table", async () => {
    const fs = new MemFs();
    const res = await run({ agentId: "codex", fs });
    if (res.kind !== "success") throw res.error;
    const content = fs.get(res.configPath.replace(/\\/g, "/"))!;
    expect(content).toContain(`http_headers = { "Authorization" = "Bearer ${KEY}" }`);
    expect(content).toContain(`url = "${DEFAULT_HOSTED_MCP_URL}/p/${PIN}"`);
    expect(content).toContain("tool_timeout_sec = 300");
  });

  it("antigravity writes `serverUrl` + `headers`", async () => {
    const fs = new MemFs();
    const res = await run({ agentId: "antigravity", fs });
    if (res.kind !== "success") throw res.error;
    const e = entry(fs, res.configPath, "mcpServers");
    expect(e["serverUrl"]).toBe(`${DEFAULT_HOSTED_MCP_URL}/p/${PIN}`);
    expect(e["headers"]).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it("writes no 'may be committed' / git warning for a project-scoped key (owner ruling)", async () => {
    const fs = new MemFs();
    const res = await run({ agentId: "claude-code", fs });
    if (res.kind !== "success") throw res.error;
    expect(res.configPath.startsWith(PROJECT)).toBe(true);
    expect(res.warnings).toEqual([]);
  });

  it("an explicit --token wins: the PAT is written and no key is resolved", async () => {
    const fs = new MemFs();
    const { resolver, calls } = fakeResolver();
    const res = await run({ agentId: "claude-code", token: "PAT123", fs }, resolver);
    if (res.kind !== "success") throw res.error;
    expect(res.credential).toBe("token");
    expect(entry(fs, res.configPath, "mcpServers")["headers"]).toEqual({ Authorization: "Bearer PAT123" });
    expect(calls).toHaveLength(0);
  });

  it("--oauth writes a URL-only config and removes a previously written header", async () => {
    const fs = new MemFs();
    await run({ agentId: "claude-code", fs });
    const { resolver, calls } = fakeResolver();
    const res = await run({ agentId: "claude-code", oauth: true, fs }, resolver);
    if (res.kind !== "success") throw res.error;
    expect(res.credential).toBe("none");
    expect(entry(fs, res.configPath, "mcpServers")["headers"]).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("--oauth removes codex's `http_headers` too", async () => {
    const fs = new MemFs();
    await run({ agentId: "codex", fs });
    const res = await run({ agentId: "codex", oauth: true, fs });
    if (res.kind !== "success") throw res.error;
    expect(fs.get(res.configPath.replace(/\\/g, "/"))!).not.toContain("http_headers");
  });

  it("--regenerate-key asks the resolver for a fresh mint", async () => {
    const fs = new MemFs();
    const { resolver, calls } = fakeResolver();
    const res = await run({ agentId: "cursor", regenerateKey: true, fs }, resolver);
    expect(res.kind).toBe("success");
    expect(calls[0]!.regenerate).toBe(true);
  });

  it("--regenerate-key conflicts with --oauth, --token, stdio and a local server", async () => {
    for (const extra of [
      { oauth: true },
      { token: "PAT" },
      { transport: "stdio" as const },
      { url: "http://localhost:8080" },
    ]) {
      const { resolver, calls } = fakeResolver();
      const res = await run({ agentId: "claude-code", regenerateKey: true, fs: new MemFs(), ...extra }, resolver);
      expect(res.kind).toBe("failure");
      expect(calls).toHaveLength(0);
    }
  });

  it("a failed regeneration is a failure (never a silent URL-only rewrite)", async () => {
    const fs = new MemFs();
    const { resolver } = fakeResolver({ kind: "error", reason: "HTTP 503" });
    const res = await run({ agentId: "claude-code", regenerateKey: true, fs }, resolver);
    expect(res.kind).toBe("failure");
    expect(fs.files.size).toBe(0);
  });

  it("no machine login ⇒ URL-only config + an actionable warning", async () => {
    const fs = new MemFs();
    const { resolver } = fakeResolver({ kind: "no-login", reason: "not signed in" });
    const res = await run({ agentId: "claude-code", fs }, resolver);
    if (res.kind !== "success") throw res.error;
    expect(res.credential).toBe("none");
    expect(entry(fs, res.configPath, "mcpServers")["headers"]).toBeUndefined();
    expect(res.warnings.join(" ")).toMatch(/not signed in.*URL-only/);
  });

  it("a Cloud URL-only fallback strips a stale header; a local-server config keeps its own", async () => {
    const fs = new MemFs();
    await run({ agentId: "claude-code", fs });
    const { resolver } = fakeResolver({ kind: "no-login", reason: "not signed in" });
    const res = await run({ agentId: "claude-code", fs }, resolver);
    if (res.kind !== "success") throw res.error;
    expect(entry(fs, res.configPath, "mcpServers")["headers"]).toBeUndefined();

    const local = new MemFs();
    await run({ agentId: "claude-code", url: "http://localhost:23940", token: "PAT", fs: local });
    const again = await run({ agentId: "claude-code", url: "http://localhost:23940", fs: local });
    if (again.kind !== "success") throw again.error;
    expect(entry(local, again.configPath, "mcpServers")["headers"]).toEqual({ Authorization: "Bearer PAT" });
  });

  it("a mint error ⇒ URL-only config + warning (setup still succeeds)", async () => {
    const fs = new MemFs();
    const { resolver } = fakeResolver({ kind: "error", reason: "minting a project key failed: HTTP 503" });
    const res = await run({ agentId: "claude-code", fs }, resolver);
    if (res.kind !== "success") throw res.error;
    expect(res.credential).toBe("none");
    expect(res.warnings.join(" ")).toMatch(/HTTP 503/);
  });

  it("local-server mode (loopback URL) is unchanged: no key resolved, no header", async () => {
    for (const url of ["http://localhost:23940", "http://127.0.0.1:23940/mcp", "http://[::1]:8080"]) {
      const fs = new MemFs();
      const { resolver, calls } = fakeResolver();
      const res = await run({ agentId: "claude-code", url, fs }, resolver);
      if (res.kind !== "success") throw res.error;
      expect(res.credential).toBe("none");
      expect(calls).toHaveLength(0);
    }
  });

  it("stdio is unchanged: no key resolved, no token= arg", async () => {
    const fs = new MemFs();
    const { resolver, calls } = fakeResolver();
    const res = await run({ agentId: "claude-code", transport: "stdio", fs }, resolver);
    if (res.kind !== "success") throw res.error;
    expect(calls).toHaveLength(0);
    const args = entry(fs, res.configPath, "mcpServers")["args"] as string[];
    expect(args.some((a) => a.startsWith("token="))).toBe(false);
  });

  it("the issuer is the AS root of a custom Cloud URL, and the engine comes from the adapter", async () => {
    const { resolver, calls } = fakeResolver();
    await setupMcp({
      adapter: unrealAdapter,
      agentId: "cursor",
      projectPath: PROJECT,
      url: "https://staging.ai-game.dev/mcp",
      machineName: "box",
      fs: new MemFs(),
      projectKeyResolver: resolver,
    });
    expect(calls[0]).toMatchObject({ issuer: "https://staging.ai-game.dev", engine: "unreal", machineName: "box" });
  });

  it("isCloudUrl: hosted vs loopback", () => {
    expect(isCloudUrl("https://ai-game.dev/mcp")).toBe(true);
    expect(isCloudUrl("http://localhost:1")).toBe(false);
    expect(isCloudUrl("http://127.0.0.1:1")).toBe(false);
    expect(isCloudUrl("not a url")).toBe(false);
    expect(isCloudUrl("http://agd.localhost/mcp")).toBe(true);
  });

  it("stdio embeds token= only on an explicit --token (a project key never reaches stdio)", () => {
    const base = {
      adapter: unityAdapter,
      agent: getAgentById("claude-code")!,
      transport: "stdio" as const,
      projectRoot: PROJECT,
      pin: PIN,
      port: 1,
      timeoutMs: 1,
      authorization: "required",
      noPin: true,
    };
    expect(resolveSetupMcpPlan({ ...base, token: "PAT" }).stdioArgs).toContain("token=PAT");
    expect(resolveSetupMcpPlan({ ...base, projectKey: KEY }).stdioArgs!.some((a) => a.startsWith("token="))).toBe(false);
  });
});

describe("setup-mcp policy — guards + engine parameterization", () => {
  it("rejects stdio for an http-only engine (Godot, M6)", async () => {
    const res = await run({ adapter: godotAdapter, agentId: "claude-code", transport: "stdio", fs: new MemFs() });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") expect(res.error.message).toMatch(/stdio/);
  });

  it("rejects an unknown agent id with an actionable message", async () => {
    const res = await run({ agentId: "nope" });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") expect(res.error.message).toMatch(/Unknown agent/);
  });

  it("writes the Unreal server name (unreal-mcp), not a hard-coded name", async () => {
    const fs = new MemFs();
    const res = await run({ adapter: unrealAdapter, agentId: "cursor", fs });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    const root = JSON.parse(fs.get(res.configPath.replace(/\\/g, "/"))!) as Record<string, JsonNode>;
    expect((root["mcpServers"] as Record<string, JsonNode>)["unreal-mcp"]).toBeDefined();
  });
});
