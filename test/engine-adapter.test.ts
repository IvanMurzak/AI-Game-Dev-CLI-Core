import { describe, expect, it } from "vitest";

import {
  unityAdapter,
  unrealAdapter,
  godotAdapter,
  getEngineAdapter,
  engineAdapters,
  ridForPlatform,
  serverExecutableName,
  defaultStdioArgs,
  toAuthServerRoot,
} from "../src/index.js";

describe("engine-adapter contract", () => {
  it("carries the right serverName / stdio flag / client id per engine (§T7)", () => {
    expect(unityAdapter.serverName).toBe("ai-game-developer");
    expect(godotAdapter.serverName).toBe("ai-game-developer");
    expect(unrealAdapter.serverName).toBe("unreal-mcp");

    expect(unityAdapter.stdioSupported).toBe(true);
    expect(unrealAdapter.stdioSupported).toBe(true);
    expect(godotAdapter.stdioSupported).toBe(false); // http-only (M6)

    expect(unityAdapter.clientId).toBe("unity-mcp-cli");
    expect(unrealAdapter.clientId).toBe("unreal-mcp-cli");
    expect(godotAdapter.clientId).toBe("godot-cli");
  });

  it("declares the right project markers per engine", () => {
    expect(unityAdapter.markers).toEqual([{ kind: "file", relativePath: expect.stringContaining("manifest.json") }]);
    expect(godotAdapter.markers).toEqual([{ kind: "file", relativePath: "project.godot" }]);
    expect(unrealAdapter.markers).toEqual([{ kind: "ext", ext: ".uproject" }]);
  });

  it("resolves engine-specific server install-dir layouts", () => {
    // path.resolve makes these absolute (a drive letter is prepended on Windows) — match the tail.
    expect(unityAdapter.serverInstallDir("/proj", "win32", "x64").replace(/\\/g, "/")).toMatch(
      /\/proj\/Library\/mcp-server\/win-x64$/,
    );
    expect(unrealAdapter.serverInstallDir("/proj", "linux", "x64").replace(/\\/g, "/")).toMatch(
      /\/proj\/Intermediate\/UnrealMCP\/server\/linux-x64$/,
    );
    expect(godotAdapter.serverInstallDir("/proj").replace(/\\/g, "/")).toMatch(/\/proj\/\.ai-game-dev\/server$/);
  });

  it("builds engine-specific binary paths with the right exe name", () => {
    expect(unityAdapter.serverBinaryPath("/proj", "win32", "x64").replace(/\\/g, "/")).toMatch(
      /\/proj\/Library\/mcp-server\/win-x64\/gamedev-mcp-server\.exe$/,
    );
    expect(godotAdapter.serverBinaryPath("/proj", "linux").replace(/\\/g, "/")).toMatch(
      /\/proj\/\.ai-game-dev\/server\/gamedev-mcp-server$/,
    );
  });

  it("getEngineAdapter + engineAdapters map is consistent", () => {
    expect(getEngineAdapter("unity")).toBe(unityAdapter);
    expect(getEngineAdapter("unreal")).toBe(unrealAdapter);
    expect(getEngineAdapter("godot")).toBe(godotAdapter);
    expect(Object.keys(engineAdapters).sort()).toEqual(["godot", "unity", "unreal"]);
  });
});

describe("rid + stdio-args helpers", () => {
  it("maps platform/arch to release RIDs", () => {
    expect(ridForPlatform("win32", "x64")).toBe("win-x64");
    expect(ridForPlatform("darwin", "arm64")).toBe("osx-arm64");
    expect(ridForPlatform("darwin", "x64")).toBe("osx-x64");
    expect(ridForPlatform("linux", "x64")).toBe("linux-x64");
  });

  it("names the executable per platform", () => {
    expect(serverExecutableName("win32")).toBe("gamedev-mcp-server.exe");
    expect(serverExecutableName("linux")).toBe("gamedev-mcp-server");
  });

  it("builds the stdio args vector, appending token= only when a token is supplied", () => {
    const noToken = defaultStdioArgs({ port: 23940, timeoutMs: 10000, authorization: "none" });
    expect(noToken).toEqual([
      "port=23940",
      "plugin-timeout=10000",
      "client-transport=stdio",
      "authorization=none",
    ]);
    const withToken = defaultStdioArgs({ port: 23940, timeoutMs: 10000, authorization: "required", token: "T" });
    expect(withToken).toContain("token=T");
  });
});

describe("loginServerTarget / toAuthServerRoot — b2 MED-2 (never record a pinned hub URL)", () => {
  it("reduces a pinned hub URL, a canonical /mcp URL, and a bare host to the SAME AS root", () => {
    expect(unityAdapter.loginServerTarget("https://ai-game.dev/mcp/p/34ea75f2")).toBe("https://ai-game.dev");
    expect(unityAdapter.loginServerTarget("https://ai-game.dev/mcp")).toBe("https://ai-game.dev");
    expect(unityAdapter.loginServerTarget("https://ai-game.dev")).toBe("https://ai-game.dev");
  });

  it("never returns a pinned URL (the whole point of MED-2)", () => {
    for (const raw of [
      "https://ai-game.dev/mcp/p/abcd1234",
      "http://localhost:23940/mcp/p/deadbeef/",
      "https://ai-game.dev/mcp/p/34EA75F2",
    ]) {
      expect(toAuthServerRoot(raw)).not.toMatch(/\/p\/[0-9a-f]{8}/i);
    }
  });

  it("reduces a local pinned URL to the local AS root", () => {
    expect(toAuthServerRoot("http://localhost:23940/mcp/p/deadbeef")).toBe("http://localhost:23940");
  });

  it("leaves an empty input empty", () => {
    expect(toAuthServerRoot("")).toBe("");
  });
});
