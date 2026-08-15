import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CREDENTIALS_FILE_NAME,
  CREDENTIALS_LOCK_FILE_NAME,
  MachineCredentialLock,
  MachineCredentialStore,
  commitAgentLogin,
  commitToolsOnlyLogin,
  derivePluginFamily,
  evaluateAccountSwitch,
  identityCredentialCodec,
  revocationUrl,
  revokeTokenBestEffort,
  signOutMachineWide,
  type MachineCredentials,
  type TokenExchangeClient,
  type TokenExchangeRequest,
  type TokenExchangeResult,
} from "../src/index.js";

const createdDirs: string[] = [];

function freshStore(seed?: MachineCredentials): MachineCredentialStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-login-"));
  createdDirs.push(dir);
  const store = new MachineCredentialStore(dir, identityCredentialCodec);
  if (seed) store.write(seed);
  return store;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    fs.rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function scriptedExchange(
  result: TokenExchangeResult | ((request: TokenExchangeRequest) => TokenExchangeResult),
): TokenExchangeClient & { calls: TokenExchangeRequest[] } {
  const calls: TokenExchangeRequest[] = [];
  return {
    calls,
    exchange: async (request) => {
      calls.push(request);
      return typeof result === "function" ? result(request) : result;
    },
  };
}

const AGENT_CREDS: MachineCredentials = {
  accessToken: "agent-a",
  refreshToken: "agent-r",
  expiresAt: "2030-01-01T00:00:00.000Z",
  serverTarget: "https://ai-game.dev",
  subject: "usr_A",
};

const EXCHANGE_OK: TokenExchangeResult = {
  ok: true,
  accessToken: "plug-a",
  refreshToken: "plug-r",
  expiresAt: "2030-01-01T01:00:00.000Z",
  scope: "mcp:plugin",
  sub: "usr_A",
};

describe("evaluateAccountSwitch (D6/F7 guard primitive)", () => {
  it("proceeds on same subject, missing stored subject, or missing new subject (F7.3)", () => {
    expect(evaluateAccountSwitch(null, "usr_A")).toEqual({ kind: "proceed" });
    expect(evaluateAccountSwitch({ subject: "usr_A" }, "usr_A")).toEqual({ kind: "proceed" });
    expect(evaluateAccountSwitch({}, "usr_A")).toEqual({ kind: "proceed" });
    expect(evaluateAccountSwitch({ subject: "usr_A" }, undefined)).toEqual({ kind: "proceed" });
  });

  it("requires confirmation on a genuine subject mismatch", () => {
    expect(evaluateAccountSwitch({ subject: "usr_A" }, "usr_B")).toEqual({
      kind: "confirm-required",
      storedSubject: "usr_A",
      newSubject: "usr_B",
    });
  });
});

