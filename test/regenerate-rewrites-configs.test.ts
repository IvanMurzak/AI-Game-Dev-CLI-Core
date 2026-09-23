import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  derivePinV2,
  DEFAULT_HOSTED_MCP_URL,
  setupMcp,
  unityAdapter,
  type JsonNode,
  type ProjectKeyResolver,
} from "../src/index.js";
import { MemFs } from "./mem-fs.js";

/**
 * Regenerate (§7) revokes the previous key — which every OTHER agent config of the same project still
 * carries. Those configs must be moved to the new key first, and the revoke skipped when any of them
 * could not be, or regenerating for one agent locks every other agent out.
 */

const PROJECT = path.resolve("/proj/my-game");
const PIN = derivePinV2(PROJECT);
const OLD = "agd_pk_OldKey_000000000000000000000000";
const NEW = "agd_pk_NewKey_111111111111111111111111";
const URL_PINNED = `${DEFAULT_HOSTED_MCP_URL}/p/${PIN}`;
const SERVER = unityAdapter.serverName;

const CURSOR = path.join(PROJECT, ".cursor", "mcp.json");
const VSCODE = path.join(PROJECT, ".vscode", "mcp.json");
const CODEX = path.join(PROJECT, ".codex", "config.toml");
const MCP_JSON = path.join(PROJECT, ".mcp.json");
const ANTI_A = path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
const ANTI_B = path.join(os.homedir(), ".gemini", "antigravity", "mcp_config.json");

function jsonConfig(body: string, entry: Record<string, JsonNode>, extra: Record<string, JsonNode> = {}): string {
  return JSON.stringify({ ...extra, [body]: { other: { url: "https://x.example", headers: { Authorization: "Bearer theirs" } }, [SERVER]: entry } }, null, 2);
}

const codexConfig = (key: string, url = URL_PINNED) =>
  `[mcp_servers.${SERVER}]\nenabled = true\nhttp_headers = { "Authorization" = "Bearer ${key}" }\nstartup_timeout_sec = 30\ntool_timeout_sec = 300\nurl = "${url}"\n`;

function regenerating(onRevoke: () => void = () => {}): ProjectKeyResolver {
  return async () => ({
    kind: "ok",
    key: NEW,
    keyId: "k2",
    pin: PIN,
    source: "minted",
    warnings: [],
    previousKey: OLD,
    revokePrevious: async () => {
      onRevoke();
      return undefined;
    },
  });
}

function seeded(): MemFs {
  return new MemFs({
    [CURSOR]: jsonConfig("mcpServers", { type: "http", url: URL_PINNED, headers: { Authorization: `Bearer ${OLD}`, "X-Extra": "keep" } }, { keep: 1 }),
    [VSCODE]: jsonConfig("servers", { type: "http", url: URL_PINNED, headers: { Authorization: `Bearer ${OLD}` } }),
    [CODEX]: `# user comment\nmodel = "o3"\n\n${codexConfig(OLD)}`,
    [ANTI_A]: jsonConfig("mcpServers", { disabled: false, serverUrl: URL_PINNED, headers: { Authorization: `Bearer ${OLD}` } }),
  });
}

function entry(fs: MemFs, file: string, body: string): Record<string, JsonNode> {
  return (JSON.parse(fs.get(file)!)[body] as Record<string, JsonNode>)[SERVER] as Record<string, JsonNode>;
}

