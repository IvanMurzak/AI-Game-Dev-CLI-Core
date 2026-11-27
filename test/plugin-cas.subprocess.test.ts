import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MachineCredentialStore, derivePluginFamily, type TokenExchangeResult } from "../src/index.js";
import { fixtures } from "./dist-build.js";

/**
 * DEV-277: the conditional plugin write (`expectedPluginRefreshToken`) against a REAL second
 * process. While the re-derivation's exchange runs, an engine CLI (a plain `node` child running
 * the built library) takes the store lock and commits a fresh plugin sign-in. The re-derivation's
 * write hold waits for that lock, re-reads, and refuses: the fresh sign-in survives.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const EXCHANGE_OK: TokenExchangeResult = {
  ok: true,
  accessToken: "healed-a",
  refreshToken: "healed-r",
  scope: "mcp:plugin",
  sub: "usr_A",
};

describe("derivePluginFamily conditional write — a concurrent writer in a second process", () => {
  it("a fresh plugin sign-in committed by another process during the exchange is never overwritten", { timeout: 120_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-plugin-cas-"));
    dirs.push(dir);
    const store = new MachineCredentialStore(dir); // the platform codec, as the child uses
    store.write({
      version: 2,
      subject: "usr_A",
      serverTarget: "https://ai-game.dev",
      families: {
        agent: { accessToken: "agent-a", refreshToken: "agent-r", clientId: "app", scope: "mcp:agent" },
        plugin: { accessToken: "dead-a", refreshToken: "dead-r", clientId: "app", scope: "mcp:plugin" },
      },
    });

    const readyFile = path.join(dir, "writer.ready");
    let childExit: Promise<number | null> | undefined;
    const revoked: string[] = [];
    const result = await derivePluginFamily({
      store,
      exchangeClient: {
        exchange: async () => {
          // Mid-exchange: the other tool starts, takes the lock and holds it while it commits.
          const child = spawn(process.execPath, [path.join(fixtures, "plugin-writer.mjs"), dir, "fresh-r", readyFile, "1500"], {
            stdio: ["ignore", "ignore", "inherit"],
          });
          childExit = new Promise((resolve) => child.on("exit", resolve));
          const deadline = Date.now() + 60_000;
          while (!fs.existsSync(readyFile)) {
            if (Date.now() > deadline) throw new Error("writer never took the lock");
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return EXCHANGE_OK; // returned while the child still holds the lock
        },
      },
      clientId: "app",
      agentAccessToken: "agent-a",
      expectedSubject: "usr_A",
      serverTarget: "https://ai-game.dev",
      expectedPluginRefreshToken: "dead-r",
      revokeToken: (token) => {
        revoked.push(token);
        return true;
      },
      onWarning: () => {},
    });

    expect(await childExit).toBe(0);
    expect(result).toMatchObject({ status: "aborted", reason: "plugin-changed" });
    expect(store.read()?.families?.plugin?.refreshToken).toBe("fresh-r"); // the other tool's sign-in survives
    expect(revoked).toEqual(["healed-r"]); // the orphaned re-derived family is revoked
  });
});
