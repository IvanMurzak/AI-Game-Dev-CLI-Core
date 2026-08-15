import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CREDENTIALS_FILE_NAME,
  CREDENTIALS_LOCK_FILE_NAME,
  CredentialLockBusyError,
  HttpTokenRefresher,
  LoginRequiredError,
  MachineCredentialLock,
  MachineCredentialProvider,
  MachineCredentialStore,
  MachineCredentialStoreUnreadableError,
  identityCredentialCodec,
  type CredentialTelemetryEvent,
  type MachineCredentials,
  type TokenRefreshRequest,
  type TokenRefreshResult,
  type TokenRefresher,
} from "../src/index.js";

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-prov-"));
  createdDirs.push(dir);
  return dir;
}

function freshStore(seed?: MachineCredentials): MachineCredentialStore {
  const store = new MachineCredentialStore(freshDir(), identityCredentialCodec);
  if (seed) store.write(seed);
  return store;
}

/** A test lock with short budgets so contended cases don't run minutes. */
function testLock(store: MachineCredentialStore): MachineCredentialLock {
  return new MachineCredentialLock(store.baseDirectory, {
    acquireBudgetMs: 300,
    maxBackoffMs: 25,
    onWarning: () => {},
  });
}

afterEach(() => {
  while (createdDirs.length > 0) {
    fs.rmSync(createdDirs.pop()!, { recursive: true, force: true });
  }
});

/** A scripted refresher whose calls are recorded. */
function scriptedRefresher(
  result: TokenRefreshResult | ((request: TokenRefreshRequest) => Promise<TokenRefreshResult>),
): TokenRefresher & { calls: TokenRefreshRequest[] } {
  const calls: TokenRefreshRequest[] = [];
  return {
    calls,
    refresh: async (request) => {
      calls.push(request);
      return typeof result === "function" ? result(request) : result;
    },
  };
}

const NOW = 1_700_000_000_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const clock = () => NOW;

function provider(
  store: MachineCredentialStore,
  refresher: TokenRefresher,
  extra: ConstructorParameters<typeof MachineCredentialProvider>[2] = {},
): MachineCredentialProvider {
  return new MachineCredentialProvider(store, refresher, {
    clock,
    lock: testLock(store),
    defaultClientId: "unity-mcp-cli",
    ...extra,
  });
}

