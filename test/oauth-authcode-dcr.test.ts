import { describe, expect, it, vi } from "vitest";

import {
  MCP_AGENT_SCOPE,
  authCodeLogin,
  deriveCodeChallenge,
  registrationStoreKey,
  type AuthCodeLoginOptions,
  type AuthCodeTransport,
  type ClientRegistration,
  type ClientRegistrationStoreLike,
} from "../src/index.js";

/**
 * End-to-end desktop-login coverage against a **mock authorization server that rejects unregistered
 * client_ids**, exactly like production: `/oauth/authorize` resolves `client_id` by an exact registry
 * lookup whose only writer is `POST /oauth/register`, and RFC 6749 §4.1.2.1 forbids redirecting an
 * unverified client — so a bad id is answered to the *browser* and the loopback listener hears
 * nothing.
 *
 * This is the coverage the shipped v0.4.0 regression slipped through: the previous suites stubbed
 * `authCodeLogin` wholesale and asserted a hardcoded `clientId` as *expected*, so a client id the AS
 * had never heard of read as correct. Here the REAL flow runs — real `node:http` loopback listener,
 * real discovery / registration / authorize / token round trips through the injected `fetch` — and
 * the AS is the judge.
 */

const AS_BASE = "https://as.test";

function makeJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sub })}.sig`;
}

/**
 * Loopback redirect matching per RFC 8252 §7.3 + the server's own rule: scheme, host, path and query
 * must match exactly; ONLY the port may differ.
 */
function loopbackRedirectMatches(registered: string, presented: string): boolean {
  try {
    const a = new URL(registered);
    const b = new URL(presented);
    return (
      a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search
    );
  } catch {
    return false;
  }
}

interface MockAsOptions {
  /** Serve an RFC 8414 metadata document (default true). */
  serveDiscovery?: boolean;
  /** Path prefix for the OAuth endpoints — only reachable via discovery. Default none. */
  pathPrefix?: string;
  /** Reject EVERY client at /oauth/authorize, even freshly registered ones. */
  rejectAllClients?: boolean;
  /** Force the token endpoint to answer with this error instead of minting a token. */
  tokenError?: { error: string; error_description?: string };
  /**
   * Break the flow's pre-browser authorize PROBE only — either a transport failure (`"network"`) or
   * an HTTP status. The browser's own authorize decision is untouched, so these model an AS that is
   * momentarily unreachable/faulting for the probe while the real sign-in would still succeed.
   */
  probeFailure?: "network" | number;
}

/** A mock authorization server driven entirely through the flow's injectable `fetch` seam. */
function createMockAuthorizationServer(options: MockAsOptions = {}) {
  const prefix = options.pathPrefix ?? "";
  const serveDiscovery = options.serveDiscovery ?? true;
  const clients = new Map<string, { clientName?: string; redirectUris: string[] }>();
  const issuedCodes = new Map<string, { clientId: string; redirectUri: string; codeChallenge: string }>();
  const calls = { discovery: 0, register: 0, authorize: 0, token: 0 };
  const authorizeClientIds: string[] = [];
  let clientSeq = 0;
  let codeSeq = 0;

  const url = (p: string) => `${AS_BASE}${prefix}${p}`;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function handleDiscovery(): Response {
    calls.discovery++;
    if (!serveDiscovery) return new Response("not found", { status: 404 });
    return json({
      issuer: AS_BASE,
      authorization_endpoint: url("/oauth/authorize"),
      token_endpoint: url("/oauth/token"),
      registration_endpoint: url("/oauth/register"),
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }

  function handleRegister(init?: RequestInit): Response {
    calls.register++;
    const body = JSON.parse(String(init?.body)) as {
      client_name?: string;
      redirect_uris?: string[];
      token_endpoint_auth_method?: string;
    };
    const redirectUris = body.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      return json({ error: "invalid_redirect_uri" }, 400);
    }
    // The server MINTS its own id and ignores anything the caller might have suggested.
    const clientId = `agd_client_minted${++clientSeq}`;
    clients.set(clientId, { clientName: body.client_name, redirectUris });
    return json(
      {
        client_id: clientId,
        client_name: body.client_name,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: body.token_endpoint_auth_method ?? "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: 1_784_956_127,
      },
      201,
    );
  }

  /** The authorize decision, shared by the flow's probe and the simulated browser. */
  function authorize(target: URL): { response: Response; code?: string } {
    calls.authorize++;
    const clientId = target.searchParams.get("client_id") ?? "";
    authorizeClientIds.push(clientId);
    const client = clients.get(clientId);
    if (!client || options.rejectAllClients) {
      // Byte-identical to production: no redirect, the browser just sees this JSON.
      return { response: json({ error: "invalid_client", error_description: "unknown client_id" }, 400) };
    }
    const redirectUri = target.searchParams.get("redirect_uri") ?? "";
    if (!client.redirectUris.some((registered) => loopbackRedirectMatches(registered, redirectUri))) {
      return { response: json({ error: "invalid_request", error_description: "redirect_uri mismatch" }, 400) };
    }
    const code = `code-${++codeSeq}`;
    issuedCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge: target.searchParams.get("code_challenge") ?? "",
    });
    return {
      response: new Response("", { status: 302, headers: { Location: `${AS_BASE}/authorize?request_id=${code}` } }),
      code,
    };
  }

  function handleToken(init?: RequestInit): Response {
    calls.token++;
    if (options.tokenError) {
      return json(options.tokenError, 400);
    }
    const form = new URLSearchParams(String(init?.body));
    const clientId = form.get("client_id") ?? "";
    if (!clients.has(clientId)) {
      return json({ error: "invalid_client", error_description: "unknown client_id" }, 401);
    }
    const issued = issuedCodes.get(form.get("code") ?? "");
    if (!issued || issued.clientId !== clientId) {
      return json({ error: "invalid_grant", error_description: "authorization code is invalid" }, 400);
    }
    if (deriveCodeChallenge(form.get("code_verifier") ?? "") !== issued.codeChallenge) {
      return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    }
    issuedCodes.delete(form.get("code") ?? "");
    return json({
      access_token: makeJwt("desktop-user-1"),
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_in: 3600,
      scope: MCP_AGENT_SCOPE,
    });
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    if (target.pathname === "/.well-known/oauth-authorization-server") return handleDiscovery();
    if (target.pathname === `${prefix}/oauth/register` && method === "POST") return handleRegister(init);
    if (target.pathname === `${prefix}/oauth/authorize` && method === "GET") {
      // Only the probe reaches authorize through `fetch`; the browser calls `authorize()` directly.
      if (options.probeFailure === "network") throw new Error("fetch failed");
      if (typeof options.probeFailure === "number") {
        return new Response("upstream unavailable", { status: options.probeFailure });
      }
      return authorize(target).response;
    }
    if (target.pathname === `${prefix}/oauth/token` && method === "POST") return handleToken(init);
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  /**
   * A browser opener that behaves like a real user: it asks the AS to authorize and only fires the
   * loopback redirect when the AS actually redirects. On `invalid_client` it does what a real browser
   * does — render the JSON error and never call back — so the flow is left to its own devices.
   */
  function browser(): (authorizeUrl: string) => void {
    return (authorizeUrl: string) => {
      void (async () => {
        const target = new URL(authorizeUrl);
        const decision = authorize(target);
        if (!decision.code) return; // rejected: no redirect will ever arrive
        const redirect = new URL(target.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("state", target.searchParams.get("state")!);
        redirect.searchParams.set("code", decision.code);
        await fetch(redirect.toString());
      })().catch(() => {});
    };
  }

  return { fetchImpl, browser, calls, clients, authorizeClientIds, endpoints: { url } };
}

/** In-memory registration store — tests must NEVER touch the real `~/.ai-game-dev/`. */
class MemoryRegistrationStore implements ClientRegistrationStoreLike {
  readonly entries = new Map<string, ClientRegistration>();

  read(serverBaseUrl: string): ClientRegistration | null {
    return this.entries.get(registrationStoreKey(serverBaseUrl)) ?? null;
  }
  save(serverBaseUrl: string, registration: ClientRegistration): void {
    this.entries.set(registrationStoreKey(serverBaseUrl), registration);
  }
  delete(serverBaseUrl: string): void {
    this.entries.delete(registrationStoreKey(serverBaseUrl));
  }
}

function loginOptions(over: Partial<AuthCodeLoginOptions> = {}): AuthCodeLoginOptions {
  return {
    serverBaseUrl: AS_BASE,
    scope: MCP_AGENT_SCOPE,
    timeoutMs: 4000,
    ...over,
  };
}

describe("the v0.4.0 regression itself — a static, unregistered client id can never sign in", () => {
  it("is refused by the AS, never redirects, and surfaces only as a misleading timeout", async () => {
    const as = createMockAuthorizationServer();
    const store = new MemoryRegistrationStore();

    const result = await authCodeLogin(
      loginOptions({
        clientId: "ai-game-dev-app", // the hardcoded id that shipped in v0.4.0
        registrationStore: store,
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
        timeoutMs: 250,
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(as.authorizeClientIds).toEqual(["ai-game-dev-app"]);
    expect(as.calls.register).toBe(0); // opting out of DCR means nobody rescues you
    expect(as.calls.token).toBe(0);
  });
});

describe("authCodeLogin — dynamic client registration (the fix)", () => {
  it("registers on first run and signs in, never sending a static id to /oauth/authorize", async () => {
    const as = createMockAuthorizationServer();
    const store = new MemoryRegistrationStore();

    const result = await authCodeLogin(
      loginOptions({
        clientName: "AI Game Dev",
        registrationStore: store,
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentials.accessToken).toBeTruthy();
    expect(result.credentials.subject).toBe("desktop-user-1");
    expect(result.credentials.refreshToken).toBe("refresh-1");

    expect(as.calls.register).toBe(1);
    // Every client id the AS ever saw was the one IT minted — never a hardcoded slug.
    expect(as.authorizeClientIds.length).toBeGreaterThan(0);
    for (const id of as.authorizeClientIds) {
      expect(id).toMatch(/^agd_client_/);
      expect(id).not.toBe("ai-game-dev-app");
    }
    expect(store.read(AS_BASE)?.clientId).toBe(as.authorizeClientIds[0]);
  });

  it("registers the PORTLESS loopback URI while presenting the ephemeral port at authorize", async () => {
    const as = createMockAuthorizationServer();

    await authCodeLogin(
      loginOptions({
        registrationStore: new MemoryRegistrationStore(),
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
      }),
    );

    const registered = [...as.clients.values()][0]!;
    expect(registered.redirectUris).toEqual(["http://127.0.0.1/callback"]);
    expect(registered.clientName).toBe("AI Game Dev"); // human-readable consent-screen name
  });

  it("reuses the persisted client_id on the next launch — one registration, two different ports", async () => {
    const as = createMockAuthorizationServer();
    const store = new MemoryRegistrationStore();
    const ports: number[] = [];
    const capturePort = (authorizeUrl: string) => {
      ports.push(Number(new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!).port));
    };

    const run = () =>
      authCodeLogin(
        loginOptions({
          registrationStore: store,
          fetchImpl: as.fetchImpl,
          openBrowser: as.browser(),
          onAuthorizeUrl: capturePort,
        }),
      );

    const first = await run();
    const second = await run();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(as.calls.register).toBe(1); // registered ONCE across both launches
    expect(new Set(as.authorizeClientIds).size).toBe(1); // ...and the same id was reused
    // RFC 8252 §7.3 port floating: the listener bound a fresh ephemeral port each time.
    expect(ports).toHaveLength(2);
    expect(ports[0]).toBeGreaterThan(0);
    expect(ports[1]).toBeGreaterThan(0);
    expect(ports[0]).not.toBe(ports[1]);
  });

  it("re-registers EXACTLY ONCE when the stored registration was GC'd or revoked", async () => {
    const as = createMockAuthorizationServer();
    const store = new MemoryRegistrationStore();
    // A registration the AS has since garbage-collected (30-day unused-client GC) or revoked.
    store.save(AS_BASE, { clientId: "agd_client_stale", redirectUris: ["http://127.0.0.1/callback"] });

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: store,
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
      }),
    );

    expect(result.ok).toBe(true);
    expect(as.calls.register).toBe(1); // exactly one re-registration
    expect(as.authorizeClientIds[0]).toBe("agd_client_stale"); // the probe caught it...
    expect(store.read(AS_BASE)?.clientId).toMatch(/^agd_client_minted/); // ...and it was replaced
    expect(store.read(AS_BASE)?.clientId).not.toBe("agd_client_stale");
  });

  it("gives up after that one re-registration instead of looping", async () => {
    const as = createMockAuthorizationServer({ rejectAllClients: true });
    const store = new MemoryRegistrationStore();
    // Start from a stored registration so the ONLY registration this run can make is the recovery
    // one — an AS that rejects even a freshly minted id must not drive an endless register/retry.
    store.save(AS_BASE, { clientId: "agd_client_stale", redirectUris: ["http://127.0.0.1/callback"] });
    const opener = vi.fn();

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: store,
        fetchImpl: as.fetchImpl,
        openBrowser: opener,
        timeoutMs: 30_000, // would hang for 30s if the flow fell through to waiting for a redirect
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "error" });
    if (result.ok) return;
    expect(result.message).toMatch(/invalid_client/i);
    expect(as.calls.register).toBe(1); // ONE retry, not a loop
    expect(as.calls.authorize).toBe(2); // the initial probe + the post-re-registration probe
    expect(opener).not.toHaveBeenCalled(); // never sent the user to a page that would only error
    expect(as.calls.token).toBe(0);
  });

  it("never opens a browser when sign-in is cancelled while the authorize probe is in flight", async () => {
    const as = createMockAuthorizationServer();
    const controller = new AbortController();
    const opener = vi.fn();

    // Cancel exactly while the flow is probing /oauth/authorize. The probe deliberately fails OPEN
    // on every transport error — the cancellation's own AbortError included — so a flow that did not
    // re-check cancellation afterwards would push a browser window at a user who just cancelled.
    const cancellingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (new URL(url).pathname === "/oauth/authorize") {
        controller.abort();
      }
      return (as.fetchImpl as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch;

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: new MemoryRegistrationStore(),
        fetchImpl: cancellingFetch,
        openBrowser: opener,
        signal: controller.signal,
        timeoutMs: 30_000,
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "cancelled" });
    expect(opener).not.toHaveBeenCalled();
    expect(as.calls.token).toBe(0);
  });

  it.each([
    ["the probe cannot run at all (transport error)", "network" as const],
    ["the AS is faulting (503)", 503],
    ["the AS is throttling (429)", 429],
  ])("still signs in when %s — the probe fails OPEN", async (_label, probeFailure) => {
    const as = createMockAuthorizationServer({ probeFailure });

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: new MemoryRegistrationStore(),
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
      }),
    );

    // None of these is a verdict on THIS authorization request, so refusing here would break a
    // sign-in that completes perfectly well through the browser — which is exactly what happens.
    expect(result.ok).toBe(true);
    expect(as.calls.token).toBe(1);
  });

  it("surfaces a non-invalid_client authorize refusal immediately instead of timing out", async () => {
    const as = createMockAuthorizationServer();
    const store = new MemoryRegistrationStore();
    // A registration whose redirect URI the AS will not match → invalid_request, not invalid_client.
    store.save(AS_BASE, { clientId: "agd_client_known" });
    as.clients.set("agd_client_known", { redirectUris: ["http://127.0.0.1/somewhere-else"] });

    const started = performance.now();
    const result = await authCodeLogin(
      loginOptions({
        registrationStore: store,
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
        timeoutMs: 30_000,
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "error" });
    if (result.ok) return;
    expect(result.message).toMatch(/redirect_uri mismatch/i);
    expect(performance.now() - started).toBeLessThan(5000); // did NOT wait out the browser timeout
    expect(as.calls.register).toBe(0); // not an invalid_client, so no re-registration
  });

  it("drops the stored registration when the TOKEN endpoint reports invalid_client", async () => {
    const as = createMockAuthorizationServer({
      tokenError: { error: "invalid_client", error_description: "client was revoked" },
    });
    const store = new MemoryRegistrationStore();

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: store,
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(as.calls.token).toBe(1);
    // Discarded, so the NEXT sign-in registers fresh rather than repeating the failure.
    expect(store.read(AS_BASE)).toBeNull();
  });

  it("keeps a valid registration when the token exchange fails for an unrelated reason", async () => {
    const as = createMockAuthorizationServer({
      tokenError: { error: "invalid_grant", error_description: "PKCE verification failed" },
    });
    const store = new MemoryRegistrationStore();

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: store,
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(store.read(AS_BASE)?.clientId).toMatch(/^agd_client_minted/);
  });
});

describe("authCodeLogin — RFC 8414 discovery is load-bearing", () => {
  it("uses the discovered registration / authorization / token endpoints, not the hardcoded paths", async () => {
    const as = createMockAuthorizationServer({ pathPrefix: "/v2" });
    const seen: string[] = [];

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: new MemoryRegistrationStore(),
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
        onAuthorizeUrl: (url) => seen.push(url),
      }),
    );

    // Only reachable at /v2/... — a flow still using the hardcoded /oauth/... paths would 404.
    expect(result.ok).toBe(true);
    expect(as.calls.discovery).toBe(1);
    expect(as.calls.register).toBe(1);
    expect(as.calls.token).toBe(1);
    expect(new URL(seen[0]!).pathname).toBe("/v2/oauth/authorize");
  });

  it("falls back to the hardcoded paths when the AS serves no metadata document", async () => {
    const as = createMockAuthorizationServer({ serveDiscovery: false });

    const result = await authCodeLogin(
      loginOptions({
        registrationStore: new MemoryRegistrationStore(),
        fetchImpl: as.fetchImpl,
        openBrowser: as.browser(),
      }),
    );

    expect(result.ok).toBe(true);
    expect(as.calls.register).toBe(1);
  });
});

describe("authCodeLogin — a supplied clientId still opts out entirely (engine-CLI contract)", () => {
  it("performs no discovery, no registration and no probe when clientId is given", async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error("the static-clientId path must not touch the network");
    }) as unknown as typeof fetch;
    const transport: AuthCodeTransport = {
      exchangeCode: async () => ({ access_token: "opaque-token" }),
    };
    const opener = (authorizeUrl: string) => {
      const target = new URL(authorizeUrl);
      const redirect = new URL(target.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", target.searchParams.get("state")!);
      redirect.searchParams.set("code", "static-code");
      void fetch(redirect.toString()).catch(() => {});
    };

    const result = await authCodeLogin(
      loginOptions({ clientId: "unity-mcp-cli", transport, fetchImpl, openBrowser: opener }),
    );

    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