describe("setup-mcp --regenerate-key rewrites every other config of the project before revoking", () => {
  it("moves every other agent config that carried the old key to the new key, then revokes", async () => {
    const fs = seeded();
    const snapshotsAtRevoke: string[] = [];
    const res = await setupMcp({
      adapter: unityAdapter,
      agentId: "claude-code",
      projectPath: PROJECT,
      regenerateKey: true,
      fs,
      projectKeyResolver: regenerating(() => snapshotsAtRevoke.push(...fs.files.values())),
    });
    if (res.kind !== "success") throw res.error;

    // The revoke ran, and at that moment no file anywhere still held the old key.
    expect(snapshotsAtRevoke.length).toBeGreaterThan(0);
    expect(snapshotsAtRevoke.some((c) => c.includes(OLD))).toBe(false);
    expect(res.warnings).toEqual([]);
    expect(new Set(res.rewrittenConfigPaths)).toEqual(new Set([CURSOR, VSCODE, CODEX, ANTI_A]));

    expect(entry(fs, MCP_JSON, "mcpServers")["headers"]).toEqual({ Authorization: `Bearer ${NEW}` });
    // Only the header changed; the rest of each file is preserved.
    expect(entry(fs, CURSOR, "mcpServers")["headers"]).toEqual({ Authorization: `Bearer ${NEW}`, "X-Extra": "keep" });
    expect(JSON.parse(fs.get(CURSOR)!)["keep"]).toBe(1);
    expect((JSON.parse(fs.get(CURSOR)!)["mcpServers"] as Record<string, JsonNode>)["other"]).toEqual({
      url: "https://x.example",
      headers: { Authorization: "Bearer theirs" },
    });
    expect(entry(fs, VSCODE, "servers")["headers"]).toEqual({ Authorization: `Bearer ${NEW}` });
    expect(entry(fs, ANTI_A, "mcpServers")["headers"]).toEqual({ Authorization: `Bearer ${NEW}` });
    expect(fs.get(CODEX)).toContain(`http_headers = { "Authorization" = "Bearer ${NEW}" }`);
    expect(fs.get(CODEX)).toContain("# user comment");
    expect(fs.get(CODEX)).toContain('model = "o3"');
    // A config the old key never lived in is not created.
    expect(fs.get(ANTI_B)).toBeUndefined();
  });

  it("a config pinned to ANOTHER project, or carrying another key, is left alone", async () => {
    const otherPin = `${DEFAULT_HOSTED_MCP_URL}/p/0123abcd`;
    const fs = new MemFs({
      [CURSOR]: jsonConfig("mcpServers", { type: "http", url: otherPin, headers: { Authorization: "Bearer agd_pk_someone_else" } }),
    });
    const before = fs.get(CURSOR);
    let revoked = false;
    const res = await setupMcp({
      adapter: unityAdapter,
      agentId: "claude-code",
      projectPath: PROJECT,
      regenerateKey: true,
      fs,
      projectKeyResolver: regenerating(() => (revoked = true)),
    });
    if (res.kind !== "success") throw res.error;
    expect(fs.get(CURSOR)).toBe(before);
    expect(res.rewrittenConfigPaths).toEqual([]);
    expect(revoked).toBe(true);
  });

  it("a config still carrying the old key that cannot be rewritten is reported and the revoke is SKIPPED", async () => {
    // Unpinned URL: not an entry of this project's pin, so it is not rewritten — but it still holds the
    // old key, and revoking would break it.
    const fs = new MemFs({
      [CURSOR]: jsonConfig("mcpServers", { type: "http", url: DEFAULT_HOSTED_MCP_URL, headers: { Authorization: `Bearer ${OLD}` } }),
      [VSCODE]: jsonConfig("servers", { type: "http", url: URL_PINNED, headers: { Authorization: `Bearer ${OLD}` } }),
    });
    let revoked = false;
    const res = await setupMcp({
      adapter: unityAdapter,
      agentId: "claude-code",
      projectPath: PROJECT,
      regenerateKey: true,
      fs,
      projectKeyResolver: regenerating(() => (revoked = true)),
    });
    if (res.kind !== "success") throw res.error;
    expect(revoked).toBe(false);
    expect(res.warnings.join(" ")).toContain(CURSOR);
    expect(res.warnings.join(" ")).toMatch(/previous project key was left active/);
    expect(res.rewrittenConfigPaths).toEqual([VSCODE]);
  });

  it("a rewrite that fails to WRITE skips the revoke and names the path", async () => {
    class FailCursor extends MemFs {
      override writeFileSync(p: string, data: string): void {
        if (p.replace(/\\/g, "/") === CURSOR.replace(/\\/g, "/")) throw new Error("EACCES");
        super.writeFileSync(p, data);
      }
    }
    const fs = new FailCursor({
      [CURSOR]: jsonConfig("mcpServers", { type: "http", url: URL_PINNED, headers: { Authorization: `Bearer ${OLD}` } }),
    });
    let revoked = false;
    const res = await setupMcp({
      adapter: unityAdapter,
      agentId: "claude-code",
      projectPath: PROJECT,
      regenerateKey: true,
      fs,
      projectKeyResolver: regenerating(() => (revoked = true)),
    });
    if (res.kind !== "success") throw res.error;
    expect(revoked).toBe(false);
    expect(res.warnings.join(" ")).toContain(CURSOR);
    expect(res.rewrittenConfigPaths).toEqual([]);
  });

  it("regenerating for Antigravity writes the new key into BOTH of its files and rewrites the others", async () => {
    const fs = seeded();
    let revoked = false;
    const res = await setupMcp({
      adapter: unityAdapter,
      agentId: "antigravity",
      projectPath: PROJECT,
      regenerateKey: true,
      fs,
      projectKeyResolver: regenerating(() => (revoked = true)),
    });
    if (res.kind !== "success") throw res.error;
    expect(revoked).toBe(true);
    for (const f of [ANTI_A, ANTI_B]) expect(entry(fs, f, "mcpServers")["headers"]).toEqual({ Authorization: `Bearer ${NEW}` });
    expect(new Set(res.rewrittenConfigPaths)).toEqual(new Set([CURSOR, VSCODE, CODEX]));
  });

  it("a plain (non-regenerate) configure never rewrites other agents' configs", async () => {
    const fs = seeded();
    const before = fs.get(CURSOR);
    const res = await setupMcp({
      adapter: unityAdapter,
      agentId: "claude-code",
      projectPath: PROJECT,
      fs,
      projectKeyResolver: async () => ({ kind: "ok", key: NEW, keyId: "k2", pin: PIN, source: "minted", warnings: [] }),
    });
    if (res.kind !== "success") throw res.error;
    expect(fs.get(CURSOR)).toBe(before);
    expect(res.rewrittenConfigPaths).toBeUndefined();
  });
});