describe("MachineCredentialProvider — proactive refresh (04 §3 / F3)", () => {
  it("does NOT refresh when the token is comfortably valid; returns the current token", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30 * 60_000) });
    const refresher = scriptedRefresher({ ok: true, accessToken: "should-not-be-used" });
    const p = provider(store, refresher);

    expect(await p.getAccessToken()).toBe("cur");
    expect(refresher.calls).toHaveLength(0);
  });

  it("refreshes + rotates the store when within the skew window of expiry (legacy/v1 credential)", async () => {
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
    const p = provider(store, refresher);

    expect(await p.getAccessToken()).toBe("fresh");
    // A v1 credential is `families.legacy` (mint client unknown) → the COMPONENT DEFAULT id (§3.7).
    expect(refresher.calls[0]).toMatchObject({
      refreshToken: "r-old",
      clientId: "unity-mcp-cli",
      serverTarget: "https://ai-game.dev",
    });

    // §3.7 / F11.1: the store was rewritten as a v2 document — the rotation lives in
    // `families.legacy` and the v1 mirror follows it (sole plugin-plane credential).
    const stored = store.read();
    expect(stored?.version).toBe(2);
    expect(stored?.families?.legacy).toMatchObject({ accessToken: "fresh", refreshToken: "r-new" });
    expect(stored?.accessToken).toBe("fresh"); // v1 compat mirror
    expect(stored?.refreshToken).toBe("r-new");
    expect(stored?.serverTarget).toBe("https://ai-game.dev");
    expect(stored?.subject).toBe("user-1");
  });

  it("presents the family's STORED clientId — never the component default (04 §3 rule 2, probe Q1)", async () => {
    const store = freshStore({
      version: 2,
      serverTarget: "https://ai-game.dev",
      families: {
        plugin: {
          accessToken: "old",
          refreshToken: "r-old",
          expiresAt: iso(30_000),
          clientId: "unity-mcp-plugin", // minted under the PLUGIN's id …
          scope: "mcp:plugin",
        },
      },
    });
    const refresher = scriptedRefresher({ ok: true, accessToken: "fresh" });
    // … while THIS component's own default id differs (the cross-mint setup).
    const p = provider(store, refresher, { defaultClientId: "godot-cli" });

    expect(await p.getAccessToken()).toBe("fresh");
    expect(refresher.calls).toHaveLength(1);
    expect(refresher.calls[0]!.clientId).toBe("unity-mcp-plugin");
    // The rotated family keeps its identity fields.
    expect(store.read()?.families?.plugin).toMatchObject({
      accessToken: "fresh",
      clientId: "unity-mcp-plugin",
      scope: "mcp:plugin",
    });
  });

  it("refreshes the AGENT family when asked for the agent plane, with ITS stored clientId", async () => {
    const store = freshStore({
      version: 2,
      families: {
        agent: {
          accessToken: "agent-old",
          refreshToken: "agent-r",
          expiresAt: iso(10_000),
          clientId: "app-dcr-1234",
          scope: "mcp:agent",
        },
        plugin: { accessToken: "plug", refreshToken: "plug-r", expiresAt: iso(30 * 60_000), clientId: "unity-mcp-plugin", scope: "mcp:plugin" },
      },
      serverTarget: "https://ai-game.dev",
    });
    const refresher = scriptedRefresher({ ok: true, accessToken: "agent-fresh", refreshToken: "agent-r2" });
    const p = provider(store, refresher);

    expect(await p.getAccessToken({ family: "agent" })).toBe("agent-fresh");
    expect(refresher.calls[0]!.clientId).toBe("app-dcr-1234");
    const stored = store.read();
    expect(stored?.families?.agent).toMatchObject({ accessToken: "agent-fresh", refreshToken: "agent-r2", scope: "mcp:agent" });
    // The plugin family (and the v1 mirror it feeds) is untouched by an agent-plane refresh.
    expect(stored?.families?.plugin?.accessToken).toBe("plug");
    expect(stored?.accessToken).toBe("plug");
  });

  it("wire-level: an agent-family refresh POSTs the stored clientId and NO scope/resource (P0-3)", async () => {
    // End-to-end through the REAL HttpTokenRefresher: this is the request that would
    // permanently narrow the agent family if a component default `scope` ever leaked back in.
    const store = freshStore({
      version: 2,
      serverTarget: "https://ai-game.dev",
      families: {
        agent: {
          accessToken: "agent-old",
          refreshToken: "agent-r",
          expiresAt: iso(10_000),
          clientId: "unity-mcp-plugin",
          scope: "mcp:agent",
        },
      },
    });
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init!.body));
      return new Response(JSON.stringify({ access_token: "agent-fresh" }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = provider(store, new HttpTokenRefresher({ defaultServerBaseUrl: "https://ai-game.dev", fetchImpl }), {
      defaultClientId: "unity-mcp-cli", // must NOT be what goes on the wire
    });

    expect(await p.getAccessToken({ family: "agent" })).toBe("agent-fresh");
    expect(bodies).toHaveLength(1);
    const form = new URLSearchParams(bodies[0]!);
    expect(form.get("client_id")).toBe("unity-mcp-plugin");
    expect([...form.keys()].sort()).toEqual(["client_id", "grant_type", "refresh_token"]);
  });

  it("preserves the previous refresh token when the server does not rotate one (rule 4)", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "keep-me", expiresAt: iso(10_000) });
    const refresher = scriptedRefresher({ ok: true, accessToken: "fresh" }); // no refreshToken
    const p = provider(store, refresher);

    await p.getAccessToken();
    expect(store.read()?.refreshToken).toBe("keep-me");
  });

  it("does NOT refresh when expiry is unknown (recovers reactively instead)", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r" }); // no expiresAt
    const refresher = scriptedRefresher({ ok: true, accessToken: "x" });
    const p = provider(store, refresher);

    expect(await p.getAccessToken()).toBe("cur");
    expect(refresher.calls).toHaveLength(0);
  });

  it("returns the still-valid current token when a proactive refresh fails", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30_000) });
    const refresher = scriptedRefresher({ ok: false, reason: "temporary server error" });
    const p = provider(store, refresher);

    // Within skew so a refresh is attempted, but it fails; token is still valid → use it.
    expect(await p.getAccessToken()).toBe("cur");
  });

  it("fails the attempt (no network call) when a v2 family stores no clientId and no default is configured", async () => {
    const store = freshStore({
      version: 2,
      families: { plugin: { accessToken: "old", refreshToken: "r", expiresAt: iso(-1000) } },
    });
    const refresher = scriptedRefresher({ ok: true, accessToken: "x" });
    const p = provider(store, refresher, { defaultClientId: undefined });

    await expect(p.getAccessToken()).rejects.toThrow(/client id/);
    expect(refresher.calls).toHaveLength(0); // fail closed — never guess an id
  });
});

