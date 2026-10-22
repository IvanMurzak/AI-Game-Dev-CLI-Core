import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEAD_FAMILY_MEMO_FILE_NAME,
  FIRST_PARTY_REFRESH_CLIENT_IDS,
  LoginRequiredError,
  MachineCredentialLock,
  MachineCredentialProvider,
  MachineCredentialStore,
  TRANSIENT_REFRESH_COOLDOWN_MS,
  hashRefreshToken,
  identityCredentialCodec,
  type CredentialTelemetryEvent,
  type MachineCredentials,
  type TokenRefreshRequest,
  type TokenRefreshResult,
  type TokenRefresher,
} from "../src/index.js";

// Production regressions covered here (AI-Game-Dev-Server logs, 2026-10-21):
//  - `invalid_grant: client_id does not match the refresh token` for unity-mcp-cli / godot-cli —
//    a store collapsed to pure v1 by an old engine plugin (or an enroll credential from a server
//    that predates `client_id` in the redeem response) reads as a family with NO clientId, which
//    the CLI refreshed with its OWN id while the token was minted under the plugin's.
//  - the same dead token re-presented on every CLI process start (in-memory-only dead memo).
//  - a transient failure held back for the whole 60 s skew window, so the retry of a token whose
//    rotation response was lost landed after the server's grace window ⇒ "reuse detected".

const createdDirs: string[] = [];

