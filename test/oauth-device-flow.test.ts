import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PLUGIN_SCOPE,
  DEFAULT_POLL_INTERVAL_MS,
  DEVICE_CODE_GRANT_TYPE,
  HttpDeviceAuthTransport,
  MCP_AGENT_SCOPE,
  SLOW_DOWN_INCREMENT_MS,
  decodeJwtSubject,
  deviceAuthorizationUrl,
  deviceLogin,
  tokenUrl,
  type DeviceAuthTransport,
  type DeviceAuthorizeResponse,
  type DeviceLoginOptions,
  type DeviceTokenResponse,
} from "../src/index.js";

/**
 * RFC 8628 client-MUST coverage (auth-fixes design 02 T7 / §3.3 / §3.5). The flow is exercised
 * against a mocked authorization server with an injected clock + delay — no live network.
 */

function makeJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sub })}.sig`;
}

const AUTHORIZE: DeviceAuthorizeResponse = {
  device_code: "dev-code-1",
  user_code: "WDJB-MJHT",
  verification_uri: "https://ai-game.dev/device",
  verification_uri_complete: "https://ai-game.dev/device?user_code=WDJB-MJHT",
  expires_in: 900,
  interval: 5,
};

interface Harness {
  transport: DeviceAuthTransport;
  polls: string[];
  delays: number[];
}

/** Build a mock transport that returns a scripted poll sequence, plus a clock-advancing delay. */
function harness(
  pollSequence: DeviceTokenResponse[],
  authorize: DeviceAuthorizeResponse = AUTHORIZE,
): Harness & { clock: { now: () => number; delay: (ms: number) => Promise<void> } } {
  const polls: string[] = [];
  const delays: number[] = [];
  let current = 0;
  let i = 0;
  const transport: DeviceAuthTransport = {
    requestDeviceCode: async () => authorize,
    pollToken: async (deviceCode) => {
      polls.push(deviceCode);
      return pollSequence[i++] ?? { error: "authorization_pending" };
    },
  };
  return {
    transport,
    polls,
    delays,
    clock: {
      now: () => current,
      delay: async (ms: number) => {
        delays.push(ms);
        current += ms;
      },
    },
  };
}

function baseOptions(h: ReturnType<typeof harness>, over: Partial<DeviceLoginOptions> = {}): DeviceLoginOptions {
  return {
    serverBaseUrl: "https://ai-game.dev",
    clientId: "unity-mcp-cli",
    transport: h.transport,
    delay: h.clock.delay,
    now: h.clock.now,
    onUserCode: () => {},
    ...over,
  };
}

describe("RFC 8628 §3.3 — the user is shown BOTH the user_code AND the verification_uri", () => {
  it("invokes onUserCode with the user code and the (plain) verification URI", async () => {
    const h = harness([{ access_token: makeJwt("u1") }]);
    const onUserCode = vi.fn();
    const result = await deviceLogin(baseOptions(h, { onUserCode }));
    expect(result.ok).toBe(true);
    expect(onUserCode).toHaveBeenCalledTimes(1);
    const [userCode, verificationUri] = onUserCode.mock.calls[0]!;
    expect(userCode).toBe("WDJB-MJHT");
    expect(verificationUri).toBe("https://ai-game.dev/device");
    expect(userCode).toBeTruthy();
    expect(verificationUri).toBeTruthy();
  });

  it("opens the browser with verification_uri_complete when present, else the plain URI", async () => {
    const h1 = harness([{ access_token: makeJwt("u1") }]);
    const open1 = vi.fn();
    await deviceLogin(baseOptions(h1, { openBrowser: open1 }));
    expect(open1).toHaveBeenCalledWith("https://ai-game.dev/device?user_code=WDJB-MJHT");

    const noComplete = { ...AUTHORIZE, verification_uri_complete: undefined };
    const h2 = harness([{ access_token: makeJwt("u1") }], noComplete);
    const open2 = vi.fn();
    await deviceLogin(baseOptions(h2, { openBrowser: open2 }));
    expect(open2).toHaveBeenCalledWith("https://ai-game.dev/device");
  });
});

describe("RFC 8628 §3.5 — polling interval", () => {
  it("defaults the poll interval to 5s when the server omits interval", async () => {
    const h = harness([{ access_token: makeJwt("u1") }], { ...AUTHORIZE, interval: undefined });
    await deviceLogin(baseOptions(h));
    expect(h.delays[0]).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000);
  });

  it("honours a larger server interval", async () => {
    const h = harness([{ access_token: makeJwt("u1") }], { ...AUTHORIZE, interval: 10 });
    await deviceLogin(baseOptions(h));
    expect(h.delays[0]).toBe(10_000);
  });

  it("slow_down bumps the interval by 5s", async () => {
    const h = harness([{ error: "slow_down" }, { access_token: makeJwt("u1") }]);
    await deviceLogin(baseOptions(h));
    expect(h.delays[0]).toBe(5000);
    expect(h.delays[1]).toBe(10_000);
  });

  it("each successive slow_down accumulates a further +5s", async () => {
    const h = harness([
      { error: "slow_down" },
      { error: "slow_down" },
      { access_token: makeJwt("u1") },
    ]);
    await deviceLogin(baseOptions(h));
    expect(SLOW_DOWN_INCREMENT_MS).toBe(5000);
    expect(h.delays).toEqual([5000, 10_000, 15_000]);
  });

  it("slow_down bumps from the server interval, not the floor, and persists for later polls", async () => {
    const h = harness(
      [{ error: "slow_down" }, { error: "authorization_pending" }, { access_token: makeJwt("u1") }],
      { ...AUTHORIZE, interval: 8 },
    );
    await deviceLogin(baseOptions(h));
    expect(h.delays).toEqual([8000, 13_000, 13_000]);
  });
});

describe("RFC 8628 — token-endpoint error handling", () => {
  it("authorization_pending keeps polling until success", async () => {
    const h = harness([
      { error: "authorization_pending" },
      { error: "authorization_pending" },
      { access_token: makeJwt("u1") },
    ]);
    const result = await deviceLogin(baseOptions(h));
    expect(result.ok).toBe(true);
    expect(h.polls.length).toBe(3);
  });

  it("access_denied stops with reason 'denied'", async () => {
    const h = harness([{ error: "access_denied", error_description: "user said no" }]);
    const result = await deviceLogin(baseOptions(h));
    expect(result).toMatchObject({ ok: false, reason: "denied", message: "user said no" });
  });

  it("expired_token stops with reason 'expired'", async () => {
    const h = harness([{ error: "expired_token" }]);
    const result = await deviceLogin(baseOptions(h));
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });

  it("an unknown error stops with reason 'error'", async () => {
    const h = harness([{ error: "server_error", error_description: "boom" }]);
    const result = await deviceLogin(baseOptions(h));
    expect(result).toMatchObject({ ok: false, reason: "error", message: "boom" });
  });

  it("polling past the device-code lifetime ends with reason 'expired'", async () => {
    // Short lifetime + always-pending → the deadline is reached.
    const h = harness(
      Array.from({ length: 20 }, () => ({ error: "authorization_pending" as const })),
      { ...AUTHORIZE, expires_in: 12 },
    );
    const result = await deviceLogin(baseOptions(h));
    expect(result).toMatchObject({ ok: false, reason: "expired" });
  });
});

describe("device login — success builds a full credential set", () => {
  it("captures accessToken, refreshToken, expiresAt, serverTarget, and JWT subject", async () => {
    const jwt = makeJwt("user-99");
    const h = harness([{ access_token: jwt, refresh_token: "refresh-1", expires_in: 3600 }]);
    const result = await deviceLogin(baseOptions(h, { serverTarget: "https://ai-game.dev" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const c = result.credentials;
    expect(c.accessToken).toBe(jwt);
    expect(c.refreshToken).toBe("refresh-1");
    expect(c.serverTarget).toBe("https://ai-game.dev");
    expect(c.subject).toBe("user-99");
    // expiresAt = clock-at-success (5000ms after one 5s poll) + expires_in.
    expect(Date.parse(c.expiresAt!)).toBe(5000 + 3600 * 1000);
  });

  it("omits refreshToken/expiresAt/subject when the server does not provide them", async () => {
    const h = harness([{ access_token: "opaque-not-a-jwt" }]);
    const result = await deviceLogin(baseOptions(h));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.accessToken).toBe("opaque-not-a-jwt");
    expect(result.credentials.refreshToken).toBeUndefined();
    expect(result.credentials.expiresAt).toBeUndefined();
    expect(result.credentials.subject).toBeUndefined();
  });
});

describe("device login — offline / server-down (design 03 F4)", () => {
  it("returns an explicit network error (never throws) when the AS is unreachable", async () => {
    const transport: DeviceAuthTransport = {
      requestDeviceCode: async () => {
        throw new Error("fetch failed");
      },
      pollToken: async () => ({}),
    };
    const result = await deviceLogin({
      serverBaseUrl: "https://ai-game.dev",
      clientId: "unity-mcp-cli",
      transport,
      onUserCode: () => {},
    });
    expect(result).toMatchObject({ ok: false, reason: "error" });
    if (result.ok) return;
    expect(result.message).toMatch(/Cannot reach the authorization server/);
    // The flow never persists anything; a caller writes only on ok:true, so the store is untouched.
  });

  it("surfaces a pre-aborted signal as 'cancelled'", async () => {
    const h = harness([{ access_token: makeJwt("u1") }]);
    const controller = new AbortController();
    controller.abort();
    const result = await deviceLogin(baseOptions(h, { signal: controller.signal }));
    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
  });
});

describe("URL builders + JWT subject decode", () => {
  it("builds the OAuth endpoint URLs from an AS root, trimming a trailing slash", () => {
    expect(deviceAuthorizationUrl("https://ai-game.dev/")).toBe(
      "https://ai-game.dev/oauth/device_authorization",
    );
    expect(tokenUrl("https://ai-game.dev")).toBe("https://ai-game.dev/oauth/token");
  });

  it("decodes the sub claim best-effort and returns undefined on garbage", () => {
    expect(decodeJwtSubject(makeJwt("abc"))).toBe("abc");
    expect(decodeJwtSubject(undefined)).toBeUndefined();
    expect(decodeJwtSubject("not-a-jwt")).toBeUndefined();
    expect(decodeJwtSubject("a.b")).toBeUndefined(); // payload "b" is not valid base64 JSON
  });
});

/** Capture every form-encoded request the transport sends, replying like the real AS. */
function wireHarness(pollResponses: Array<{ status: number; body: unknown }>) {
  const requests: Array<{ url: string; form: URLSearchParams }> = [];
  let poll = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    requests.push({ url: target, form: new URLSearchParams(String(init?.body)) });
    if (target.endsWith("/oauth/device_authorization")) {
      return new Response(JSON.stringify(AUTHORIZE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const scripted = pollResponses[Math.min(poll++, pollResponses.length - 1)]!;
    return new Response(JSON.stringify(scripted.body), {
      status: scripted.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

describe("RFC 8707 — the default transport carries exactly ONE resource per request", () => {
  it.each([[DEFAULT_PLUGIN_SCOPE], [MCP_AGENT_SCOPE]])(
    "device-authorization + token poll each carry exactly one resource (scope %s)",
    async (scope) => {
      const { requests, fetchImpl } = wireHarness([
        { status: 200, body: { access_token: "tok" } },
      ]);
      const transport = new HttpDeviceAuthTransport({
        serverBaseUrl: "https://ai-game.dev",
        clientId: "unity-mcp-cli",
        scope,
        resource: "https://ai-game.dev/mcp",
        fetchImpl,
      });

      await transport.requestDeviceCode();
      await transport.pollToken("dev-code-1");

      expect(requests).toHaveLength(2);
      const authorize = requests[0]!;
      expect(authorize.url).toBe(deviceAuthorizationUrl("https://ai-game.dev"));
      expect(authorize.form.get("client_id")).toBe("unity-mcp-cli");
      expect(authorize.form.get("scope")).toBe(scope);
      expect(authorize.form.getAll("resource")).toEqual(["https://ai-game.dev/mcp"]);

      const token = requests[1]!;
      expect(token.url).toBe(tokenUrl("https://ai-game.dev"));
      expect(token.form.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
      expect(token.form.get("device_code")).toBe("dev-code-1");
      expect(token.form.get("client_id")).toBe("unity-mcp-cli");
      expect(token.form.getAll("resource")).toEqual(["https://ai-game.dev/mcp"]);
    },
  );

  it("omits resource entirely when not configured — the legacy wire shape is preserved", async () => {
    const { requests, fetchImpl } = wireHarness([{ status: 200, body: { access_token: "tok" } }]);
    const transport = new HttpDeviceAuthTransport({
      serverBaseUrl: "https://ai-game.dev",
      clientId: "unity-mcp-cli",
      fetchImpl,
    });

    await transport.requestDeviceCode();
    await transport.pollToken("dev-code-1");

    expect(requests[0]!.form.has("resource")).toBe(false);
    expect(requests[0]!.form.get("scope")).toBe(DEFAULT_PLUGIN_SCOPE);
    expect(requests[1]!.form.has("resource")).toBe(false);
  });
});

describe("mcp:agent — deviceLogin end-to-end against a mock AS", () => {
  it("mints an mcp:agent-scoped token; every request carries exactly one resource", async () => {
    expect(MCP_AGENT_SCOPE).toBe("mcp:agent");
    const agentJwt = makeJwt("agent-user-7");
    const { requests, fetchImpl } = wireHarness([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      {
        status: 200,
        body: {
          access_token: agentJwt,
          refresh_token: "agent-refresh-1",
          token_type: "Bearer",
          expires_in: 3600,
          scope: MCP_AGENT_SCOPE,
        },
      },
    ]);

    let clock = 0;
    const delays: number[] = [];
    const result = await deviceLogin({
      serverBaseUrl: "https://ai-game.dev",
      clientId: "unity-mcp-cli",
      scope: MCP_AGENT_SCOPE,
      resource: "https://ai-game.dev/mcp",
      fetchImpl,
      onUserCode: () => {},
      delay: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
      now: () => clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.accessToken).toBe(agentJwt);
    expect(result.credentials.refreshToken).toBe("agent-refresh-1");
    expect(result.credentials.subject).toBe("agent-user-7");

    // One device-authorization request + three token polls, all with scope=mcp:agent and
    // exactly ONE resource each (single-audience tokens).
    expect(requests).toHaveLength(4);
    expect(requests[0]!.url).toBe(deviceAuthorizationUrl("https://ai-game.dev"));
    expect(requests[0]!.form.get("scope")).toBe(MCP_AGENT_SCOPE);
    for (const request of requests) {
      expect(request.form.getAll("resource")).toEqual(["https://ai-game.dev/mcp"]);
    }
    for (const poll of requests.slice(1)) {
      expect(poll.url).toBe(tokenUrl("https://ai-game.dev"));
      expect(poll.form.get("grant_type")).toBe(DEVICE_CODE_GRANT_TYPE);
      expect(poll.form.get("device_code")).toBe("dev-code-1");
    }

    // The RFC 8628 poller behaves identically on the agent plane: slow_down still adds +5s.
    expect(delays).toEqual([5000, 5000, 10_000]);
  });
});