describe("MachineCredentialProvider — the 04 §2 lock (c1 review A1)", () => {
  it("performs the refresh HTTP call AND the store write inside the lock's critical section", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "r", expiresAt: iso(10_000) });
    const lockPath = path.join(store.baseDirectory, CREDENTIALS_LOCK_FILE_NAME);
    let lockHeldDuringRefresh = false;
    const refresher = scriptedRefresher(async () => {
      lockHeldDuringRefresh = fs.existsSync(lockPath);
      return { ok: true, accessToken: "fresh" };
    });
    const p = provider(store, refresher);

    expect(await p.getAccessToken()).toBe("fresh");
    expect(lockHeldDuringRefresh).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false); // released after
    expect(store.read()?.accessToken).toBe("fresh"); // written before release
  });

  it("defaults its lock to the store's own directory (sibling credentials.lock)", () => {
    const store = freshStore();
    const p = new MachineCredentialProvider(store, scriptedRefresher({ ok: true, accessToken: "x" }), { clock });
    expect(p.lock.lockPath).toBe(path.join(store.baseDirectory, CREDENTIALS_LOCK_FILE_NAME));
  });

  it("double-checked refresh: adopts a peer's rotation on the under-lock re-read WITHOUT a network call", async () => {
    const store = freshStore({ accessToken: "stale", refreshToken: "r-old", expiresAt: iso(10_000) });
    const refresher = scriptedRefresher({ ok: true, accessToken: "should-not-be-called" });
    const lock = testLock(store);
    // Simulate a peer completing its refresh JUST before we enter the critical section.
    const originalWithLock = lock.withLock.bind(lock);
    vi.spyOn(lock, "withLock").mockImplementation((fn) =>
      originalWithLock(async () => {
        store.rotate("peer-fresh", "peer-r", iso(3_600_000));
        return (await fn()) as never;
      }),
    );
    const p = new MachineCredentialProvider(store, refresher, { clock, lock, defaultClientId: "unity-mcp-cli" });

    expect(await p.getAccessToken()).toBe("peer-fresh");
    expect(refresher.calls).toHaveLength(0); // adopted, not re-refreshed
  });

  it("fails the attempt as BUSY when the lock budget is exhausted — never refreshes lock-free (D9)", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "r", expiresAt: iso(-1000) }); // expired
    // A FRESH foreign-format lock file: contended and not stale → acquisition must time out.
    fs.writeFileSync(
      path.join(store.baseDirectory, CREDENTIALS_LOCK_FILE_NAME),
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString(), hostId: os.hostname() }),
    );
    const refresher = scriptedRefresher({ ok: true, accessToken: "x" });
    const p = provider(store, refresher);

    // Expired token + busy lock → the attempt fails BUSY (retry later), NOT "sign in again".
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(CredentialLockBusyError);
    expect(refresher.calls).toHaveLength(0); // never proceeded lock-free
  });

  it("returns the still-valid token when the lock is busy (proactive refresh skipped)", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30_000) });
    fs.writeFileSync(
      path.join(store.baseDirectory, CREDENTIALS_LOCK_FILE_NAME),
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString(), hostId: os.hostname() }),
    );
    const refresher = scriptedRefresher({ ok: true, accessToken: "x" });
    const p = provider(store, refresher);

    expect(await p.getAccessToken()).toBe("cur");
    expect(refresher.calls).toHaveLength(0);
  });
});

