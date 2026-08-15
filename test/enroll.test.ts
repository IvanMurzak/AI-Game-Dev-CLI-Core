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

  it("prefers `sub` over the legacy `subject` alias and consumes `client_id` (O5/a6, defensively)", () => {
    // a6 lands in parallel: both spellings must stay readable, with the contract field preferred.
    const both = normalizeRedeemResponse({ access_token: "a", sub: "usr_contract", subject: "usr_legacy" });
    expect(both.subject).toBe("usr_contract");

    const legacyOnly = normalizeRedeemResponse({ access_token: "a", subject: "usr_legacy" });
    expect(legacyOnly.subject).toBe("usr_legacy");

    const withClient = normalizeRedeemResponse({ access_token: "a", client_id: "unity-mcp-plugin" });
    expect(withClient.clientId).toBe("unity-mcp-plugin");

    // Pre-a6 server: no sub, no client_id — both stay undefined (never inferred).
    const preA6 = normalizeRedeemResponse({ access_token: "a" });
    expect(preA6.subject).toBeUndefined();
    expect(preA6.clientId).toBeUndefined();
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

  it("persists a v2 PLUGIN family (+ v1 mirror) with the response's client_id and scope=mcp:plugin (F10)", async () => {
    const store = new MachineCredentialStore(path.join(tmp, "store"), identityCredentialCodec);
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({
        access_token: "a.b.c",
        refresh_token: "r",
        expires_in: 3600,
        server_target: "https://ai-game.dev",
        client_id: "unity-mcp-plugin",
        sub: "usr_1",
      }),
      now: FIXED_NOW,
    });

    const stored = store.read()!;
    expect(stored.version).toBe(2);
    expect(stored.subject).toBe("usr_1"); // written from `sub`
    expect(stored.families?.plugin).toMatchObject({
      accessToken: "a.b.c",
      refreshToken: "r",
      clientId: "unity-mcp-plugin", // from the redeem response — never inferred
      scope: "mcp:plugin",
    });
    expect(stored.families?.agent).toBeUndefined(); // tools-only shape: plugin family ONLY
    expect(stored.accessToken).toBe("a.b.c"); // v1 compat mirror for old readers
  });

  it("writes NO subject key and NO clientId when a pre-a6 server omits them (enroll.ts:259 fix)", async () => {
    const store = new MachineCredentialStore(path.join(tmp, "store"), identityCredentialCodec);
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({ access_token: "a", refresh_token: "r", server_target: "https://ai-game.dev" }),
    });

    const raw = fs.readFileSync(store.credentialsPath, "utf-8");
    expect(raw).not.toContain('"subject"'); // the key is OMITTED, not written as undefined/null
    const stored = store.read()!;
    expect(stored.families?.plugin?.clientId).toBeUndefined(); // never inferred (04 §1)
    expect(stored.families?.plugin?.scope).toBe("mcp:plugin"); // plugin-plane by definition
  });

  it("preserves an existing agent family — enroll merges the plugin family, never clobbers the store", async () => {
    const store = new MachineCredentialStore(path.join(tmp, "store"), identityCredentialCodec);
    store.write({
      version: 2,
      subject: "usr_1",
      serverTarget: "https://ai-game.dev",
      families: { agent: { accessToken: "agent-a", refreshToken: "agent-r", clientId: "app-dcr", scope: "mcp:agent" } },
    });
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({ access_token: "plug-a", refresh_token: "plug-r", server_target: "https://ai-game.dev", sub: "usr_1" }),
    });

    const stored = store.read()!;
    expect(stored.families?.agent).toMatchObject({ accessToken: "agent-a", refreshToken: "agent-r" });
    expect(stored.families?.plugin?.accessToken).toBe("plug-a");
  });

  it("may replace an UNREADABLE store — enrolling is an explicit re-authorization (04 §1, A2 semantic)", async () => {
    const storeDir = path.join(tmp, "store");
    fs.mkdirSync(storeDir, { recursive: true });
    const store = new MachineCredentialStore(storeDir, identityCredentialCodec);
    fs.writeFileSync(store.credentialsPath, "corrupted / undecryptable blob");
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });

    await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({ access_token: "fresh", refresh_token: "r", server_target: "https://ai-game.dev" }),
    });

    expect(store.read()?.families?.plugin?.accessToken).toBe("fresh");
  });

  it("B1: post-a6 redeem for account B on a machine authorized as A → declined (fail closed), store untouched, minted revoked", async () => {
    const store = new MachineCredentialStore(path.join(tmp, "store"), identityCredentialCodec);
    store.write({
      version: 2,
      subject: "usr_A",
      serverTarget: "https://ai-game.dev",
      families: { agent: { accessToken: "a-agent", refreshToken: "a-agent-r", clientId: "app-dcr", scope: "mcp:agent" } },
    });
    const before = fs.readFileSync(store.credentialsPath);
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const revoked: Array<{ token: string; clientId: string }> = [];

    const res = await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({
        access_token: "b-plug-a",
        refresh_token: "b-plug-r",
        server_target: "https://ai-game.dev",
        sub: "usr_B",
        client_id: "unity-mcp-plugin",
      }),
      revokeToken: (token, clientId) => {
        revoked.push({ token, clientId });
        return true;
      },
    });

    expect(res).toMatchObject({ status: "switch-declined", storedSubject: "usr_A", newSubject: "usr_B" });
    // F untouched — byte-identical; no mixed-account store, subject still usr_A.
    expect(fs.readFileSync(store.credentialsPath).equals(before)).toBe(true);
    // The just-minted (declined) enrollment family was revoked best-effort with ITS client id.
    expect(revoked).toEqual([{ token: "b-plug-r", clientId: "unity-mcp-plugin" }]);
    // No project side effects either: the enrollment was aborted before the marker/pin writes.
    expect(readProjectMarker(projectDir)).toBeNull();
  });

  it("B1: confirmed switch REPLACES the store (same semantics as login) — no A remnant, old families revoked", async () => {
    const store = new MachineCredentialStore(path.join(tmp, "store"), identityCredentialCodec);
    store.write({
      version: 2,
      subject: "usr_A",
      serverTarget: "https://ai-game.dev",
      families: { agent: { accessToken: "a-agent", refreshToken: "a-agent-r", clientId: "app-dcr", scope: "mcp:agent" } },
    });
    const projectDir = path.join(tmp, "project");
    fs.mkdirSync(projectDir, { recursive: true });
    const revoked: Array<{ token: string; clientId: string }> = [];

    const res = await runEnroll({
      code: "CODE",
      projectPath: projectDir,
      adapter: unityAdapter,
      store,
      baseUrl: "https://ai-game.dev",
      fetchImpl: redeemFetch({
        access_token: "b-plug-a",
        refresh_token: "b-plug-r",
        server_target: "https://ai-game.dev",
        sub: "usr_B",
        client_id: "unity-mcp-plugin",
      }),
      confirmAccountSwitch: async () => true,
      revokeToken: (token, clientId) => {
        revoked.push({ token, clientId });
        return true;
      },
    });

    expect(res).toMatchObject({ status: "enrolled" });
    // Old account's families were revoked best-effort with their stored client id …
    expect(revoked).toEqual([{ token: "a-agent-r", clientId: "app-dcr" }]);
    // … and the store was REPLACED: only usr_B's plugin family remains (D6 single-account).
    const stored = store.read()!;
    expect(stored.subject).toBe("usr_B");
    expect(stored.families?.plugin?.accessToken).toBe("b-plug-a");
    expect(stored.families?.agent).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain("a-agent");
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
