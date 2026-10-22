import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEAD_FAMILY_MEMO_FILE_NAME, PersistedDeadFamilyMemo, hashRefreshToken, isClientIdMismatchText } from "../src/index.js";

/**
 * Cross-language parity with the C# `PersistedDeadFamilyMemo` (MCP-Plugin-dotnet), gated by the golden
 * vector authored there and vendored byte-identical (`McpPlugin/src/AgentConfig/DeadFamilyMemo.GoldenVectors.json`).
 * Writes compare the sidecar BYTES; reads go through `match` plus the provider's client-id-mismatch
 * filter, exactly as `MachineCredentialProvider` consults the sidecar.
 */
const golden = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "golden-vectors", "DeadFamilyMemo.GoldenVectors.json"), "utf-8"),
) as {
  writes: Array<{
    name: string;
    refreshToken: string;
    reason: string;
    declaredDeadAtMs: number;
    refreshTokenSha256: string;
    expectedFile: string;
  }>;
  reads: Array<{ name: string; file: string; refreshToken: string; expected: "dead" | "none"; expectedReason?: string }>;
};

const dirs: string[] = [];
function memoDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-dfm-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The provider's read path: a recorded client-id mismatch is never a dead verdict. */
function verdict(memo: PersistedDeadFamilyMemo, refreshToken: string): { reason: string } | undefined {
  const match = memo.match(refreshToken);
  return match !== undefined && !isClientIdMismatchText(match.reason) ? match : undefined;
}

describe("dead-family memo golden vectors (C# ⇄ TS parity)", () => {
  it.each(golden.writes)("write $name produces the exact sidecar bytes", (c) => {
    expect(hashRefreshToken(c.refreshToken)).toBe(c.refreshTokenSha256);
    const memo = new PersistedDeadFamilyMemo(memoDir());
    memo.write(c.refreshToken, c.reason, c.declaredDeadAtMs);
    expect(path.basename(memo.filePath)).toBe(DEAD_FAMILY_MEMO_FILE_NAME);
    expect(fs.readFileSync(memo.filePath).equals(Buffer.from(c.expectedFile, "utf-8"))).toBe(true);
  });

  it.each(golden.reads)("read $name yields $expected", (c) => {
    const dir = memoDir();
    fs.writeFileSync(path.join(dir, DEAD_FAMILY_MEMO_FILE_NAME), c.file, "utf-8");
    const result = verdict(new PersistedDeadFamilyMemo(dir), c.refreshToken);
    if (c.expected === "dead") expect(result).toEqual({ reason: c.expectedReason });
    else expect(result).toBeUndefined();
  });
});
