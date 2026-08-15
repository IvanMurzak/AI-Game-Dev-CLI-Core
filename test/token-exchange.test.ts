import { describe, expect, it, vi } from "vitest";

import {
  HUB_AUDIENCE,
  HttpTokenExchangeClient,
  TOKEN_EXCHANGE_GRANT_TYPE,
  TOKEN_EXCHANGE_MAX_CLIENT_ID_LENGTH,
  TOKEN_TYPE_ACCESS_TOKEN,
  buildTokenExchangeForm,
  buildTokenExchangeResult,
  tokenUrl,
} from "../src/index.js";

describe("token exchange — the FROZEN a5 wire shape (RFC 8693, 04 §4)", () => {
  it("pins the exact URNs", () => {
    expect(TOKEN_EXCHANGE_GRANT_TYPE).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
    expect(TOKEN_TYPE_ACCESS_TOKEN).toBe("urn:ietf:params:oauth:token-type:access_token");
    expect(HUB_AUDIENCE).toBe("urn:agd:hub");
  });

  it("builds EXACTLY the five frozen parameters, scope=mcp:plugin, no audience by default", () => {
    const form = buildTokenExchangeForm("agent-es256-token", "unity-mcp-plugin");
    expect(form.get("grant_type")).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
    expect(form.get("subject_token")).toBe("agent-es256-token");
    expect(form.get("subject_token_type")).toBe(TOKEN_TYPE_ACCESS_TOKEN);
    expect(form.get("client_id")).toBe("unity-mcp-plugin");
    expect(form.get("scope")).toBe("mcp:plugin"); // anything else → invalid_scope (a5)
    // The FULL key set is pinned: audience/resource are absent unless explicitly requested.
    expect([...form.keys()].sort()).toEqual([
      "client_id",
      "grant_type",
      "scope",
      "subject_token",
      "subject_token_type",
    ]);
  });

  it("adds audience ONLY when provided (the exact urn:agd:hub)", () => {
    const form = buildTokenExchangeForm("t", "c", HUB_AUDIENCE);
    expect(form.get("audience")).toBe(HUB_AUDIENCE);
    expect([...form.keys()].sort()).toEqual([
      "audience",
      "client_id",
      "grant_type",
      "scope",
      "subject_token",
      "subject_token_type",
    ]);
  });
});

describe("buildTokenExchangeResult", () => {
  const now = () => 1_000_000;

  it("maps every frozen a5 response key", () => {
    const result = buildTokenExchangeResult(
      true,
      200,
      {
        access_token: "plug-a",
        issued_token_type: TOKEN_TYPE_ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "plug-r",
        scope: "mcp:plugin",
        sub: "usr_1",
      },
      now,
    );
    expect(result).toEqual({
      ok: true,
      accessToken: "plug-a",
      refreshToken: "plug-r",
      expiresAt: new Date(1_000_000 + 3600 * 1000).toISOString(),
      scope: "mcp:plugin",
      sub: "usr_1",
      issuedTokenType: TOKEN_TYPE_ACCESS_TOKEN,
      tokenType: "Bearer",
    });
  });

  it("fails closed on error responses, surfacing the server error (invalid_scope shape)", () => {
    expect(buildTokenExchangeResult(false, 400, { error: "invalid_scope" }, now)).toEqual({
      ok: false,
      reason: "invalid_scope",
    });
    expect(buildTokenExchangeResult(true, 200, null, now)).toEqual({
      ok: false,
      reason: "empty token-exchange response",
    });
    expect(buildTokenExchangeResult(true, 200, { refresh_token: "r" }, now)).toMatchObject({ ok: false });
  });
});

describe("HttpTokenExchangeClient", () => {
  function capturingFetch(body: Record<string, unknown>, status = 200) {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init!.body) });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("POSTs the frozen form to {normalizedBase}/oauth/token and parses the frozen response", async () => {
    const { calls, fetchImpl } = capturingFetch({
      access_token: "plug-a",
      issued_token_type: TOKEN_TYPE_ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "plug-r",
      scope: "mcp:plugin",
      sub: "usr_1",
    });
    const client = new HttpTokenExchangeClient({
      defaultServerBaseUrl: "https://ai-game.dev",
      fetchImpl,
      now: () => 2_000_000,
    });

    const result = await client.exchange({
      subjectToken: "agent-es256-token",
      clientId: "unity-mcp-plugin",
      serverTarget: "https://ai-game.dev/mcp", // hub URL → normalized to the AS root
    });
    expect(result).toMatchObject({ ok: true, accessToken: "plug-a", refreshToken: "plug-r", sub: "usr_1" });
    expect(calls[0]!.url).toBe(tokenUrl("https://ai-game.dev"));
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get("grant_type")).toBe(TOKEN_EXCHANGE_GRANT_TYPE);
    expect(form.get("subject_token")).toBe("agent-es256-token");
    expect(form.get("subject_token_type")).toBe(TOKEN_TYPE_ACCESS_TOKEN);
    expect(form.get("client_id")).toBe("unity-mcp-plugin");
    expect(form.get("scope")).toBe("mcp:plugin");
    expect(form.has("audience")).toBe(false);
    expect(form.has("resource")).toBe(false);
  });

  it("fails closed BEFORE the network on invalid inputs (a5 constraints)", async () => {
    const { fetchImpl } = capturingFetch({ access_token: "x" });
    const client = new HttpTokenExchangeClient({ defaultServerBaseUrl: "https://ai-game.dev", fetchImpl });

    expect(await client.exchange({ subjectToken: "", clientId: "c" })).toEqual({
      ok: false,
      reason: "no subject token",
    });
    expect(await client.exchange({ subjectToken: "t", clientId: "" })).toEqual({
      ok: false,
      reason: "no client id",
    });
    expect(
      await client.exchange({ subjectToken: "t", clientId: "x".repeat(TOKEN_EXCHANGE_MAX_CLIENT_ID_LENGTH + 1) }),
    ).toEqual({ ok: false, reason: `client id exceeds ${TOKEN_EXCHANGE_MAX_CLIENT_ID_LENGTH} characters` });
    // audience/resource ONLY as the EXACT urn — anything else is a doomed request.
    expect(await client.exchange({ subjectToken: "t", clientId: "c", audience: "https://ai-game.dev/mcp" })).toEqual({
      ok: false,
      reason: `audience must be exactly ${HUB_AUDIENCE} or omitted`,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts the exact hub audience and sends it verbatim", async () => {
    const { calls, fetchImpl } = capturingFetch({ access_token: "plug-a" });
    const client = new HttpTokenExchangeClient({ defaultServerBaseUrl: "https://ai-game.dev", fetchImpl });

    const result = await client.exchange({ subjectToken: "t", clientId: "c", audience: HUB_AUDIENCE });
    expect(result).toMatchObject({ ok: true });
    expect(new URLSearchParams(calls[0]!.body).get("audience")).toBe(HUB_AUDIENCE);
  });

  it("fails closed on HTTP / network errors (never throws)", async () => {
    const errorClient = new HttpTokenExchangeClient({
      defaultServerBaseUrl: "https://ai-game.dev",
      fetchImpl: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch,
    });
    expect(await errorClient.exchange({ subjectToken: "stale-pat", clientId: "c" })).toEqual({
      ok: false,
      reason: "invalid_grant", // e.g. a PAT or stale agent token rejected as subject
    });

    const throwingClient = new HttpTokenExchangeClient({
      defaultServerBaseUrl: "https://ai-game.dev",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    const result = await throwingClient.exchange({ subjectToken: "t", clientId: "c" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toMatch(/ECONNREFUSED/);
  });
});
