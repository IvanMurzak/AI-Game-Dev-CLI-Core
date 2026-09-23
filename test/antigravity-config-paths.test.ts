import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  configPathsOf,
  derivePinV2,
  DEFAULT_HOSTED_MCP_URL,
  getAgentById,
  getMcpConfigStatus,
  removeMcpConfig,
  setupMcp,
  unityAdapter,
  type JsonNode,
  type ProjectKeyResolver,
  type SetupMcpOptions,
} from "../src/index.js";
import { MemFs } from "./mem-fs.js";

/**
 * Antigravity reads its global MCP config from ONE of two files, and which one differs per machine /
 * install (owner request 2026-09-23): configure writes both, status accepts either but rejects a stale
 * one, remove touches only the existing ones, every displayed path lists both.
 */

const PROJECT = path.resolve("/proj/my-game");
const PIN = derivePinV2(PROJECT);
const KEY = "agd_pk_TestProjectKey_0123456789abcdef";
const URL_PINNED = `${DEFAULT_HOSTED_MCP_URL}/p/${PIN}`;
const A = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
const B = path.join(os.homedir(), ".gemini", "antigravity", "mcp_config.json");
const SERVER = unityAdapter.serverName;

const resolver: ProjectKeyResolver = async () => ({ kind: "ok", key: KEY, keyId: "k1", pin: PIN, source: "minted", warnings: [] });

function configure(fs: MemFs, extra: Partial<SetupMcpOptions> = {}) {
  return setupMcp({ adapter: unityAdapter, agentId: "antigravity", projectPath: PROJECT, projectKeyResolver: resolver, fs, ...extra });
}

function status(fs: MemFs) {
  const res = getMcpConfigStatus({ adapter: unityAdapter, agentId: "antigravity", projectPath: PROJECT, fs });
  if (res.kind !== "success") throw res.error;
  return res;
}

function root(fs: MemFs, file: string): Record<string, JsonNode> {
  return JSON.parse(fs.get(file)!) as Record<string, JsonNode>;
}

function entry(fs: MemFs, file: string): Record<string, JsonNode> | undefined {
  return (root(fs, file)["mcpServers"] as Record<string, JsonNode> | undefined)?.[SERVER] as Record<string, JsonNode> | undefined;
}

/** A file holding another server + a top-level field the writer must preserve untouched. */
function foreignFile(ourEntry?: Record<string, JsonNode>): string {
  return JSON.stringify({
    theme: "dark",
    mcpServers: { other: { serverUrl: "https://other.example/mcp", disabled: true }, ...(ourEntry ? { [SERVER]: ourEntry } : {}) },
  });
}

