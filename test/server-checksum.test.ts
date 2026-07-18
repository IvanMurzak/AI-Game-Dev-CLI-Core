import { describe, expect, it } from "vitest";

import {
  parseSha256Sums,
  lookupDigest,
  verifyDigest,
  verifyZip,
  checksumFailureReason,
  serverDownloadUrl,
  serverChecksumsUrl,
  serverZipAssetName,
} from "../src/index.js";

const DIGEST = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("server-checksum — URL + asset builders", () => {
  it("builds the release URLs for a version + rid", () => {
    expect(serverZipAssetName("win-x64")).toBe("gamedev-mcp-server-win-x64.zip");
    expect(serverDownloadUrl("win-x64", "9.1.0")).toBe(
      "https://github.com/IvanMurzak/GameDev-MCP-Server/releases/download/v9.1.0/gamedev-mcp-server-win-x64.zip",
    );
    expect(serverChecksumsUrl("9.1.0")).toBe(
      "https://github.com/IvanMurzak/GameDev-MCP-Server/releases/download/v9.1.0/SHA256SUMS",
    );
  });
});

describe("server-checksum — parse + verdicts (fail-closed)", () => {
  const manifest = `${DIGEST}  gamedev-mcp-server-win-x64.zip\n${OTHER} *gamedev-mcp-server-linux-x64.zip\n`;

  it("parses coreutils format (two-space + binary-mode marker + CRLF)", () => {
    const map = parseSha256Sums(manifest.replace(/\n/g, "\r\n"));
    expect(map.get("gamedev-mcp-server-win-x64.zip")).toBe(DIGEST);
    expect(map.get("gamedev-mcp-server-linux-x64.zip")).toBe(OTHER);
  });

  it("lookup is exact-key (no cross-RID match)", () => {
    const map = parseSha256Sums(manifest);
    expect(lookupDigest(map, "gamedev-mcp-server-linux-arm64.zip")).toBeNull();
  });

  it("verifyDigest is case-insensitive and fails closed on empty", () => {
    expect(verifyDigest(DIGEST, DIGEST.toUpperCase())).toBe(true);
    expect(verifyDigest(DIGEST, "")).toBe(false);
    expect(verifyDigest("", DIGEST)).toBe(false);
  });

  it("verifyZip returns each fail-closed verdict", () => {
    expect(verifyZip(manifest, "gamedev-mcp-server-win-x64.zip", DIGEST)).toBe("verified");
    expect(verifyZip(manifest, "gamedev-mcp-server-win-x64.zip", OTHER)).toBe("digest-mismatch");
    expect(verifyZip(manifest, "gamedev-mcp-server-osx-x64.zip", DIGEST)).toBe("missing-entry");
    expect(verifyZip("garbage-not-a-manifest", "gamedev-mcp-server-win-x64.zip", DIGEST)).toBe("manifest-unparsable");
    expect(verifyZip(null, "x", DIGEST)).toBe("manifest-unparsable");
  });

  it("failure reasons are actionable", () => {
    expect(checksumFailureReason("digest-mismatch", "z.zip")).toContain("did not match");
    expect(checksumFailureReason("missing-entry", "z.zip")).toContain("no entry");
    expect(checksumFailureReason("manifest-unparsable", "z.zip")).toContain("unparsable");
  });
});