afterEach(() => {
  while (createdDirs.length > 0) {
    fs.rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

function freshStore(seed?: MachineCredentials): MachineCredentialStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-robust-"));
  createdDirs.push(dir);
  const store = new MachineCredentialStore(dir, identityCredentialCodec);
  if (seed) store.write(seed);
  return store;
}

function scriptedRefresher(
  respond: (request: TokenRefreshRequest, callIndex: number) => TokenRefreshResult,
): TokenRefresher & { calls: TokenRefreshRequest[] } {
  const calls: TokenRefreshRequest[] = [];
  return {
    calls,
    refresh: async (request) => {
      calls.push(request);
      return respond(request, calls.length - 1);
    },
  };
}

const NOW = 1_700_000_000_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function provider(
  store: MachineCredentialStore,
  refresher: TokenRefresher,
  extra: ConstructorParameters<typeof MachineCredentialProvider>[2] = {},
): MachineCredentialProvider {
  return new MachineCredentialProvider(store, refresher, {
    clock: () => NOW,
    lock: new MachineCredentialLock(store.baseDirectory, { acquireBudgetMs: 300, maxBackoffMs: 25, onWarning: () => {} }),
    defaultClientId: "unity-mcp-cli",
    transientRetryDelayMs: 0,
    ...extra,
  });
}

const MISMATCH: TokenRefreshResult = {
  ok: false,
  reason: "invalid_grant",
  description: "client_id does not match the refresh token",
};
const EXPIRED: TokenRefreshResult = { ok: false, reason: "invalid_grant", description: "refresh token has expired" };
const ROTATED: TokenRefreshResult = { ok: true, accessToken: "fresh-a", refreshToken: "fresh-r", expiresAt: iso(3_600_000) };

/** The pure-v1 shape an old engine plugin's Rotate() leaves behind (families dropped). */
const collapsedV1 = (): MachineCredentials => ({
  accessToken: "old-a",
  refreshToken: "old-r",
  expiresAt: iso(-1_000),
  serverTarget: "https://ai-game.dev",
});

const memoPath = (store: MachineCredentialStore) => path.join(store.baseDirectory, DEAD_FAMILY_MEMO_FILE_NAME);

describe("client-id fallback for a family that stores no clientId (rule 7)", () => {
  it("a collapsed v1 store minted under the sibling plugin refreshes on the 2nd presentation and records the id", async () => {
    const store = freshStore(collapsedV1());
    const refresher = scriptedRefresher((r) => (r.clientId === "unity-mcp-plugin" ? ROTATED : MISMATCH));

    expect(await provider(store, refresher).getAccessToken()).toBe("fresh-a");

    // Own default first, then the sibling plugin — and the SAME refresh token both times (the
    // server writes nothing on a client-id mismatch, so the token is still live).
    expect(refresher.calls.map((c) => [c.clientId, c.refreshToken])).toEqual([
      ["unity-mcp-cli", "old-r"],
      ["unity-mcp-plugin", "old-r"],
    ]);
    const legacy = store.read()?.families?.legacy;
    expect(legacy).toMatchObject({ accessToken: "fresh-a", refreshToken: "fresh-r", clientId: "unity-mcp-plugin" });
    expect(fs.existsSync(memoPath(store))).toBe(false);

    // The next process presents the recorded mint client directly — one request, no probing.
    store.writeFamily("legacy", { ...legacy!, expiresAt: iso(-1_000) });
    const next = scriptedRefresher((r) => (r.clientId === "unity-mcp-plugin" ? { ...ROTATED, accessToken: "a2" } : MISMATCH));
    expect(await provider(store, next).getAccessToken()).toBe("a2");
    expect(next.calls.map((c) => c.clientId)).toEqual(["unity-mcp-plugin"]);
  });

  it("an enroll-minted plugin family without a stored clientId falls back to agd_enroll", async () => {
    const store = freshStore({
      version: 2,
      serverTarget: "https://ai-game.dev",
      families: { plugin: { accessToken: "a", refreshToken: "r", expiresAt: iso(-1_000) } },
    });
    const refresher = scriptedRefresher((r) => (r.clientId === "agd_enroll" ? ROTATED : MISMATCH));

    expect(await provider(store, refresher).getAccessToken()).toBe("fresh-a");
    // Own default, the sibling plugin, then the enroll redeem's synthetic id.
    expect(refresher.calls.map((c) => c.clientId)).toEqual(["unity-mcp-cli", "unity-mcp-plugin", "agd_enroll"]);
    expect(store.read()?.families?.plugin?.clientId).toBe("agd_enroll");
  });

  it("NEVER re-presents a family with a STORED clientId under another id (rule 2)", async () => {
    const store = freshStore({
      version: 2,
      families: { plugin: { accessToken: "a", refreshToken: "r", expiresAt: iso(-1_000), clientId: "unity-mcp-plugin" } },
    });
    const refresher = scriptedRefresher(() => MISMATCH);

    await expect(provider(store, refresher).getAccessToken({ family: "hub" })).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls.map((c) => c.clientId)).toEqual(["unity-mcp-plugin"]);
  });

  it("stops probing at the first non-mismatch answer and reports THAT verdict", async () => {
    const store = freshStore(collapsedV1());
    const events: CredentialTelemetryEvent[] = [];
    const refresher = scriptedRefresher((r) => (r.clientId === "unity-mcp-plugin" ? EXPIRED : MISMATCH));

    await expect(provider(store, refresher, { onTelemetry: (e) => events.push(e) }).getAccessToken()).rejects.toThrow(
      /no longer valid \(invalid_grant: refresh token has expired\); sign in again/,
    );
    expect(refresher.calls.map((c) => c.clientId)).toEqual(["unity-mcp-cli", "unity-mcp-plugin"]);
    expect(events).toEqual([
      { type: "family-dead", family: "legacy", reason: "invalid_grant", description: "refresh token has expired" },
    ]);
  });

  it("all candidates mismatching is a sign-in-required for THIS process only — never persisted", async () => {
    const store = freshStore(collapsedV1());
    const refresher = scriptedRefresher(() => MISMATCH);
    const p = provider(store, refresher);

    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls).toHaveLength(FIRST_PARTY_REFRESH_CLIENT_IDS.length); // the default + every other first-party id
    expect(new Set(refresher.calls.map((c) => c.clientId)).size).toBe(refresher.calls.length);
    // The token is alive for its (unknown) mint client: no sidecar verdict that would silence it.
    expect(fs.existsSync(memoPath(store))).toBe(false);
    // ...and this process does not loop either.
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls).toHaveLength(FIRST_PARTY_REFRESH_CLIENT_IDS.length);
  });

  it("fallbackClientIds: [] restores the single-presentation behaviour", async () => {
    const store = freshStore(collapsedV1());
    const refresher = scriptedRefresher(() => MISMATCH);
    await expect(provider(store, refresher, { fallbackClientIds: [] }).getAccessToken()).rejects.toBeInstanceOf(
      LoginRequiredError,
    );
    expect(refresher.calls).toHaveLength(1);
  });
});