describe("antigravity — two candidate config files", () => {
  it("the registry lists both locations under the user profile, and the display names both", () => {
    const anti = getAgentById("antigravity")!;
    expect(configPathsOf(anti, PROJECT)).toEqual([A, B]);
    expect(anti.getConfigPath(PROJECT)).toBe(A);
    expect(anti.configPathDisplay).toContain("~/.gemini/config/mcp_config.json");
    expect(anti.configPathDisplay).toContain("~/.gemini/antigravity/mcp_config.json");
    // Other clients keep exactly one path.
    expect(configPathsOf(getAgentById("cursor")!, PROJECT)).toEqual([path.join(PROJECT, ".cursor", "mcp.json")]);
  });

  it("configure writes the same entry into BOTH files, creating the missing ones", async () => {
    const fs = new MemFs();
    const res = await configure(fs);
    if (res.kind !== "success") throw res.error;
    expect(res.configPaths).toEqual([A, B]);
    expect(res.configPath).toBe(A);
    for (const file of [A, B]) {
      expect(entry(fs, file)).toEqual({ disabled: false, headers: { Authorization: `Bearer ${KEY}` }, serverUrl: URL_PINNED });
    }
  });

  it("configure preserves every other entry and field in each file", async () => {
    const fs = new MemFs({ [A]: foreignFile(), [B]: foreignFile({ command: "old.exe", args: ["x"] }) });
    const res = await configure(fs);
    if (res.kind !== "success") throw res.error;
    for (const file of [A, B]) {
      const r = root(fs, file);
      expect(r["theme"]).toBe("dark");
      expect((r["mcpServers"] as Record<string, JsonNode>)["other"]).toEqual({ serverUrl: "https://other.example/mcp", disabled: true });
      expect(entry(fs, file)!["serverUrl"]).toBe(URL_PINNED);
      expect(entry(fs, file)!["command"]).toBeUndefined();
    }
  });

  it("a failure writing one file is reported with its path (the other file is still written)", async () => {
    class FailB extends MemFs {
      override writeFileSync(p: string, data: string): void {
        if (p.replace(/\\/g, "/") === B.replace(/\\/g, "/")) throw new Error("EACCES");
        super.writeFileSync(p, data);
      }
    }
    const fs = new FailB();
    const res = await configure(fs);
    expect(res.kind).toBe("failure");
    if (res.kind !== "failure") return;
    expect(res.error.message).toContain(B);
    expect(res.error.message).toContain(`written: ${A}`);
    expect(entry(fs, A)!["serverUrl"]).toBe(URL_PINNED);
  });

  describe("status", () => {
    const good = { disabled: false, serverUrl: URL_PINNED, headers: { Authorization: `Bearer ${KEY}` } };

    it("no candidate file ⇒ not configured", () => {
      const s = status(new MemFs());
      expect(s.configured).toBe(false);
      expect(s.existingPaths).toEqual([]);
      expect(s.configPaths).toEqual([A, B]);
    });

    it("only A present and correct ⇒ NOT configured, and a Configure creates B", async () => {
      const fs = new MemFs({ [A]: foreignFile(good) });
      const s = status(fs);
      expect(s.configured).toBe(false);
      expect(s.existingPaths).toEqual([A]);
      expect(s.misconfiguredPaths).toEqual([]);
      const res = await configure(fs);
      if (res.kind !== "success") throw res.error;
      expect(status(fs).configured).toBe(true);
    });

    it("only B present and correct ⇒ NOT configured", () => {
      const s = status(new MemFs({ [B]: foreignFile(good) }));
      expect(s.configured).toBe(false);
      expect(s.existingPaths).toEqual([B]);
    });

    it("both present and correct ⇒ configured", () => {
      expect(status(new MemFs({ [A]: foreignFile(good), [B]: foreignFile(good) })).configured).toBe(true);
    });

    it("the credential header is not part of the check (a key rotates, a URL-only config is valid)", () => {
      const urlOnly = foreignFile({ disabled: false, serverUrl: URL_PINNED });
      expect(status(new MemFs({ [A]: urlOnly, [B]: urlOnly })).configured).toBe(true);
    });

    for (const [label, stale] of [
      ["A", { [A]: foreignFile({ disabled: false, serverUrl: `${DEFAULT_HOSTED_MCP_URL}/p/00000000` }), [B]: foreignFile(good) }],
      ["B", { [A]: foreignFile(good), [B]: foreignFile({ disabled: false, serverUrl: `${DEFAULT_HOSTED_MCP_URL}/p/00000000` }) }],
    ] as const) {
      it(`both present, ${label} stale ⇒ NOT configured, and a Configure repairs both`, async () => {
        const fs = new MemFs({ ...stale });
        const before = status(fs);
        expect(before.configured).toBe(false);
        expect(before.misconfiguredPaths).toEqual([label === "A" ? A : B]);
        const res = await configure(fs);
        if (res.kind !== "success") throw res.error;
        expect(status(fs).configured).toBe(true);
      });
    }

    it("an existing file with no entry (or unparsable) makes the agent not configured", () => {
      expect(status(new MemFs({ [A]: foreignFile(good), [B]: foreignFile() })).configured).toBe(false);
      expect(status(new MemFs({ [A]: foreignFile(good), [B]: "{ not json" })).configured).toBe(false);
    });

    it("never creates or modifies a file", () => {
      const fs = new MemFs({ [A]: foreignFile(good) });
      const before = fs.get(A);
      status(fs);
      expect(fs.get(A)).toBe(before);
      expect(fs.get(B)).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("removes our entry from BOTH files, preserving the rest, never deleting a file", async () => {
      const fs = new MemFs({ [A]: foreignFile(), [B]: foreignFile() });
      await configure(fs);
      const res = removeMcpConfig({ adapter: unityAdapter, agentId: "antigravity", projectPath: PROJECT, fs });
      if (res.kind !== "success") throw res.error;
      expect(res.removedPaths).toEqual([A, B]);
      expect(res.failedPaths).toEqual([]);
      for (const file of [A, B]) {
        expect(fs.get(file)).toBeDefined();
        expect(entry(fs, file)).toBeUndefined();
        expect((root(fs, file)["mcpServers"] as Record<string, JsonNode>)["other"]).toBeDefined();
        expect(root(fs, file)["theme"]).toBe("dark");
      }
      expect(status(fs).configured).toBe(false);
    });

    it("never creates a missing file to remove from it", () => {
      const fs = new MemFs({ [A]: foreignFile({ disabled: false, serverUrl: URL_PINNED }) });
      const res = removeMcpConfig({ adapter: unityAdapter, agentId: "antigravity", projectPath: PROJECT, fs });
      if (res.kind !== "success") throw res.error;
      expect(res.removedPaths).toEqual([A]);
      expect(fs.get(B)).toBeUndefined();
    });

    it("an unknown agent is a failure, not a throw", () => {
      expect(removeMcpConfig({ adapter: unityAdapter, agentId: "nope", projectPath: PROJECT, fs: new MemFs() }).kind).toBe("failure");
      expect(getMcpConfigStatus({ adapter: unityAdapter, agentId: "nope", projectPath: PROJECT, fs: new MemFs() }).kind).toBe("failure");
    });
  });
});
