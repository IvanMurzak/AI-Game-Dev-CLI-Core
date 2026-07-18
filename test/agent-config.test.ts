import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  JsonAiAgentConfig,
  TomlAiAgentConfig,
  RawTomlValue,
  ValueComparisonMode,
  type JsonNode,
  type TomlValue,
} from "../src/index.js";
import { MemFs } from "./mem-fs.js";

/**
 * Byte-for-byte parity with the C# AgentConfig writers is THE point of this module: the
 * `expectedFileContent()` of both writers MUST reproduce the vendored golden vectors
 * (`AgentConfig.GoldenVectors.json`, derived from the C# JsonAiAgentConfig/TomlAiAgentConfig
 * ExpectedFileContent path). The rest of the suite is the behavioural port of the C# writer tests
 * (create/merge/unconfigure/isConfigured/duplicate cleanup).
 */

interface JsonVector {
  note: string;
  serverName: string;
  bodyPath: string;
  properties: Record<string, JsonNode>;
  expected: string;
}
interface TomlVector {
  note: string;
  serverName: string;
  bodyPath: string;
  properties: Record<string, TomlValue>;
  expected: string;
}
interface GoldenFile {
  json: JsonVector[];
  toml: TomlVector[];
}

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL("./golden-vectors/AgentConfig.GoldenVectors.json", import.meta.url)), "utf-8"),
) as GoldenFile;

describe("AgentConfig — golden-vector parity (byte-for-byte with the C# reference)", () => {
  for (const v of golden.json) {
    it(`json expectedFileContent matches for: ${v.note}`, () => {
      const cfg = new JsonAiAgentConfig({ serverName: v.serverName, bodyPath: v.bodyPath });
      for (const [key, value] of Object.entries(v.properties)) cfg.setProperty(key, value);
      expect(cfg.expectedFileContent()).toBe(v.expected);
    });
  }

  for (const v of golden.toml) {
    it(`toml expectedFileContent matches for: ${v.note}`, () => {
      const cfg = new TomlAiAgentConfig({ serverName: v.serverName, bodyPath: v.bodyPath });
      for (const [key, value] of Object.entries(v.properties)) cfg.setProperty(key, value);
      expect(cfg.expectedFileContent()).toBe(v.expected);
    });
  }
});

const CONFIG = "/proj/.mcp.json";
const TOML = "/proj/config.toml";

function stdioJson(bodyPath = "mcpServers"): JsonAiAgentConfig {
  return new JsonAiAgentConfig({ bodyPath })
    .setProperty("type", "stdio", true)
    .setProperty("command", "C:/x/gamedev-mcp-server.exe", true)
    .setProperty("args", ["port=23940", "plugin-timeout=10000", "client-transport=stdio"], true)
    .setPropertyToRemove("url");
}
function httpJson(bodyPath = "mcpServers"): JsonAiAgentConfig {
  return new JsonAiAgentConfig({ bodyPath })
    .setProperty("type", "http", true)
    .setProperty("url", "https://ai-game.dev/mcp", true)
    .setPropertyToRemove("command")
    .setPropertyToRemove("args");
}

