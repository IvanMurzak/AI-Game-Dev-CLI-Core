import { describe, expect, it, vi } from "vitest";

import {
  HttpTokenRefresher,
  buildRefreshForm,
  buildRefreshResult,
  normalizeServerBase,
  tokenUrl,
} from "../src/index.js";

describe("normalizeServerBase (UnityTokenRefresher.NormalizeBase parity)", () => {
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

describe("buildRefreshForm (UnityTokenRefresher.BuildRefreshForm parity)", () => {
  it("builds a refresh_token grant form", () => {
    const form = buildRefreshForm("refresh-1", "unity-mcp-cli", "mcp:plugin");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("client_id")).toBe("unity-mcp-cli");
    expect(form.get("scope")).toBe("mcp:plugin");
  });
});

describe("buildRefreshResult (UnityTokenRefresher.BuildResult parity)", () => {
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
  it("POSTs a form-encoded refresh grant to {normalizedBase}/oauth/token and parses success", async () => {
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
      clientId: "unity-mcp-cli",
      fetchImpl,
      now: () => 2_000_000,
    });

    // serverTarget carries a /mcp hub suffix → must be normalized to the AS root.
    const result = await refresher.refresh("refresh-1", "https://ai-game.dev/mcp");
    expect(result).toEqual({
      ok: true,
      accessToken: "new-a",
      refreshToken: "new-r",
      expiresAt: new Date(2_000_000 + 3600 * 1000).toISOString(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(tokenUrl("https://ai-game.dev"));
    expect(calls[0]!.init.method).toBe("POST");
    const body = String(calls[0]!.init.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-1");
    expect(body).toContain("client_id=unity-mcp-cli");
  });

  it("fails closed on an HTTP error, surfacing the server error (family-revoke shape)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const refresher = new HttpTokenRefresher({
      defaultServerBaseUrl: "https://ai-game.dev",
      clientId: "unity-mcp-cli",
      fetchImpl,
    });
    expect(await refresher.refresh("reused-token")).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("fails closed on a network error (never throws)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const refresher = new HttpTokenRefresher({
      defaultServerBaseUrl: "https://ai-game.dev",
      clientId: "unity-mcp-cli",
      fetchImpl,
    });
    const result = await refresher.refresh("refresh-1");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("returns failure with no refresh token / no server target", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const noBase = new HttpTokenRefresher({ defaultServerBaseUrl: "", clientId: "c", fetchImpl });
    expect(await noBase.refresh("")).toEqual({ ok: false, reason: "no refresh token" });
    expect(await noBase.refresh("r")).toEqual({ ok: false, reason: "no server target" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
