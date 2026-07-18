import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CREDENTIALS_FILE_NAME,
  LoginRequiredError,
  MachineCredentialProvider,
  MachineCredentialStore,
  identityCredentialCodec,
  type MachineCredentials,
  type TokenRefreshResult,
  type TokenRefresher,
} from "../src/index.js";

const createdDirs: string[] = [];

function freshStore(seed?: MachineCredentials): MachineCredentialStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-prov-"));
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

/** A scripted refresher whose calls are recorded. */
function scriptedRefresher(result: TokenRefreshResult | (() => Promise<TokenRefreshResult>)): TokenRefresher & {
  calls: Array<{ refreshToken: string; serverTarget?: string }>;
} {
  const calls: Array<{ refreshToken: string; serverTarget?: string }> = [];
  return {
    calls,
    refresh: async (refreshToken, serverTarget) => {
      calls.push({ refreshToken, serverTarget });
      return typeof result === "function" ? result() : result;
    },
  };
}

const NOW = 1_700_000_000_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const clock = () => NOW;

describe("MachineCredentialProvider — proactive refresh (design 03 Flow B)", () => {
  it("does NOT refresh when the token is comfortably valid; returns the current token", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30 * 60_000) });
    const refresher = scriptedRefresher({ ok: true, accessToken: "should-not-be-used" });
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    expect(await provider.getAccessToken()).toBe("cur");
    expect(refresher.calls).toHaveLength(0);
  });

  it("refreshes + rotates the store when within the skew window of expiry", async () => {
    const store = freshStore({
      accessToken: "old",
      refreshToken: "r-old",
      expiresAt: iso(30_000), // 30s away → within the 60s skew
      serverTarget: "https://ai-game.dev",
      subject: "user-1",
    });
    const refresher = scriptedRefresher({
      ok: true,
      accessToken: "fresh",
      refreshToken: "r-new",
      expiresAt: iso(3_600_000),
    });
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    expect(await provider.getAccessToken()).toBe("fresh");
    expect(refresher.calls[0]).toEqual({ refreshToken: "r-old", serverTarget: "https://ai-game.dev" });

    // The store was rotated: new tokens, preserved identity fields.
    const stored = store.read();
    expect(stored?.accessToken).toBe("fresh");
    expect(stored?.refreshToken).toBe("r-new");
    expect(stored?.serverTarget).toBe("https://ai-game.dev");
    expect(stored?.subject).toBe("user-1");
  });

  it("preserves the previous refresh token when the server does not rotate one", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "keep-me", expiresAt: iso(10_000) });
    const refresher = scriptedRefresher({ ok: true, accessToken: "fresh" }); // no refreshToken
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    await provider.getAccessToken();
    expect(store.read()?.refreshToken).toBe("keep-me");
  });

  it("does NOT refresh when expiry is unknown (recovers reactively instead)", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r" }); // no expiresAt
    const refresher = scriptedRefresher({ ok: true, accessToken: "x" });
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    expect(await provider.getAccessToken()).toBe("cur");
    expect(refresher.calls).toHaveLength(0);
  });

  it("returns the still-valid current token when a proactive refresh fails", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30_000) });
    const refresher = scriptedRefresher({ ok: false, reason: "temporary server error" });
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    // Within skew so a refresh is attempted, but it fails; token is still valid → use it.
    expect(await provider.getAccessToken()).toBe("cur");
  });
});

describe("MachineCredentialProvider — login-required (design 03 F4)", () => {
  it("throws LoginRequiredError when signed out", async () => {
    const provider = new MachineCredentialProvider(freshStore(), scriptedRefresher({ ok: true, accessToken: "x" }), { clock });
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  it("throws LoginRequiredError when the token is expired and refresh fails (refresh expired)", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "r", expiresAt: iso(-1000) });
    const refresher = scriptedRefresher({ ok: false, reason: "invalid_grant" });
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    await expect(provider.getAccessToken()).rejects.toThrow(/login required/);
  });

  it("reactive refresh() on a family-revoke surfaces a clean LoginRequiredError", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "reused", expiresAt: iso(30 * 60_000) });
    // Server detected refresh-token reuse and revoked the family.
    const refresher = scriptedRefresher({ ok: false, reason: "invalid_grant" });
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    await expect(provider.refresh()).rejects.toBeInstanceOf(LoginRequiredError);
    // The stored credential is untouched by a failed refresh.
    expect(store.read()?.accessToken).toBe("old");
  });

  it("reactive refresh() returns rotated credentials on success", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "r", serverTarget: "https://ai-game.dev" });
    const refresher = scriptedRefresher({ ok: true, accessToken: "fresh", refreshToken: "r2", expiresAt: iso(3_600_000) });
    const provider = new MachineCredentialProvider(store, refresher, { clock });

    const rotated = await provider.refresh();
    expect(rotated.accessToken).toBe("fresh");
    expect(store.read()?.refreshToken).toBe("r2");
  });

  it("throws LoginRequiredError with no refresh token", async () => {
    const store = freshStore({ accessToken: "cur" }); // no refreshToken
    const provider = new MachineCredentialProvider(store, scriptedRefresher({ ok: true, accessToken: "x" }), { clock });
    await expect(provider.refresh()).rejects.toBeInstanceOf(LoginRequiredError);
  });
});

describe("MachineCredentialProvider — the store is never corrupted on a failed refresh", () => {
  it("does not touch the credential file when the refresher throws or fails", async () => {
    const seed: MachineCredentials = {
      accessToken: "old",
      refreshToken: "r",
      expiresAt: iso(30_000),
      serverTarget: "https://ai-game.dev",
      subject: "user-1",
    };
    const store = freshStore(seed);
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    const before = fs.readFileSync(filePath);

    // A refresher that throws (defensive path) must not corrupt the store.
    const throwing: TokenRefresher = {
      refresh: async () => {
        throw new Error("boom");
      },
    };
    const provider = new MachineCredentialProvider(store, throwing, { clock });
    // token still valid → returns it despite the failure
    await provider.getAccessToken();

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true);
    expect(fs.readdirSync(store.baseDirectory).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("emits a warning (never token material) on a refresh failure", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "secret-refresh", expiresAt: iso(-1) });
    const onWarning = vi.fn();
    const provider = new MachineCredentialProvider(store, scriptedRefresher({ ok: false, reason: "invalid_grant" }), {
      clock,
      onWarning,
    });
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(onWarning).toHaveBeenCalled();
    for (const call of onWarning.mock.calls) {
      expect(String(call[0])).not.toContain("secret-refresh");
      expect(String(call[0])).not.toContain("old");
    }
  });
});
