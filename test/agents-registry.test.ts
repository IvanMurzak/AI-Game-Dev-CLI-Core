import { describe, expect, it } from "vitest";

import { agentRegistry, getAgentById, getAgentIds } from "../src/index.js";

describe("agents-registry", () => {
  it("exposes stable ids incl. the core clients", () => {
    const ids = getAgentIds();
    for (const id of ["claude-code", "cursor", "vscode-copilot", "codex", "custom"]) {
      expect(ids).toContain(id);
    }
    expect(getAgentById("claude-code")?.name).toBe("Claude Code");
    expect(getAgentById("nope")).toBeUndefined();
  });

  it("every entry has a distinct id and a config path resolver", () => {
    const ids = new Set<string>();
    for (const agent of agentRegistry) {
      expect(ids.has(agent.id)).toBe(false);
      ids.add(agent.id);
      expect(typeof agent.getConfigPath("/proj")).toBe("string");
    }
  });

  it("is engine-neutral: getStdioProps/getHttpProps take the caller's serverPath/args/url", () => {
    const claude = getAgentById("claude-code")!;
    const stdio = claude.getStdioProps("/bin/server", ["port=1"]);
    expect(stdio["command"]).toBe("/bin/server");
    expect(stdio["args"]).toEqual(["port=1"]);

    const http = claude.getHttpProps("https://ai-game.dev/mcp/p/abc", { Authorization: "Bearer T" });
    expect(http["url"]).toBe("https://ai-game.dev/mcp/p/abc");
    expect(http["headers"]).toEqual({ Authorization: "Bearer T" });
    // Credential-free by default (no headers when none passed).
    expect(claude.getHttpProps("https://x", undefined)["headers"]).toBeUndefined();
  });

  it("codex is TOML and drops any token= from its stdio args (M7)", () => {
    const codex = getAgentById("codex")!;
    expect(codex.configFormat).toBe("toml");
    const stdio = codex.getStdioProps("/bin/server", ["port=1", "token=SECRET"]);
    expect((stdio["args"] as string[]).some((a) => a.startsWith("token="))).toBe(false);
  });

  it("antigravity ignores auth headers (uses serverUrl)", () => {
    const anti = getAgentById("antigravity")!;
    const http = anti.getHttpProps("https://x", { Authorization: "Bearer T" });
    expect(http["headers"]).toBeUndefined();
    expect(http["serverUrl"]).toBe("https://x");
  });
});
