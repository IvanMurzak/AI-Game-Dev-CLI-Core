import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runEnroll,
  redeemEnrollmentCode,
  normalizeRedeemResponse,
  resolveEnrollCode,
  upsertProjectPinIntoConfigs,
  EnrollmentError,
  MachineCredentialStore,
  identityCredentialCodec,
  readProjectMarker,
  derivePinV2,
  unityAdapter,
} from "../src/index.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-enroll-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FIXED_NOW = () => Date.parse("2026-07-18T00:00:00Z");

function redeemFetch(body: Record<string, unknown>, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("enroll — redeem response normalization", () => {
  it("accepts snake_case and camelCase, and converts expires_in → expiresAt", () => {
    const snake = normalizeRedeemResponse(
      { access_token: "a", refresh_token: "r", expires_in: 3600, server_target: "https://ai-game.dev", sub: "u1" },
      FIXED_NOW,
    );
    expect(snake).toMatchObject({ accessToken: "a", refreshToken: "r", serverTarget: "https://ai-game.dev", subject: "u1" });
    expect(snake.expiresAt).toBe(new Date(FIXED_NOW() + 3600_000).toISOString());

    const camel = normalizeRedeemResponse({ accessToken: "a", serverUrl: "https://x", expiresAt: "2030-01-01T00:00:00Z" });
    expect(camel.serverTarget).toBe("https://x");
    expect(camel.expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  it("surfaces a non-2xx as an actionable EnrollmentError", async () => {
    await expect(
      redeemEnrollmentCode("BADCODE", { baseUrl: "https://ai-game.dev", fetchImpl: redeemFetch({}, 400) }),
    ).rejects.toBeInstanceOf(EnrollmentError);
  });

  it("rejects a response with no access token", async () => {
    await expect(
      redeemEnrollmentCode("C", { baseUrl: "https://ai-game.dev", fetchImpl: redeemFetch({ refresh_token: "r" }) }),
    ).rejects.toThrow(/access token/);
  });
});

describe("enroll — resolveEnrollCode", () => {
  it("reads --enroll, --enroll-stdin, enforces mutual exclusion, and requires one", () => {
    expect(resolveEnrollCode({ enroll: "CODE" }, () => "")).toBe("CODE");
    expect(resolveEnrollCode({ enrollStdin: true }, () => " STDIN \n")).toBe("STDIN");
    expect(() => resolveEnrollCode({ enroll: "A", enrollStdin: true }, () => "")).toThrow(/not both/);
    expect(() => resolveEnrollCode({}, () => "")).toThrow(/required/);
  });
});

describe("enroll — runEnroll side effects (v2 pin + MED-2 serverTarget)", () => {
  it("records the AS-ROOT serverTarget even when the server returns a PINNED hub URL (MED-2)", async () => {
    const store = new MachineCredentialStore(path.join(tmp, "store"), identityCredentialCodec);
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    const res = await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({
        access_token: "a.b.c",
        refresh_token: "r",
        expires_in: 3600,
        server_target: "https://ai-game.dev/mcp/p/deadbeef", // a PINNED URL — must NOT be recorded verbatim
      }),
      now: FIXED_NOW,
    });

    expect(res.serverTarget).toBe("https://ai-game.dev"); // reduced to the AS root
    expect(store.read()?.serverTarget).toBe("https://ai-game.dev");
    expect(store.read()?.serverTarget).not.toMatch(/\/p\//);
    expect(readProjectMarker(projectDir)?.serverTarget).toBe("https://ai-game.dev");
  });

  it("derives the pin with v2 normalization (B5 fix — no per-CLI workaround)", async () => {
    const store = new MachineCredentialStore(path.join(tmp, "store"), identityCredentialCodec);
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    const res = await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({ access_token: "a", refresh_token: "r", server_target: "https://ai-game.dev" }),
    });
    expect(res.pin).toBe(derivePinV2(path.resolve(projectDir)));
  });
});

describe("enroll — upsertProjectPinIntoConfigs", () => {
  it("pins a project-local JSON config's server URL, leaving user-global configs untouched", () => {
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const mcp = path.join(projectDir, ".mcp.json");
    fs.writeFileSync(
      mcp,
      JSON.stringify({ mcpServers: { "ai-game-developer": { type: "http", url: "https://ai-game.dev/mcp" } } }),
    );

    const { updatedFiles } = upsertProjectPinIntoConfigs(projectDir, "34ea75f2", "ai-game-developer");
    expect(updatedFiles).toContain(mcp);
    const written = JSON.parse(fs.readFileSync(mcp, "utf-8"));
    expect(written.mcpServers["ai-game-developer"].url).toBe("https://ai-game.dev/mcp/p/34ea75f2");
  });

  it("is idempotent (re-pinning the same pin makes no change)", () => {
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const mcp = path.join(projectDir, ".mcp.json");
    fs.writeFileSync(
      mcp,
      JSON.stringify({ mcpServers: { "ai-game-developer": { url: "https://ai-game.dev/mcp/p/34ea75f2" } } }),
    );
    expect(upsertProjectPinIntoConfigs(projectDir, "34ea75f2", "ai-game-developer").updatedFiles).toEqual([]);
  });
});