describe("JsonAiAgentConfig — configure/isConfigured", () => {
  it("creates a new file and reports configured", () => {
    const fs = new MemFs();
    expect(stdioJson().configure(CONFIG, fs)).toBe(true);
    expect(stdioJson().isConfigured(CONFIG, fs)).toBe(true);
    const root = JSON.parse(fs.get(CONFIG)!) as Record<string, JsonNode>;
    const entry = (root["mcpServers"] as Record<string, JsonNode>)["ai-game-developer"] as Record<string, JsonNode>;
    expect(entry["command"]).toBeDefined();
    expect(entry["args"]).toBeDefined();
    expect(entry["url"]).toBeUndefined();
  });

  it("switching stdio->http removes stdio props (and vice versa)", () => {
    const fs = new MemFs();
    stdioJson().configure(CONFIG, fs);
    expect(httpJson().configure(CONFIG, fs)).toBe(true);
    let entry = readEntry(fs, CONFIG);
    expect(entry["url"]).toBeDefined();
    expect(entry["command"]).toBeUndefined();
    expect(entry["args"]).toBeUndefined();

    expect(stdioJson().configure(CONFIG, fs)).toBe(true);
    entry = readEntry(fs, CONFIG);
    expect(entry["command"]).toBeDefined();
    expect(entry["url"]).toBeUndefined();
  });

  it("preserves unrelated sibling servers", () => {
    const fs = new MemFs({
      [CONFIG]: JSON.stringify({ mcpServers: { otherServer: { command: "other", args: ["--x"] } } }),
    });
    stdioJson().configure(CONFIG, fs);
    const servers = (JSON.parse(fs.get(CONFIG)!) as Record<string, JsonNode>)["mcpServers"] as Record<string, JsonNode>;
    expect(servers["otherServer"]).toBeDefined();
    expect(servers["ai-game-developer"]).toBeDefined();
  });

  it("removes a duplicate entry written under a different name by matching command", () => {
    const fs = new MemFs({
      [CONFIG]: JSON.stringify({ mcpServers: { "my-name": { type: "stdio", command: "C:/x/gamedev-mcp-server.exe" } } }),
    });
    stdioJson().configure(CONFIG, fs);
    const servers = (JSON.parse(fs.get(CONFIG)!) as Record<string, JsonNode>)["mcpServers"] as Record<string, JsonNode>;
    expect(servers["my-name"]).toBeUndefined();
    expect(servers["ai-game-developer"]).toBeDefined();
  });

  it("isConfigured is false with a property-to-remove present, or wrong required value", () => {
    const fs = new MemFs({
      [CONFIG]: JSON.stringify({
        mcpServers: {
          "ai-game-developer": {
            command: "C:/x/gamedev-mcp-server.exe",
            args: ["port=23940", "plugin-timeout=10000", "client-transport=stdio"],
            url: "http://localhost:1/mcp",
          },
        },
      }),
    });
    expect(stdioJson().isConfigured(CONFIG, fs)).toBe(false); // url is a property-to-remove
  });

  it("isConfigured is false for empty/missing files", () => {
    const fs = new MemFs({ [CONFIG]: "" });
    expect(stdioJson().isConfigured(CONFIG, fs)).toBe(false);
    expect(stdioJson().isConfigured("/nope.json", fs)).toBe(false);
  });

  it("Path/Url comparison modes treat separators/scheme leniently", () => {
    const fs = new MemFs({
      [CONFIG]: JSON.stringify({ mcpServers: { "ai-game-developer": { command: "C:\\Users\\t\\app.exe" } } }),
    });
    const pathCfg = new JsonAiAgentConfig().setProperty(
      "command",
      "C:/Users/t/app.exe",
      true,
      ValueComparisonMode.Path,
    );
    expect(pathCfg.isConfigured(CONFIG, fs)).toBe(true);

    const exactCfg = new JsonAiAgentConfig().setProperty("command", "C:/Users/t/app.exe", true);
    expect(exactCfg.isConfigured(CONFIG, fs)).toBe(false);

    const fs2 = new MemFs({
      [CONFIG]: JSON.stringify({ mcpServers: { "ai-game-developer": { url: "HTTP://LOCALHOST:5000/mcp/" } } }),
    });
    const urlCfg = new JsonAiAgentConfig().setProperty(
      "url",
      "http://localhost:5000/mcp",
      true,
      ValueComparisonMode.Url,
    );
    expect(urlCfg.isConfigured(CONFIG, fs2)).toBe(true);
  });

  it("unconfigure removes deprecated + current entries; false when nothing to remove", () => {
    const fs = new MemFs({
      [CONFIG]: JSON.stringify({ mcpServers: { "Unity-MCP": { command: "/old" }, "ai-game-developer": { command: "/x" } } }),
    });
    expect(stdioJson().unconfigure(CONFIG, fs)).toBe(true);
    const servers = (JSON.parse(fs.get(CONFIG)!) as Record<string, JsonNode>)["mcpServers"] as Record<string, JsonNode>;
    expect(servers["Unity-MCP"]).toBeUndefined();
    expect(servers["ai-game-developer"]).toBeUndefined();

    const fs2 = new MemFs({ [CONFIG]: JSON.stringify({ mcpServers: { other: { command: "diff" } } }) });
    expect(stdioJson().unconfigure(CONFIG, fs2)).toBe(false);
  });

  it("isDetected true for a deprecated name", () => {
    const fs = new MemFs({ [CONFIG]: JSON.stringify({ mcpServers: { "Unity-MCP": { command: "/x" } } }) });
    expect(stdioJson().isDetected(CONFIG, fs)).toBe(true);
  });

  it("applyStdioAuthorization adds/removes the token arg and strips headers", () => {
    const cfg = stdioJson();
    cfg.applyStdioAuthorization(true, "SECRET");
    const fs = new MemFs();
    cfg.configure(CONFIG, fs);
    const args = readEntry(fs, CONFIG)["args"] as string[];
    expect(args).toContain("token=SECRET");

    cfg.applyStdioAuthorization(false, undefined);
    const fs2 = new MemFs();
    cfg.configure(CONFIG, fs2);
    expect((readEntry(fs2, CONFIG)["args"] as string[]).some((a) => a.startsWith("token="))).toBe(false);
  });

  it("applyHttpAuthorization writes/removes the Authorization header", () => {
    const withAuth = httpJson().applyHttpAuthorization(true, "PATVALUE");
    const fs = new MemFs();
    withAuth.configure(CONFIG, fs);
    const headers = readEntry(fs, CONFIG)["headers"] as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer PATVALUE");

    const noAuth = httpJson().applyHttpAuthorization(false, undefined);
    const fs2 = new MemFs();
    noAuth.configure(CONFIG, fs2);
    expect(readEntry(fs2, CONFIG)["headers"]).toBeUndefined();
  });
});

