import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  setupMcp,
  resolveSetupMcpPlan,
  DEFAULT_HOSTED_MCP_URL,
  unityAdapter,
  unrealAdapter,
  godotAdapter,
  getAgentById,
  derivePinV2,
  type JsonNode,
} from "../src/index.js";
import { MemFs } from "./mem-fs.js";

const PROJECT = path.resolve("/proj/my-game");
const PIN = derivePinV2(PROJECT);

function entry(fs: MemFs, configPath: string, bodyPath: string, serverName = "ai-game-developer"): Record<string, JsonNode> {
  const root = JSON.parse(fs.get(configPath.replace(/\\/g, "/"))!) as Record<string, JsonNode>;
  return (root[bodyPath] as Record<string, JsonNode>)[serverName] as Record<string, JsonNode>;
}

describe("setup-mcp policy — T4 pinned URL default", () => {
  it("http default pins the URL to /mcp/p/<pin-v2> (B4 fix)", () => {
    const fs = new MemFs();
    const res = setupMcp({ adapter: unityAdapter, agentId: "claude-code", projectPath: PROJECT, fs });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    expect(res.resolvedUrl).toBe(`${DEFAULT_HOSTED_MCP_URL}/p/${PIN}`);
    expect(res.pinned).toBe(true);
    const e = entry(fs, res.configPath, "mcpServers");
    expect(e["url"]).toBe(`${DEFAULT_HOSTED_MCP_URL}/p/${PIN}`);
    expect(e["type"]).toBe("http");
  });

  it("--no-pin writes an unpinned URL (escape hatch)", () => {
    const fs = new MemFs();
    const res = setupMcp({ adapter: unityAdapter, agentId: "claude-code", projectPath: PROJECT, noPin: true, fs });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    expect(res.resolvedUrl).toBe(DEFAULT_HOSTED_MCP_URL);
    expect(res.pinned).toBe(false);
    expect(entry(fs, res.configPath, "mcpServers")["url"]).toBe(DEFAULT_HOSTED_MCP_URL);
  });

  it("stdio default adds project=<pin>; --no-pin omits it", () => {
    const plan = resolveSetupMcpPlan({
      adapter: unityAdapter,
      agent: getAgentById("claude-code")!,
      transport: "stdio",
      projectRoot: PROJECT,
      pin: PIN,
      port: 23940,
      timeoutMs: 10000,
      authorization: "none",
      noPin: false,
    });
    expect(plan.stdioArgs).toContain(`project=${PIN}`);

    const noPin = resolveSetupMcpPlan({
      adapter: unityAdapter,
      agent: getAgentById("claude-code")!,
      transport: "stdio",
      projectRoot: PROJECT,
      pin: PIN,
      port: 23940,
      timeoutMs: 10000,
      authorization: "none",
      noPin: true,
    });
    expect(noPin.stdioArgs!.some((a) => a.startsWith("project="))).toBe(false);
  });
});

describe("setup-mcp policy — M7 credential-free default", () => {
  it("emits NO auth header by default (credential-free .mcp.json)", () => {
    const fs = new MemFs();
    const res = setupMcp({ adapter: unityAdapter, agentId: "claude-code", projectPath: PROJECT, fs });
    expect(res.kind === "success" && res.emitAuthHeader).toBe(false);
    expect(entry(fs, (res as { configPath: string }).configPath, "mcpServers")["headers"]).toBeUndefined();
  });

  it("emits an Authorization header ONLY on an explicit --token opt-in", () => {
    const fs = new MemFs();
    const res = setupMcp({ adapter: unityAdapter, agentId: "claude-code", projectPath: PROJECT, token: "PAT123", fs });
    expect(res.kind === "success" && res.emitAuthHeader).toBe(true);
    if (res.kind !== "success") return;
    const headers = entry(fs, res.configPath, "mcpServers")["headers"] as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer PAT123");
    // A project-scoped credential warning is surfaced (design 03 Flow C).
    expect(res.warnings.some((w) => w.includes("token"))).toBe(true);
  });

  it("stdio embeds token= only on an explicit --token opt-in", () => {
    const withToken = resolveSetupMcpPlan({
      adapter: unityAdapter,
      agent: getAgentById("claude-code")!,
      transport: "stdio",
      projectRoot: PROJECT,
      pin: PIN,
      port: 1,
      timeoutMs: 1,
      authorization: "required",
      token: "PAT",
      noPin: true,
    });
    expect(withToken.stdioArgs).toContain("token=PAT");

    const noToken = resolveSetupMcpPlan({
      adapter: unityAdapter,
      agent: getAgentById("claude-code")!,
      transport: "stdio",
      projectRoot: PROJECT,
      pin: PIN,
      port: 1,
      timeoutMs: 1,
      authorization: "none",
      noPin: true,
    });
    expect(noToken.stdioArgs!.some((a) => a.startsWith("token="))).toBe(false);
  });
});

describe("setup-mcp policy — guards + engine parameterization", () => {
  it("rejects stdio for an http-only engine (Godot, M6)", () => {
    const fs = new MemFs();
    const res = setupMcp({ adapter: godotAdapter, agentId: "claude-code", transport: "stdio", projectPath: PROJECT, fs });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") expect(res.error.message).toMatch(/stdio/);
  });

  it("rejects an unknown agent id with an actionable message", () => {
    const res = setupMcp({ adapter: unityAdapter, agentId: "nope", projectPath: PROJECT });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") expect(res.error.message).toMatch(/Unknown agent/);
  });

  it("writes the Unreal server name (unreal-mcp), not a hard-coded name", () => {
    const fs = new MemFs();
    const res = setupMcp({ adapter: unrealAdapter, agentId: "cursor", projectPath: PROJECT, fs });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    const root = JSON.parse(fs.get(res.configPath.replace(/\\/g, "/"))!) as Record<string, JsonNode>;
    expect((root["mcpServers"] as Record<string, JsonNode>)["unreal-mcp"]).toBeDefined();
  });

  it("codex (TOML) writes a pinned http config with tool_timeout_sec", () => {
    const fs = new MemFs();
    const res = setupMcp({ adapter: unityAdapter, agentId: "codex", projectPath: PROJECT, fs });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    const content = fs.get(res.configPath.replace(/\\/g, "/"))!;
    expect(content).toContain("[mcp_servers.ai-game-developer]");
    expect(content).toContain(`url = "${DEFAULT_HOSTED_MCP_URL}/p/${PIN}"`);
    expect(content).toContain("tool_timeout_sec = 300");
  });
});