describe("persisted dead-family memo (rule 5 across processes; shared with MCP-Plugin-dotnet)", () => {
  it("a dead verdict is persisted hash-only and stops the NEXT process from re-presenting the token", async () => {
    const store = freshStore(collapsedV1());
    const first = scriptedRefresher(() => EXPIRED);
    await expect(provider(store, first, { fallbackClientIds: [] }).getAccessToken()).rejects.toBeInstanceOf(
      LoginRequiredError,
    );

    const raw = fs.readFileSync(memoPath(store), "utf-8");
    expect(raw).not.toContain("old-r");
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      refreshTokenSha256: hashRefreshToken("old-r"),
      reason: "invalid_grant: refresh token has expired",
      declaredDeadAt: new Date(NOW).toISOString(),
    });

    // A new CLI process: no network call, no second telemetry event, a clear sign-in message.
    const events: CredentialTelemetryEvent[] = [];
    const second = scriptedRefresher(() => ROTATED);
    await expect(
      provider(store, second, { onTelemetry: (e) => events.push(e) }).getAccessToken(),
    ).rejects.toThrow(/refresh token has expired.*sign in again/);
    expect(second.calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("a fresh sign-in (a different refresh token) re-arms refresh despite the sidecar", async () => {
    const store = freshStore(collapsedV1());
    fs.writeFileSync(
      memoPath(store),
      JSON.stringify({ version: 1, refreshTokenSha256: hashRefreshToken("some-older-token"), reason: "invalid_grant" }),
    );
    const refresher = scriptedRefresher(() => ROTATED);
    expect(await provider(store, refresher).getAccessToken()).toBe("fresh-a");
    expect(refresher.calls).toHaveLength(1);
  });

  it("ignores a sidecar verdict that was only a client-id mismatch (alive for its mint client)", async () => {
    const store = freshStore(collapsedV1());
    fs.writeFileSync(
      memoPath(store),
      JSON.stringify({
        version: 1,
        refreshTokenSha256: hashRefreshToken("old-r"),
        reason: "invalid_grant: client_id does not match the refresh token",
      }),
    );
    const refresher = scriptedRefresher(() => ROTATED);
    expect(await provider(store, refresher).getAccessToken()).toBe("fresh-a");
  });

  it("persistDeadFamilyMemo: false keeps the verdict in memory only", async () => {
    const store = freshStore(collapsedV1());
    await expect(
      provider(store, scriptedRefresher(() => EXPIRED), { persistDeadFamilyMemo: false }).getAccessToken(),
    ).rejects.toBeInstanceOf(LoginRequiredError);
    expect(fs.existsSync(memoPath(store))).toBe(false);
  });
});

describe("transient refresh failures (rule 6: retry inside the server grace window)", () => {
  const NETWORK: TokenRefreshResult = { ok: false, reason: "fetch failed (ECONNRESET)", transient: true };

  it("retries a transient failure once, promptly, presenting the SAME refresh token", async () => {
    const store = freshStore(collapsedV1());
    const refresher = scriptedRefresher((_r, i) => (i === 0 ? NETWORK : ROTATED));

    expect(await provider(store, refresher).getAccessToken()).toBe("fresh-a");
    expect(refresher.calls.map((c) => c.refreshToken)).toEqual(["old-r", "old-r"]);
  });

  it("the in-call retry adopts a peer's rotation instead of re-presenting the old token", async () => {
    const store = freshStore(collapsedV1());
    const refresher = scriptedRefresher(() => {
      // While "our response was lost", a peer rotated and persisted.
      store.writeFamily("legacy", { accessToken: "peer-a", refreshToken: "peer-r", expiresAt: iso(3_600_000) });
      return NETWORK;
    });

    expect(await provider(store, refresher).getAccessToken()).toBe("peer-a");
    expect(refresher.calls).toHaveLength(1);
  });

  it("holds a transiently-failing family back only for the short cooldown, not the 60 s skew window", async () => {
    let now = NOW;
    const store = freshStore(collapsedV1());
    const refresher = scriptedRefresher(() => NETWORK);
    const p = provider(store, refresher, { clock: () => now });

    // Expired token + transient failure: retry-shortly, NOT a dead-family verdict.
    await expect(p.getAccessToken()).rejects.toThrow(/failed temporarily .*retry shortly/);
    expect(refresher.calls).toHaveLength(2); // the attempt + its one prompt retry
    expect(fs.existsSync(memoPath(store))).toBe(false);

    now += TRANSIENT_REFRESH_COOLDOWN_MS - 1;
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls).toHaveLength(2);

    now += 1;
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls).toHaveLength(4);
  });

  it("a definitive non-transient failure keeps the full skew-window rate discipline", async () => {
    let now = NOW;
    const store = freshStore(collapsedV1());
    const refresher = scriptedRefresher(() => ({ ok: false, reason: "invalid_request" }));
    const p = provider(store, refresher, { clock: () => now });

    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    now += TRANSIENT_REFRESH_COOLDOWN_MS + 1;
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls).toHaveLength(1);
  });
});