describe("commitAgentLogin — the F1/F2 two-lock-hold sequence (04 §4)", () => {
  it("commits agent family (hold 1) → exchanges → commits plugin family + v1 mirror (hold 2)", async () => {
    const store = freshStore();
    const lock = new MachineCredentialLock(store.baseDirectory, { onWarning: () => {} });
    const acquisitions: Array<MachineCredentials | null> = [];
    const originalWithLock = lock.withLock.bind(lock);
    vi.spyOn(lock, "withLock").mockImplementation((fn) =>
      originalWithLock(async () => {
        acquisitions.push(store.read()); // store state AT EACH acquisition
        return (await fn()) as never;
      }),
    );
    let storeAtExchange: MachineCredentials | null = null;
    let lockHeldAtExchange = true;
    const exchange = scriptedExchange(() => {
      storeAtExchange = store.read();
      lockHeldAtExchange = fs.existsSync(path.join(store.baseDirectory, CREDENTIALS_LOCK_FILE_NAME));
      return EXCHANGE_OK;
    });

    const result = await commitAgentLogin({
      store,
      lock,
      exchangeClient: exchange,
      clientId: "unity-mcp-plugin",
      credentials: AGENT_CREDS,
    });

    expect(result.status).toBe("committed");
    // TWO separate lock holds, by design (F1: a failed exchange must leave hold 1's write).
    expect(acquisitions).toHaveLength(2);
    // The agent family was already COMMITTED when the exchange ran — and the lock was RELEASED.
    expect(storeAtExchange!.families?.agent).toMatchObject({
      accessToken: "agent-a",
      refreshToken: "agent-r",
      clientId: "unity-mcp-plugin",
      scope: "mcp:agent",
    });
    expect(lockHeldAtExchange).toBe(false);
    // The exchange presented the agent access token and the surface's own client id.
    expect(exchange.calls[0]).toMatchObject({
      subjectToken: "agent-a",
      clientId: "unity-mcp-plugin",
      serverTarget: "https://ai-game.dev",
    });

    // Final document: both families, subject from `sub`, v1 mirror = the PLUGIN family (04 §1).
    const stored = store.read()!;
    expect(stored.version).toBe(2);
    expect(stored.subject).toBe("usr_A");
    expect(stored.serverTarget).toBe("https://ai-game.dev");
    expect(stored.families?.agent?.scope).toBe("mcp:agent");
    expect(stored.families?.plugin).toMatchObject({
      accessToken: "plug-a",
      refreshToken: "plug-r",
      clientId: "unity-mcp-plugin", // the exchanging client's OWN id (O2/D8)
      scope: "mcp:plugin",
    });
    expect(stored.accessToken).toBe("plug-a"); // v1 compat mirror follows the plugin family
    expect(stored.refreshToken).toBe("plug-r");
  });

  it("failed exchange → status 'partial': the agent family STAYS committed (F1 failure path)", async () => {
    const store = freshStore();
    const result = await commitAgentLogin({
      store,
      exchangeClient: scriptedExchange({ ok: false, reason: "server unavailable" }),
      clientId: "unity-mcp-plugin",
      credentials: AGENT_CREDS,
    });

    expect(result).toMatchObject({ status: "partial", exchangeFailure: "server unavailable" });
    const stored = store.read()!;
    expect(stored.families?.agent?.accessToken).toBe("agent-a"); // committed by hold 1
    expect(stored.families?.plugin).toBeUndefined();
    // No plugin-plane credential exists → no v1 mirror for old readers (an honest absence).
    expect(stored.accessToken).toBeUndefined();
  });

  it("derivePluginFamily alone retries the failed leg (the 'partially authorized, retrying' state)", async () => {
    const store = freshStore();
    await commitAgentLogin({
      store,
      exchangeClient: scriptedExchange({ ok: false, reason: "down" }),
      clientId: "unity-mcp-plugin",
      credentials: AGENT_CREDS,
    });

    const retried = await derivePluginFamily({
      store,
      exchangeClient: scriptedExchange(EXCHANGE_OK),
      clientId: "unity-mcp-plugin",
      agentAccessToken: "agent-a",
      serverTarget: "https://ai-game.dev",
    });
    expect(retried.status).toBe("derived");
    const stored = store.read()!;
    expect(stored.families?.plugin?.accessToken).toBe("plug-a");
    expect(stored.families?.agent?.accessToken).toBe("agent-a"); // untouched
    expect(stored.accessToken).toBe("plug-a"); // mirror now present
  });

  it("preserves an existing plugin/legacy family on a same-subject re-login until the exchange lands", async () => {
    const store = freshStore({
      version: 2,
      subject: "usr_A",
      serverTarget: "https://ai-game.dev",
      families: { plugin: { accessToken: "old-plug", refreshToken: "old-plug-r", clientId: "godot-cli", scope: "mcp:plugin" } },
    });
    const result = await commitAgentLogin({
      store,
      exchangeClient: scriptedExchange({ ok: false, reason: "down" }),
      clientId: "unity-mcp-plugin",
      credentials: AGENT_CREDS,
    });
    expect(result.status).toBe("partial");
    // The pre-existing plugin family (and its mirror) still serves old readers.
    const stored = store.read()!;
    expect(stored.families?.plugin?.accessToken).toBe("old-plug");
    expect(stored.accessToken).toBe("old-plug");
  });
});