describe("MachineCredentialProvider — invalid_grant / family death (04 §3 rule 5)", () => {
  it("family dead: LoginRequiredError + exactly ONE telemetry event + other families untouched", async () => {
    const store = freshStore({
      version: 2,
      serverTarget: "https://ai-game.dev",
      subject: "user-1",
      families: {
        agent: { accessToken: "agent-a", refreshToken: "agent-r", expiresAt: iso(30 * 60_000), clientId: "c", scope: "mcp:agent" },
        plugin: { accessToken: "plug-a", refreshToken: "plug-r", expiresAt: iso(-1000), clientId: "c", scope: "mcp:plugin" },
      },
    });
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    const before = fs.readFileSync(filePath);
    const events: CredentialTelemetryEvent[] = [];
    const refresher = scriptedRefresher({ ok: false, reason: "invalid_grant" });
    const p = provider(store, refresher, { onTelemetry: (e) => events.push(e) });

    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);

    // ONE structured event, carrying no token material.
    expect(events).toEqual([{ type: "family-dead", family: "plugin", reason: "invalid_grant" }]);
    // The store file was NOT touched: no delete, no rewrite, the agent family survives.
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
    expect(store.read()?.families?.agent?.refreshToken).toBe("agent-r");

    // NEVER loops: a second call re-throws from the memo without a new network attempt or event.
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls).toHaveLength(1);
    expect(events).toHaveLength(1);

    // The agent plane is still fully alive through the same provider.
    expect(await p.getAccessToken({ family: "agent" })).toBe("agent-a");
  });

  it("invalid_grant post-failure re-read: a racer's legitimate rotation is ADOPTED, not declared dead (F3.5)", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "r-old", expiresAt: iso(-1000) });
    const events: CredentialTelemetryEvent[] = [];
    // An old, non-lock-honoring client rotates while our doomed request is in flight.
    const refresher = scriptedRefresher(async () => {
      store.rotate("racer-fresh", "racer-r", iso(3_600_000));
      return { ok: false, reason: "invalid_grant" };
    });
    const p = provider(store, refresher, { onTelemetry: (e) => events.push(e) });

    expect(await p.getAccessToken()).toBe("racer-fresh"); // adopted
    expect(events).toEqual([]); // not dead — no telemetry
  });

  it("reactive refresh() on a family-revoke surfaces a clean LoginRequiredError, store untouched", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "reused", expiresAt: iso(30 * 60_000) });
    const refresher = scriptedRefresher({ ok: false, reason: "invalid_grant" });
    const p = provider(store, refresher);

    await expect(p.refresh()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(store.read()?.accessToken).toBe("old");
  });

  it("a fresh login by another surface re-arms a family this process saw die", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "dead-r", expiresAt: iso(-1000) });
    let scripted: TokenRefreshResult = { ok: false, reason: "invalid_grant" };
    const refresher = scriptedRefresher(async () => scripted);
    const p = provider(store, refresher, { refreshSkewMs: 0 }); // isolate the dead-memo from rate discipline

    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);

    // Another surface re-logs in (new refresh token) → the dead memo must not block it.
    store.write({ accessToken: "relogin", refreshToken: "new-r", expiresAt: iso(-1000) });
    scripted = { ok: true, accessToken: "fresh-after-relogin" };
    expect(await p.getAccessToken()).toBe("fresh-after-relogin");
  });
});

describe("MachineCredentialProvider — rate discipline (04 §3 rule 6)", () => {
  it("makes at most ONE network attempt per family per skew window", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30_000) });
    const refresher = scriptedRefresher({ ok: false, reason: "HTTP 503" });
    const p = provider(store, refresher);

    expect(await p.getAccessToken()).toBe("cur"); // attempt 1 fails, token still valid
    expect(await p.getAccessToken()).toBe("cur"); // suppressed — inside the same skew window
    expect(await p.getAccessToken()).toBe("cur");
    expect(refresher.calls).toHaveLength(1);
  });

  it("attempts again once the skew window has elapsed", async () => {
    let nowMs = NOW;
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30_000) });
    const refresher = scriptedRefresher({ ok: false, reason: "HTTP 503" });
    const p = new MachineCredentialProvider(store, refresher, {
      clock: () => nowMs,
      lock: testLock(store),
      defaultClientId: "unity-mcp-cli",
    });

    await p.getAccessToken();
    nowMs += 61_000; // beyond the 60s window (token now expired, forcing the reactive path)
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(refresher.calls).toHaveLength(2);
  });
});

