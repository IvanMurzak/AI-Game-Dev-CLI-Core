import { describe, expect, it, vi } from "vitest";

import {
  HttpTokenRefresher,
  LOCK_STALE_MS,
  REFRESH_HTTP_TIMEOUT,
  buildRefreshForm,
  buildRefreshResult,
  normalizeServerBase,
  tokenUrl,
} from "../src/index.js";

describe("normalizeServerBase (HttpTokenRefresher.NormalizeBase parity)", () => {
  it("trims a trailing slash and a trailing /mcp hub segment", () => {
    expect(normalizeServerBase("https://ai-game.dev/")).toBe("https://ai-game.dev");
    expect(normalizeServerBase("https://ai-game.dev/mcp")).toBe("https://ai-game.dev");
    expect(normalizeServerBase("https://ai-game.dev/mcp/")).toBe("https://ai-game.dev");
    expect(normalizeServerBase("https://ai-game.dev/MCP")).toBe("https://ai-game.dev");
    expect(normalizeServerBase("http://localhost:5300")).toBe("http://localhost:5300");
  });

  it("returns null for empty/whitespace targets", () => {
    expect(normalizeServerBase(undefined)).toBeNull();
    expect(normalizeServerBase(null)).toBeNull();
    expect(normalizeServerBase("   ")).toBeNull();
  });
});

describe("buildRefreshForm (04 §3 wire rules)", () => {
  it("builds a refresh_token grant form presenting the per-request clientId", () => {
    const form = buildRefreshForm("refresh-1", "unity-mcp-plugin");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("client_id")).toBe("unity-mcp-plugin");
  });

  it("omits scope AND resource entirely — the form is EXACTLY three parameters (P0-3)", () => {
    // 04 §3 rule 3: the server falls back to the stored grant; sending a component-default
    // `scope` on refresh would permanently narrow an agent family. The FULL key set is pinned so
    // a reintroduced default (the pre-c3 refresher sent `scope` on every request) turns this RED.
    const form = buildRefreshForm("refresh-1", "unity-mcp-plugin");
    expect([...form.keys()].sort()).toEqual(["client_id", "grant_type", "refresh_token"]);
    expect(form.has("scope")).toBe(false);
    expect(form.has("resource")).toBe(false);
  });
});

describe("buildRefreshResult (C# BuildResult parity)", () => {
  const now = () => 1_000_000;

  it("returns failure for a null parse", () => {
    expect(buildRefreshResult(true, 200, null, now)).toEqual({ ok: false, reason: "empty token response" });
  });

  it("returns failure on non-success or missing access token, surfacing the server error", () => {
    expect(buildRefreshResult(false, 400, { error: "invalid_grant" }, now)).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
    expect(buildRefreshResult(true, 200, { refresh_token: "r" }, now)).toMatchObject({ ok: false });
  });

  it("returns success with rotated token + computed expiry", () => {
    const result = buildRefreshResult(
      true,
      200,
      { access_token: "a", refresh_token: "r2", expires_in: 3600 },
      now,
    );
    expect(result).toEqual({
      ok: true,
      accessToken: "a",
      refreshToken: "r2",
      expiresAt: new Date(1_000_000 + 3600 * 1000).toISOString(),
    });
  });

  it("omits refreshToken/expiresAt when the server does not rotate/expire", () => {
    const result = buildRefreshResult(true, 200, { access_token: "a" }, now);
    expect(result).toEqual({ ok: true, accessToken: "a" });
  });
});

describe("HttpTokenRefresher", () => {
  it("POSTs a form-encoded refresh grant to {normalizedBase}/oauth/token presenting the REQUEST's clientId", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ access_token: "new-a", refresh_token: "new-r", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const refresher = new HttpTokenRefresher({
      defaultServerBaseUrl: "https://ai-game.dev",
      fetchImpl,
      now: () => 2_000_000,
    });

    // serverTarget carries a /mcp hub suffix → must be normalized to the AS root.
    const result = await refresher.refresh({
      refreshToken: "refresh-1",
      clientId: "unity-mcp-plugin",
      serverTarget: "https://ai-game.dev/mcp",
    });
    expect(result).toEqual({
      ok: true,
      accessToken: "new-a",
      refreshToken: "new-r",
      expiresAt: new Date(2_000_000 + 3600 * 1000).toISOString(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(tokenUrl("https://ai-game.dev"));
    expect(calls[0]!.init.method).toBe("POST");
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("client_id")).toBe("unity-mcp-plugin");
  });

  it("sends NO scope and NO resource on the wire — the body is exactly three parameters (P0-3)", async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init!.body));
      return new Response(JSON.stringify({ access_token: "new-a" }), { status: 200 });
    }) as unknown as typeof fetch;
    const refresher = new HttpTokenRefresher({ defaultServerBaseUrl: "https://ai-game.dev", fetchImpl });

    expect(await refresher.refresh({ refreshToken: "refresh-1", clientId: "godot-cli" })).toEqual({
      ok: true,
      accessToken: "new-a",
    });
    expect(bodies).toHaveLength(1);
    const form = new URLSearchParams(bodies[0]!);
    // Positive half: the request really happened and carried the three mandated parameters …
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("client_id")).toBe("godot-cli");
    // … and NOTHING else: `scope` (P0-3 agent-family narrowing) and `resource` are absent.
    expect([...form.keys()].sort()).toEqual(["client_id", "grant_type", "refresh_token"]);
  });

  it("fails closed on an HTTP error, surfacing the server error (family-revoke shape)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const refresher = new HttpTokenRefresher({ defaultServerBaseUrl: "https://ai-game.dev", fetchImpl });
    expect(await refresher.refresh({ refreshToken: "reused-token", clientId: "unity-mcp-cli" })).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
  });

  it("fails closed on a network error (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const refresher = new HttpTokenRefresher({ defaultServerBaseUrl: "https://ai-game.dev", fetchImpl });
    const result = await refresher.refresh({ refreshToken: "refresh-1", clientId: "unity-mcp-cli" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("returns failure with no refresh token / no client id / no server target — no network call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const noBase = new HttpTokenRefresher({ defaultServerBaseUrl: "", fetchImpl });
    expect(await noBase.refresh({ refreshToken: "", clientId: "c" })).toEqual({ ok: false, reason: "no refresh token" });
    expect(await noBase.refresh({ refreshToken: "r", clientId: "" })).toEqual({ ok: false, reason: "no client id" });
    expect(await noBase.refresh({ refreshToken: "r", clientId: "c" })).toEqual({ ok: false, reason: "no server target" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("defaults its network timeout to REFRESH_HTTP_TIMEOUT (15 s), inside the lock ordering", () => {
    // 04 §2: REFRESH_HTTP_TIMEOUT < LOCK_STALE_MS is the invariant that keeps a live lock holder
    // inside one HTTP call from being declared stale. The refresher's default must BE the shared
    // constant, not a private number.
    expect(REFRESH_HTTP_TIMEOUT).toBe(15_000);
    expect(REFRESH_HTTP_TIMEOUT).toBeLessThan(LOCK_STALE_MS);
  });
});