describe("commitAgentLogin — the D6/F7 account-switch guard", () => {
  const STORED_B: MachineCredentials = {
    version: 2,
    subject: "usr_B",
    serverTarget: "https://ai-game.dev",
    families: {
      agent: { accessToken: "b-agent-a", refreshToken: "b-agent-r", clientId: "app-dcr", scope: "mcp:agent" },
      plugin: { accessToken: "b-plug-a", refreshToken: "b-plug-r", clientId: "app-dcr", scope: "mcp:plugin" },
    },
  };

  it("mismatch + decline: revokes the JUST-MINTED family, aborts, store byte-identical (F7.2)", async () => {
    const store = freshStore(STORED_B);
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    const before = fs.readFileSync(filePath);
    const revoked: Array<{ token: string; clientId: string; hint: string }> = [];
    const confirm = vi.fn(async () => false);

    const result = await commitAgentLogin({
      store,
      exchangeClient: scriptedExchange(EXCHANGE_OK),
      clientId: "unity-mcp-plugin",
      credentials: AGENT_CREDS, // usr_A minting onto a usr_B machine
      confirmAccountSwitch: confirm,
      revokeToken: (token, clientId, hint) => {
        revoked.push({ token, clientId, hint });
        return true;
      },
    });

    expect(confirm).toHaveBeenCalledWith({ storedSubject: "usr_B", newSubject: "usr_A" });
    expect(result).toEqual({ status: "switch-declined", storedSubject: "usr_B", newSubject: "usr_A" });
    // The just-minted (declined) family was revoked best-effort — no orphan device row.
    expect(revoked).toEqual([{ token: "agent-r", clientId: "unity-mcp-plugin", hint: "refresh_token" }]);
    // F untouched — byte-identical.
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it("mismatch with NO confirm callback declines (fail closed — CLI `--yes`-gated)", async () => {
    const store = freshStore(STORED_B);
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    const before = fs.readFileSync(filePath);

    const result = await commitAgentLogin({
      store,
      exchangeClient: scriptedExchange(EXCHANGE_OK),
      clientId: "unity-mcp-plugin",
      credentials: AGENT_CREDS,
      revokeToken: () => true,
    });
    expect(result.status).toBe("switch-declined");
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it("mismatch + confirm: revokes the OLD account's families and REPLACES the store (D6 single-account)", async () => {
    const store = freshStore(STORED_B);
    const revoked: Array<{ token: string; clientId: string }> = [];

    const result = await commitAgentLogin({
      store,
      exchangeClient: scriptedExchange(EXCHANGE_OK),
      clientId: "unity-mcp-plugin",
      credentials: AGENT_CREDS,
      confirmAccountSwitch: async () => true,
      revokeToken: (token, clientId) => {
        revoked.push({ token, clientId });
        return true;
      },
    });

    expect(result.status).toBe("committed");
    // Old families revoked best-effort with THEIR stored client ids …
    expect(revoked).toEqual(
      expect.arrayContaining([
        { token: "b-agent-r", clientId: "app-dcr" },
        { token: "b-plug-r", clientId: "app-dcr" },
      ]),
    );
    // … and the store now holds ONLY usr_A's families — no usr_B remnant.
    const stored = store.read()!;
    expect(stored.subject).toBe("usr_A");
    expect(stored.families?.agent?.accessToken).toBe("agent-a");
    expect(stored.families?.plugin?.accessToken).toBe("plug-a");
    expect(JSON.stringify(stored)).not.toContain("b-agent");
    expect(JSON.stringify(stored)).not.toContain("b-plug");
  });
});

describe("commitToolsOnlyLogin (O10 --tools-only / F10)", () => {
  it("writes a plugin family ONLY — no agent family, so App pickup is impossible by design", async () => {
    const store = freshStore();
    const result = await commitToolsOnlyLogin({
      store,
      clientId: "godot-cli",
      credentials: {
        accessToken: "ci-plug-a",
        refreshToken: "ci-plug-r",
        expiresAt: "2030-01-01T00:00:00.000Z",
        serverTarget: "https://ai-game.dev",
        subject: "usr_CI",
      },
    });

    expect(result.status).toBe("committed");
    const stored = store.read()!;
    expect(stored.version).toBe(2);
    expect(stored.subject).toBe("usr_CI");
    expect(stored.families?.plugin).toMatchObject({
      accessToken: "ci-plug-a",
      refreshToken: "ci-plug-r",
      clientId: "godot-cli",
      scope: "mcp:plugin",
    });
    expect(stored.families?.agent).toBeUndefined(); // F10: the store holds JUST a plugin family
    expect(stored.accessToken).toBe("ci-plug-a"); // v1 mirror for old readers
  });

  it("applies the same D6 guard: mismatch + decline leaves the store untouched", async () => {
    const store = freshStore({ version: 2, subject: "usr_B", families: { plugin: { accessToken: "b", refreshToken: "br", clientId: "c", scope: "mcp:plugin" } } });
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    const before = fs.readFileSync(filePath);

    const result = await commitToolsOnlyLogin({
      store,
      clientId: "godot-cli",
      credentials: { accessToken: "a", refreshToken: "r", subject: "usr_A", serverTarget: "https://ai-game.dev" },
      revokeToken: () => true,
    });
    expect(result.status).toBe("switch-declined");
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });
});

describe("signOutMachineWide (F6/D5)", () => {
  it("revokes every family's refresh token (stored clientId; legacy → component default) then deletes under lock", async () => {
    const store = freshStore({
      version: 2,
      serverTarget: "https://ai-game.dev",
      families: {
        agent: { accessToken: "aa", refreshToken: "agent-r", clientId: "app-dcr", scope: "mcp:agent" },
        plugin: { accessToken: "pa", refreshToken: "plug-r", clientId: "unity-mcp-plugin", scope: "mcp:plugin" },
        legacy: { accessToken: "la", refreshToken: "legacy-r" }, // clientId unknown by definition
      },
    });
    const revoked: Array<{ token: string; clientId: string; hint: string }> = [];

    const result = await signOutMachineWide({
      store,
      defaultClientId: "unity-mcp-cli",
      revokeToken: (token, clientId, hint) => {
        revoked.push({ token, clientId, hint });
        return true;
      },
    });

    expect(result.deleted).toBe(true);
    expect(revoked).toEqual(
      expect.arrayContaining([
        { token: "agent-r", clientId: "app-dcr", hint: "refresh_token" },
        { token: "plug-r", clientId: "unity-mcp-plugin", hint: "refresh_token" },
        { token: "legacy-r", clientId: "unity-mcp-cli", hint: "refresh_token" }, // F6.2
      ]),
    );
    expect(store.exists).toBe(false);
    // The F6 delete path also released + removed the lock file.
    expect(fs.existsSync(path.join(store.baseDirectory, CREDENTIALS_LOCK_FILE_NAME))).toBe(false);
  });

  it("offline sign-out: failed revokes never block the local delete (F6.4)", async () => {
    const store = freshStore({ accessToken: "a", refreshToken: "r", serverTarget: "https://ai-game.dev" });
    const result = await signOutMachineWide({
      store,
      defaultClientId: "unity-mcp-cli",
      revokeToken: () => {
        throw new Error("offline");
      },
    });
    expect(result.deleted).toBe(true);
    expect(store.exists).toBe(false);
  });

  it("an unreadable store is still deleted on EXPLICIT sign-out (revocation impossible, warned)", async () => {
    const store = freshStore();
    fs.mkdirSync(store.baseDirectory, { recursive: true });
    fs.writeFileSync(path.join(store.baseDirectory, CREDENTIALS_FILE_NAME), "corrupted");
    const warnings: string[] = [];

    const result = await signOutMachineWide({ store, onWarning: (m) => warnings.push(m) });
    expect(result.deleted).toBe(true);
    expect(result.revoked).toEqual([]);
    expect(store.exists).toBe(false);
    expect(warnings.join(" ")).toMatch(/unreadable/);
  });
});

describe("revokeTokenBestEffort (RFC 7009)", () => {
  it("POSTs token + hint + client_id to {AS root}/oauth/revoke and reports 2xx as success", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init!.body) });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await revokeTokenBestEffort({
      serverTarget: "https://ai-game.dev/mcp", // hub URL → normalized
      token: "refresh-1",
      clientId: "unity-mcp-plugin",
      fetchImpl,
    });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe(revocationUrl("https://ai-game.dev"));
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("token")).toBe("refresh-1");
    expect(form.get("token_type_hint")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("unity-mcp-plugin");
  });

  it("never throws: network failure and missing inputs report false", async () => {
    expect(
      await revokeTokenBestEffort({
        serverTarget: "https://ai-game.dev",
        token: "t",
        clientId: "c",
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      }),
    ).toBe(false);
    expect(await revokeTokenBestEffort({ serverTarget: "", token: "t", clientId: "c" })).toBe(false);
    expect(await revokeTokenBestEffort({ serverTarget: "https://x", token: "", clientId: "c" })).toBe(false);
  });
});