describe("TomlAiAgentConfig — configure/isConfigured", () => {
  function stdioToml(bodyPath = "mcp_servers"): TomlAiAgentConfig {
    return new TomlAiAgentConfig({ bodyPath })
      .setProperty("command", "C:/x/gamedev-mcp-server.exe", true)
      .setProperty("args", ["port=23940", "plugin-timeout=10000", "client-transport=stdio"], true)
      .setPropertyToRemove("url");
  }

  it("creates a new file, reports configured, and round-trips isConfigured", () => {
    const fs = new MemFs();
    expect(stdioToml().configure(TOML, fs)).toBe(true);
    expect(stdioToml().isConfigured(TOML, fs)).toBe(true);
    expect(fs.get(TOML)).toContain("[mcp_servers.ai-game-developer]");
  });

  it("merges into an existing section preserving unmanaged keys", () => {
    const fs = new MemFs({ [TOML]: '[mcp_servers.ai-game-developer]\ncommand = "old"\ncustom_prop = "keep"\n' });
    stdioToml().configure(TOML, fs);
    expect(fs.get(TOML)).toContain('custom_prop = "keep"');
    expect(fs.get(TOML)).not.toContain("old");
  });

  it("preserves unrelated sections + a float/date value", () => {
    const fs = new MemFs({ [TOML]: '[other]\nkey = "value"\ntimeout = 1.5\ncreated = 2024-01-01\n' });
    stdioToml().configure(TOML, fs);
    expect(fs.get(TOML)).toContain("[other]");
    expect(fs.get(TOML)).toContain("timeout = 1.5");
    expect(fs.get(TOML)).toContain("created = 2024-01-01");
    expect(fs.get(TOML)).toContain("[mcp_servers.ai-game-developer]");
  });

  it("does not duplicate the section across repeated configure calls", () => {
    const fs = new MemFs();
    const cfg = stdioToml();
    cfg.configure(TOML, fs);
    cfg.configure(TOML, fs);
    const header = "[mcp_servers.ai-game-developer]";
    const first = fs.get(TOML)!.indexOf(header);
    expect(fs.get(TOML)!.indexOf(header, first + 1)).toBe(-1);
  });

  it("removes a duplicate section written under a different name by command", () => {
    const fs = new MemFs({ [TOML]: '[mcp_servers.my-name]\ncommand = "C:/x/gamedev-mcp-server.exe"\nargs = ["--old"]\n' });
    stdioToml().configure(TOML, fs);
    expect(fs.get(TOML)).not.toContain("[mcp_servers.my-name]");
    expect(fs.get(TOML)).toContain("[mcp_servers.ai-game-developer]");
  });

  it("round-trips int/bool/string arrays through isConfigured", () => {
    const fs = new MemFs({ [TOML]: "[mcp_servers.ai-game-developer]\nports = [8080, 8081, 8082]\n" });
    expect(new TomlAiAgentConfig().setProperty("ports", [8080, 8081, 8082], true).isConfigured(TOML, fs)).toBe(true);
    expect(new TomlAiAgentConfig().setProperty("ports", [9000, 9001], true).isConfigured(TOML, fs)).toBe(false);
  });

  it("preserves an unmanaged inline table via RawTomlValue round-trip", () => {
    const fs = new MemFs({ [TOML]: '[mcp_servers.ai-game-developer]\ncommand = "old"\nport = 8080 # a comment\n' });
    stdioToml().configure(TOML, fs);
    expect(fs.get(TOML)).toContain("port = 8080");
    expect(fs.get(TOML)).not.toContain("# a comment");
  });

  it("string comparison respects Path/Url/Exact modes", () => {
    const fs = new MemFs({ [TOML]: '[mcp_servers.ai-game-developer]\ncommand = "C:\\\\Users\\\\t\\\\app.exe"\n' });
    expect(
      new TomlAiAgentConfig().setProperty("command", "C:/Users/t/app.exe", true, ValueComparisonMode.Path).isConfigured(TOML, fs),
    ).toBe(true);
    expect(new TomlAiAgentConfig().setProperty("command", "C:/Users/t/app.exe", true).isConfigured(TOML, fs)).toBe(false);
  });

  it("unconfigure removes the section; false when nothing present", () => {
    const fs = new MemFs({ [TOML]: '[mcp_servers.ai-game-developer]\ncommand = "/x"\n' });
    expect(stdioToml().unconfigure(TOML, fs)).toBe(true);
    expect(fs.get(TOML)).not.toContain("[mcp_servers.ai-game-developer]");

    const fs2 = new MemFs({ [TOML]: '[mcp_servers.other]\ncommand = "diff"\n' });
    expect(stdioToml().unconfigure(TOML, fs2)).toBe(false);
  });

  it("exposes RawTomlValue for verbatim values", () => {
    const cfg = new TomlAiAgentConfig().setProperty("ratio", new RawTomlValue("1.5"), true);
    expect(cfg.expectedFileContent()).toContain("ratio = 1.5");
  });
});

function readEntry(fs: MemFs, path: string): Record<string, JsonNode> {
  const root = JSON.parse(fs.get(path)!) as Record<string, JsonNode>;
  return (root["mcpServers"] as Record<string, JsonNode>)["ai-game-developer"] as Record<string, JsonNode>;
}
