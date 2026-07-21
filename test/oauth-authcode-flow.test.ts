import { describe, expect, it, vi } from "vitest";

import {
  AUTHORIZATION_CODE_GRANT_TYPE,
  DEFAULT_PLUGIN_SCOPE,
  HttpAuthCodeTransport,
  MCP_AGENT_SCOPE,
  authCodeLogin,
  authorizeUrl,
  buildAuthorizeUrl,
  createLoopbackListener,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  isLoopbackHost,
  type AuthCodeLoginOptions,
  type AuthCodeTokenResponse,
  type AuthCodeTransport,
  type ExchangeCodeParams,
} from "../src/index.js";

/**
 * RFC 8252 authorization-code + PKCE (S256) + loopback coverage. The happy path and the state/timeout
 * negatives run against the REAL `node:http` loopback listener (127.0.0.1, ephemeral port) driven by
 * an injected browser opener that fires the redirect over `fetch`, with the AS token endpoint mocked
 * so there is no live network. Surface-parallel to the RFC 8628 device-flow tests.
 */

function makeJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sub })}.sig`;
}

/** A token transport that records the exchange params and returns a scripted response. */
function recordingTransport(response: AuthCodeTokenResponse) {
  const calls: ExchangeCodeParams[] = [];
  const transport: AuthCodeTransport = {
    exchangeCode: async (params) => {
      calls.push(params);
      return response;
    },
  };
  return { transport, calls };
}

/**
 * A browser opener that behaves like a user completing sign-in: it parses the authorize URL and,
 * asynchronously, GETs the loopback `redirect_uri` echoing back the (optionally overridden) `state`
 * plus a `code` / `error`. Captures the URL it was handed for assertions.
 */
function redirectingOpener(
  over: { code?: string; state?: string; error?: string; errorDescription?: string; suppress?: boolean } = {},
) {
  const seen: { url?: string } = {};
  const opener = (url: string) => {
    seen.url = url;
    if (over.suppress) return; // simulate a browser that never redirects (→ timeout)
    const authorize = new URL(url);
    const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("state", over.state ?? authorize.searchParams.get("state")!);
    if (over.error) {
      redirect.searchParams.set("error", over.error);
      if (over.errorDescription) redirect.searchParams.set("error_description", over.errorDescription);
    } else {
      redirect.searchParams.set("code", over.code ?? "auth-code-xyz");
    }
    // Fire-and-forget: the loopback handler is already attached, so there is no lost-request race.
    void fetch(redirect.toString()).catch(() => {});
  };
  return { opener, seen };
}

function baseOptions(over: Partial<AuthCodeLoginOptions> = {}): AuthCodeLoginOptions {
  return {
    serverBaseUrl: "https://ai-game.dev",
    clientId: "unity-mcp-cli",
    timeoutMs: 5000,
    ...over,
  };
}

describe("PKCE (RFC 7636) — verifier + S256 challenge", () => {
  it("matches the RFC 7636 Appendix B golden vector", () => {
    // The canonical example from RFC 7636 §4.1–4.2.
    expect(deriveCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generates a 43+ char verifier from the unreserved base64url set", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the challenge deterministically from a verifier (base64url, no padding)", () => {
    const verifier = "fixed-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
    expect(deriveCodeChallenge(verifier)).toBe(deriveCodeChallenge(verifier));
    expect(deriveCodeChallenge(verifier)).not.toContain("=");
    expect(deriveCodeChallenge(verifier)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uses an injectable random source (pinning verifier + state)", () => {
    const rng = (size: number) => Buffer.alloc(size, 7);
    expect(generateCodeVerifier(rng)).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(generateState(rng)).toBe(Buffer.alloc(16, 7).toString("base64url"));
  });
});

describe("buildAuthorizeUrl — exact query shape", () => {
  it("carries response_type, PKCE S256, state, scope, redirect_uri and one resource", () => {
    const url = new URL(
      buildAuthorizeUrl({
        serverBaseUrl: "https://ai-game.dev/",
        clientId: "unity-mcp-cli",
        redirectUri: "http://127.0.0.1:5123/callback",
        scope: MCP_AGENT_SCOPE,
        state: "state-123",
        codeChallenge: "chal-abc",
        resource: "https://ai-game.dev/mcp",
      }),
    );
    expect(url.origin + url.pathname).toBe(authorizeUrl("https://ai-game.dev"));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("unity-mcp-cli");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:5123/callback");
    expect(url.searchParams.get("scope")).toBe("mcp:agent");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe("chal-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.getAll("resource")).toEqual(["https://ai-game.dev/mcp"]);
  });

  it("omits resource entirely when not configured (legacy wire shape)", () => {
    const url = new URL(
      buildAuthorizeUrl({
        serverBaseUrl: "https://ai-game.dev",
        clientId: "unity-mcp-cli",
        redirectUri: "http://127.0.0.1:5123/callback",
        scope: DEFAULT_PLUGIN_SCOPE,
        state: "s",
        codeChallenge: "c",
      }),
    );
    expect(url.searchParams.has("resource")).toBe(false);
  });
});

describe("isLoopbackHost — only 127.0.0.0/8 and ::1", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.0.0.53", true],
    ["::1", true],
    ["[::1]", true],
    ["0.0.0.0", false],
    ["localhost", false],
    ["192.168.1.10", false],
    ["example.com", false],
    ["10.0.0.1", false],
  ])("%s → %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("authCodeLogin — happy path vs a mock AS (real loopback listener)", () => {
  it("authorize URL is correct, code is exchanged with the matching verifier, ES256 token minted", async () => {
    const agentJwt = makeJwt("agent-user-7");
    const { transport, calls } = recordingTransport({
      access_token: agentJwt,
      refresh_token: "agent-refresh-1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: MCP_AGENT_SCOPE,
    });
    const { opener, seen } = redirectingOpener({ code: "auth-code-xyz" });

    const result = await authCodeLogin(
      baseOptions({
        scope: MCP_AGENT_SCOPE,
        resource: "https://ai-game.dev/mcp",
        transport,
        openBrowser: opener,
        now: () => 1_000,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Credentials: ES256 agent-plane token, refresh, subject decoded, expiry from injected clock.
    expect(result.credentials.accessToken).toBe(agentJwt);
    expect(result.credentials.refreshToken).toBe("agent-refresh-1");
    expect(result.credentials.subject).toBe("agent-user-7");
    expect(result.credentials.serverTarget).toBe("https://ai-game.dev");
    expect(Date.parse(result.credentials.expiresAt!)).toBe(1_000 + 3600 * 1000);

    // Authorize URL correctness (PKCE S256, resource, state, loopback redirect).
    const url = new URL(seen.url!);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("mcp:agent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.getAll("resource")).toEqual(["https://ai-game.dev/mcp"]);
    expect(url.searchParams.get("state")).toBeTruthy();
    const redirectUri = new URL(url.searchParams.get("redirect_uri")!);
    expect(redirectUri.hostname).toBe("127.0.0.1");
    expect(Number(redirectUri.port)).toBeGreaterThan(0);
    expect(redirectUri.pathname).toBe("/callback");

    // The code exchange saw the real code, the loopback redirect_uri, and a verifier whose S256
    // challenge is exactly the one advertised on the authorize URL.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.code).toBe("auth-code-xyz");
    expect(calls[0]!.redirectUri).toBe(redirectUri.toString());
    expect(deriveCodeChallenge(calls[0]!.codeVerifier)).toBe(url.searchParams.get("code_challenge"));
  });

  it("omits refresh/expiry/subject when the AS does not return them; defaults scope to mcp:plugin", async () => {
    const { transport } = recordingTransport({ access_token: "opaque-not-a-jwt" });
    const { opener, seen } = redirectingOpener();
    const result = await authCodeLogin(baseOptions({ transport, openBrowser: opener }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.accessToken).toBe("opaque-not-a-jwt");
    expect(result.credentials.refreshToken).toBeUndefined();
    expect(result.credentials.expiresAt).toBeUndefined();
    expect(result.credentials.subject).toBeUndefined();
    expect(new URL(seen.url!).searchParams.get("scope")).toBe(DEFAULT_PLUGIN_SCOPE);
  });
});

describe("authCodeLogin — negatives (all refused, no token minted)", () => {
  it("refuses a state mismatch (CSRF) without exchanging the code", async () => {
    const exchange = vi.fn();
    const transport: AuthCodeTransport = { exchangeCode: exchange };
    const { opener } = redirectingOpener({ state: "attacker-state" });
    const result = await authCodeLogin(baseOptions({ transport, openBrowser: opener }));
    expect(result).toMatchObject({ ok: false, reason: "state_mismatch" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("refuses a PKCE verifier mismatch surfaced as invalid_grant at the token endpoint", async () => {
    const { transport } = recordingTransport({
      error: "invalid_grant",
      error_description: "PKCE verification failed",
    });
    const { opener } = redirectingOpener();
    const result = await authCodeLogin(baseOptions({ transport, openBrowser: opener }));
    expect(result).toMatchObject({ ok: false, reason: "error", message: "PKCE verification failed" });
  });

  it("refuses when the redirect carries an OAuth error (access_denied → denied)", async () => {
    const exchange = vi.fn();
    const transport: AuthCodeTransport = { exchangeCode: exchange };
    const { opener } = redirectingOpener({ error: "access_denied", errorDescription: "user said no" });
    const result = await authCodeLogin(baseOptions({ transport, openBrowser: opener }));
    expect(result).toMatchObject({ ok: false, reason: "denied", message: "user said no" });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("times out (not hangs) when the browser never redirects", async () => {
    const exchange = vi.fn();
    const transport: AuthCodeTransport = { exchangeCode: exchange };
    const { opener } = redirectingOpener({ suppress: true });
    const start = performance.now();
    const result = await authCodeLogin(baseOptions({ transport, openBrowser: opener, timeoutMs: 150 }));
    const elapsed = performance.now() - start;
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(exchange).not.toHaveBeenCalled();
    expect(elapsed).toBeLessThan(3000); // resolved promptly on the timeout, did not hang
  });

  it("refuses a non-loopback redirect host before binding or opening a browser", async () => {
    const exchange = vi.fn();
    const opener = vi.fn();
    const transport: AuthCodeTransport = { exchangeCode: exchange };
    for (const loopbackHost of ["0.0.0.0", "example.com", "192.168.1.5"]) {
      const result = await authCodeLogin(baseOptions({ transport, openBrowser: opener, loopbackHost }));
      expect(result).toMatchObject({ ok: false, reason: "error" });
      if (result.ok) continue;
      expect(result.message).toMatch(/non-loopback/i);
    }
    expect(opener).not.toHaveBeenCalled();
    expect(exchange).not.toHaveBeenCalled();
  });
});

describe("authCodeLogin — headless-safe (clear error, never a hang)", () => {
  it("returns reason 'no_browser' when the opener cannot launch a browser", async () => {
    const exchange = vi.fn();
    const transport: AuthCodeTransport = { exchangeCode: exchange };
    const opener = () => {
      throw new Error("no graphical browser is available (headless environment)");
    };
    const result = await authCodeLogin(baseOptions({ transport, openBrowser: opener, timeoutMs: 5000 }));
    expect(result).toMatchObject({ ok: false, reason: "no_browser" });
    if (result.ok) return;
    expect(result.message).toMatch(/device-code login/i);
    expect(exchange).not.toHaveBeenCalled();
  });

  it("surfaces a pre-aborted signal as 'cancelled'", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await authCodeLogin(baseOptions({ signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("createLoopbackListener — exact-path binding on 127.0.0.1", () => {
  it("captures a redirect on the exact callback path and 404s any other path", async () => {
    const listener = await createLoopbackListener({ host: "127.0.0.1", path: "/callback", timeoutMs: 2000 });
    try {
      expect(new URL(listener.redirectUri).hostname).toBe("127.0.0.1");
      expect(listener.port).toBeGreaterThan(0);

      // A probe at the wrong path is refused (404) and does not satisfy the wait.
      const wrong = await fetch(`http://127.0.0.1:${listener.port}/not-the-callback`);
      expect(wrong.status).toBe(404);

      const wait = listener.waitForRedirect();
      await fetch(`${listener.redirectUri}?code=abc&state=xyz`);
      await expect(wait).resolves.toMatchObject({ code: "abc", state: "xyz" });
    } finally {
      listener.close();
    }
  });

  it("rejects a non-loopback bind host", async () => {
    await expect(
      createLoopbackListener({ host: "8.8.8.8", path: "/callback", timeoutMs: 1000 }),
    ).rejects.toThrow(/non-loopback/i);
  });
});

