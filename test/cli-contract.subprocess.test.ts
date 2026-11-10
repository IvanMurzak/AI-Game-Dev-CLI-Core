import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureDistBuilt, fixtures } from "./dist-build.js";

/** Real processes: the envelope must reach a pipe whole, once, even when the command exits at once. */

beforeAll(ensureDistBuilt, 180_000);

function run(scenario: string, format: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, [path.join(fixtures, "contract-runner.mjs"), scenario, format], {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe("the envelope safety net", () => {
  it("a json command that exits without an envelope still leaves one, and console.log goes to stderr", () => {
    const r = run("exit-without-envelope", "json");
    expect(r.status).toBe(6);
    expect(JSON.parse(r.stdout)).toEqual({
      success: false,
      command: "demo",
      data: null,
      errors: [{ code: "COMMAND_FAILED", message: "The command failed before it produced a result; see stderr for details." }],
      warnings: [],
    });
    expect(r.stderr).toContain("a log line that must not reach stdout");
  });

  it("text mode gets no envelope", () => {
    const r = run("exit-without-envelope", "text");
    expect(r.status).toBe(6);
    expect(r.stdout).toContain("a log line that must not reach stdout");
    expect(r.stdout).not.toContain("success");
  });

  it("the recorded errors ride the safety-net envelope", () => {
    const r = run("recorded-then-exit", "ndjson");
    expect(r.status).toBe(6);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(r.stdout).errors).toEqual([{ code: "NOT_AUTHENTICATED", message: "sign in" }]);
  });
});

describe("the synchronous, once-per-process envelope", () => {
  it("a 1 MB envelope followed by process.exit reaches the pipe whole, and only the first emit is written", () => {
    const r = run("emit-then-exit", "json");
    expect(r.status).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.data.big).toHaveLength(1_000_000);
    expect(envelope.warnings).toEqual(["w"]);
  });

  it("exitAfterFlush exits with its code after the envelope", () => {
    const r = run("exit-after-flush", "ndjson");
    expect(r.status).toBe(14);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, errors: [{ code: "TIMEOUT", message: "too slow" }] });
  });
});
