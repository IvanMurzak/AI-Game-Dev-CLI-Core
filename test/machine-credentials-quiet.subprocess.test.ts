import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { CREDENTIALS_FILE_NAME, MACHINE_STORE_DIR_NAME, STORED_SIGN_IN_UNREADABLE_REASON } from "../src/machine-credentials.js";
import { ensureDistBuilt, fixtures } from "./dist-build.js";

/**
 * A corrupted `credentials.json` in a real HOME / USERPROFILE, read by a real process with the
 * platform codec (real DPAPI on Windows): the store reports one clear reason, and nothing of the
 * codec (PowerShell's exception text) reaches the process's own stderr.
 */

beforeAll(ensureDistBuilt, 180_000);

let home: string | undefined;
afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function readStoreIn(content: Buffer | string): { status: number | null; stderr: string; result: Record<string, string> } {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-core-quiet-home-"));
  fs.mkdirSync(path.join(home, MACHINE_STORE_DIR_NAME));
  fs.writeFileSync(path.join(home, MACHINE_STORE_DIR_NAME, CREDENTIALS_FILE_NAME), content);
  const r = spawnSync(process.execPath, [path.join(fixtures, "read-store.mjs")], {
    encoding: "utf-8",
    timeout: 90_000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  return { status: r.status, stderr: r.stderr, result: JSON.parse(r.stdout.trim()) };
}

describe("an unreadable credentials.json is quiet", () => {
  it("corrupted text: one clear reason, empty stderr", { timeout: 120_000 }, () => {
    const { status, stderr, result } = readStoreIn("this-is-not-a-dpapi-blob");
    expect(status).toBe(0);
    expect(result.path.startsWith(home!)).toBe(true);
    expect(result.status).toBe("unreadable");
    expect(result.reason).toBe(STORED_SIGN_IN_UNREADABLE_REASON);
    expect(result.readError).toBe(`machine credential store unreadable: ${STORED_SIGN_IN_UNREADABLE_REASON}`);
    expect(stderr).toBe("");
  });

  it("binary garbage: the same", { timeout: 120_000 }, () => {
    const { stderr, result } = readStoreIn(Buffer.from([0x00, 0x01, 0xfe, 0xba, 0xad, 0xf0, 0x0d, 0x42]));
    expect(result.reason).toBe(STORED_SIGN_IN_UNREADABLE_REASON);
    expect(result.reason).not.toMatch(/PowerShell|Exception|CategoryInfo/);
    expect(stderr).toBe("");
  });
});