describe("MachineCredentialProvider — unreadable store (04 §1 / c1 review A3)", () => {
  it("read path: an unreadable store is a DISTINCT sign-in-required, and the file is never touched", async () => {
    const store = freshStore();
    fs.mkdirSync(store.baseDirectory, { recursive: true });
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    fs.writeFileSync(filePath, "not json — a corrupted/foreign blob");
    const before = fs.readFileSync(filePath);
    const p = provider(store, scriptedRefresher({ ok: true, accessToken: "x" }));

    await expect(p.getAccessToken()).rejects.toThrow(/unreadable/);
    expect(p.isSignedIn()).toBe(false); // never throws, never a signed-in signal
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it("a store that turns unreadable DURING refresh is transient — never overwritten (A3)", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(30_000) });
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    const lock = testLock(store);
    // The store becomes unreadable between our first read and the critical-section re-read
    // (e.g. a mid-write of a non-lock-honoring old client, or a DPAPI hiccup).
    const originalWithLock = lock.withLock.bind(lock);
    vi.spyOn(lock, "withLock").mockImplementation((fn) =>
      originalWithLock(async () => {
        fs.writeFileSync(filePath, "garbage mid-refresh");
        return (await fn()) as never;
      }),
    );
    const refresher = scriptedRefresher({ ok: true, accessToken: "should-not-matter" });
    const p = new MachineCredentialProvider(store, refresher, { clock, lock, defaultClientId: "unity-mcp-cli" });

    // Still-valid token → the command proceeds on it; the unreadable file is NOT overwritten.
    expect(await p.getAccessToken()).toBe("cur");
    expect(refresher.calls).toHaveLength(0);
    expect(fs.readFileSync(filePath).toString()).toBe("garbage mid-refresh");
  });

  it("expired token + unreadable-during-refresh surfaces the TYPED unreadable error (not login-required)", async () => {
    const store = freshStore({ accessToken: "cur", refreshToken: "r", expiresAt: iso(-1000) });
    const filePath = path.join(store.baseDirectory, CREDENTIALS_FILE_NAME);
    const lock = testLock(store);
    const originalWithLock = lock.withLock.bind(lock);
    vi.spyOn(lock, "withLock").mockImplementation((fn) =>
      originalWithLock(async () => {
        fs.writeFileSync(filePath, "garbage mid-refresh");
        return (await fn()) as never;
      }),
    );
    const p = new MachineCredentialProvider(store, scriptedRefresher({ ok: true, accessToken: "x" }), {
      clock,
      lock,
      defaultClientId: "unity-mcp-cli",
    });

    await expect(p.getAccessToken()).rejects.toBeInstanceOf(MachineCredentialStoreUnreadableError);
    expect(fs.readFileSync(filePath).toString()).toBe("garbage mid-refresh"); // untouched
  });
});

describe("MachineCredentialProvider — login-required (design 03 F4)", () => {
  it("throws LoginRequiredError when signed out", async () => {
    const p = provider(freshStore(), scriptedRefresher({ ok: true, accessToken: "x" }));
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  it("throws LoginRequiredError when the token is expired and refresh fails (refresh expired)", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "r", expiresAt: iso(-1000) });
    const refresher = scriptedRefresher({ ok: false, reason: "invalid_grant" });
    const p = provider(store, refresher);

    await expect(p.getAccessToken()).rejects.toThrow(/login required/);
  });

  it("reactive refresh() returns the rotated document on success", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "r", serverTarget: "https://ai-game.dev" });
    const refresher = scriptedRefresher({ ok: true, accessToken: "fresh", refreshToken: "r2", expiresAt: iso(3_600_000) });
    const p = provider(store, refresher);

    const rotated = await p.refresh();
    expect(rotated.accessToken).toBe("fresh"); // v1 mirror of the rotated legacy family
    expect(store.read()?.refreshToken).toBe("r2");
  });

  it("throws LoginRequiredError with no refresh token", async () => {
    const store = freshStore({ accessToken: "cur" }); // no refreshToken
    const p = provider(store, scriptedRefresher({ ok: true, accessToken: "x" }));
    await expect(p.refresh()).rejects.toBeInstanceOf(LoginRequiredError);
  });

  it("isSignedIn distinguishes planes: a tools-only store is signed in for plugin, not agent (F10/D3)", () => {
    const store = freshStore({
      version: 2,
      families: { plugin: { accessToken: "a", refreshToken: "r", clientId: "c", scope: "mcp:plugin" } },
    });
    const p = provider(store, scriptedRefresher({ ok: true, accessToken: "x" }));
    expect(p.isSignedIn()).toBe(true);
    expect(p.isSignedIn("plugin")).toBe(true);
    expect(p.isSignedIn("agent")).toBe(false); // App pickup impossible by design
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
    const p = provider(store, throwing);
    // token still valid → returns it despite the failure
    await p.getAccessToken();

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true);
    expect(fs.readdirSync(store.baseDirectory).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("emits warnings (never token material) on refresh failure and family death", async () => {
    const store = freshStore({ accessToken: "old", refreshToken: "secret-refresh", expiresAt: iso(-1) });
    const onWarning = vi.fn();
    const p = provider(store, scriptedRefresher({ ok: false, reason: "invalid_grant" }), { onWarning });
    await expect(p.getAccessToken()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(onWarning).toHaveBeenCalled();
    for (const call of onWarning.mock.calls) {
      expect(String(call[0])).not.toContain("secret-refresh");
      expect(String(call[0])).not.toContain("old");
    }
  });
});