describe("HttpAuthCodeTransport — token request wire shape", () => {
  it("POSTs authorization_code + PKCE verifier + exactly one resource to /oauth/token", async () => {
    const requests: Array<{ url: string; form: URLSearchParams }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), form: new URLSearchParams(String(init?.body)) });
      return new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const transport = new HttpAuthCodeTransport({
      serverBaseUrl: "https://ai-game.dev",
      clientId: "unity-mcp-cli",
      resource: "https://ai-game.dev/mcp",
      fetchImpl,
    });
    const token = await transport.exchangeCode({
      code: "the-code",
      codeVerifier: "the-verifier",
      redirectUri: "http://127.0.0.1:5123/callback",
    });

    expect(token.access_token).toBe("tok");
    expect(requests).toHaveLength(1);
    const { url, form } = requests[0]!;
    expect(url).toBe("https://ai-game.dev/oauth/token");
    expect(form.get("grant_type")).toBe(AUTHORIZATION_CODE_GRANT_TYPE);
    expect(form.get("code")).toBe("the-code");
    expect(form.get("code_verifier")).toBe("the-verifier");
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1:5123/callback");
    expect(form.get("client_id")).toBe("unity-mcp-cli");
    expect(form.getAll("resource")).toEqual(["https://ai-game.dev/mcp"]);
  });

  it("omits resource when not configured (legacy wire shape)", async () => {
    const requests: Array<URLSearchParams> = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(new URLSearchParams(String(init?.body)));
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new HttpAuthCodeTransport({
      serverBaseUrl: "https://ai-game.dev",
      clientId: "unity-mcp-cli",
      fetchImpl,
    });
    await transport.exchangeCode({ code: "c", codeVerifier: "v", redirectUri: "http://127.0.0.1:1/callback" });
    expect(requests[0]!.has("resource")).toBe(false);
  });
});
