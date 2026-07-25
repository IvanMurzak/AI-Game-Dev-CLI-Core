import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_REGISTRATIONS_FILE_NAME,
  ClientRegistrationError,
  ClientRegistrationStore,
  DEFAULT_CLIENT_NAME,
  authorizationServerMetadataUrl,
  discoverAuthorizationServer,
  fallbackAuthorizationServerMetadata,
  registerClient,
  registrationStoreKey,
  registrationUrl,
  resolveClientRegistration,
  type ClientRegistration,
  type ClientRegistrationStoreLike,
} from "../src/index.js";

/**
 * RFC 8414 discovery + RFC 7591 dynamic client registration coverage. Everything runs against a
 * mocked `fetch` through the module's injectable seam — no live network — and the durable store is
 * exercised against a real temp directory (mirroring `machine-credentials.test.ts`).
 */

const createdDirs: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-dcr-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `fetch` double that returns scripted responses and records every request. */
function scriptedFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

/** An in-memory {@link ClientRegistrationStoreLike} for tests that do not need real files. */
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

const PRODUCTION_METADATA = {
  issuer: "https://ai-game.dev",
  authorization_endpoint: "https://ai-game.dev/oauth/authorize",
  token_endpoint: "https://ai-game.dev/oauth/token",
  registration_endpoint: "https://ai-game.dev/oauth/register",
  device_authorization_endpoint: "https://ai-game.dev/oauth/device_authorization",
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
};

describe("authorizationServerMetadataUrl — RFC 8414 §3.1 well-known placement", () => {
  it("appends the well-known path for a pathless issuer", () => {
    expect(authorizationServerMetadataUrl("https://ai-game.dev")).toBe(
      "https://ai-game.dev/.well-known/oauth-authorization-server",
    );
    expect(authorizationServerMetadataUrl("https://ai-game.dev/")).toBe(
      "https://ai-game.dev/.well-known/oauth-authorization-server",
    );
  });

  it("inserts the well-known segment BETWEEN host and issuer path (not appended to it)", () => {
    expect(authorizationServerMetadataUrl("https://as.example.com/tenant-a")).toBe(
      "https://as.example.com/.well-known/oauth-authorization-server/tenant-a",
    );
  });
});

describe("discoverAuthorizationServer — never throws, always usable", () => {
  it("returns the served metadata and marks it discovered", async () => {
    const { fetchImpl, requests } = scriptedFetch(() => jsonResponse(PRODUCTION_METADATA));
    const result = await discoverAuthorizationServer({ serverBaseUrl: "https://ai-game.dev", fetchImpl });

    expect(result.discovered).toBe(true);
    expect(result.metadata.registration_endpoint).toBe("https://ai-game.dev/oauth/register");
    expect(result.metadata.authorization_endpoint).toBe("https://ai-game.dev/oauth/authorize");
    expect(result.metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(requests[0]!.url).toBe("https://ai-game.dev/.well-known/oauth-authorization-server");
  });

  it("honours non-default endpoints the AS advertises", async () => {
    const { fetchImpl } = scriptedFetch(() =>
      jsonResponse({ registration_endpoint: "https://as.test/v2/register" }),
    );
    const result = await discoverAuthorizationServer({ serverBaseUrl: "https://as.test", fetchImpl });
    expect(result.metadata.registration_endpoint).toBe("https://as.test/v2/register");
    // Members the partial document omitted still fall back to this package's hardcoded paths.
    expect(result.metadata.token_endpoint).toBe("https://as.test/oauth/token");
  });

  it("refuses a document whose issuer contradicts the AS it was fetched for (RFC 8414 §3.3)", async () => {
    const { fetchImpl } = scriptedFetch(() =>
      jsonResponse({
        ...PRODUCTION_METADATA,
        issuer: "https://evil.example",
        token_endpoint: "https://evil.example/oauth/token",
      }),
    );
    const result = await discoverAuthorizationServer({ serverBaseUrl: "https://ai-game.dev", fetchImpl });

    expect(result.discovered).toBe(false);
    // The whole document is discarded, so the endpoint the authorization code and the PKCE
    // code_verifier get POSTed to can never be redirected by a document speaking for someone else.
    expect(result.metadata).toEqual(fallbackAuthorizationServerMetadata("https://ai-game.dev"));
    expect(result.metadata.token_endpoint).toBe("https://ai-game.dev/oauth/token");
  });

  it("treats an issuer differing only by trailing slash or case as identical", async () => {
    for (const issuer of ["https://ai-game.dev/", "https://AI-GAME.dev"]) {
      const { fetchImpl } = scriptedFetch(() => jsonResponse({ ...PRODUCTION_METADATA, issuer }));
      const result = await discoverAuthorizationServer({ serverBaseUrl: "https://ai-game.dev", fetchImpl });
      expect(result.discovered).toBe(true);
    }
  });

  it.each([
    ["a 404", () => new Response("nope", { status: 404 })],
    ["a non-JSON body", () => new Response("<html>hi</html>", { status: 200 })],
    ["a JSON array (not an object)", () => jsonResponse([1, 2, 3])],
    [
      "a network error",
      () => {
        throw new Error("fetch failed");
      },
    ],
  ])("falls back to the hardcoded paths on %s", async (_label, handler) => {
    const { fetchImpl } = scriptedFetch(handler as () => Response);
    const result = await discoverAuthorizationServer({ serverBaseUrl: "https://ai-game.dev", fetchImpl });
    expect(result.discovered).toBe(false);
    expect(result.metadata).toEqual(fallbackAuthorizationServerMetadata("https://ai-game.dev"));
    expect(result.metadata.registration_endpoint).toBe(registrationUrl("https://ai-game.dev"));
  });
});

describe("registerClient — RFC 7591 request/response shape", () => {
  it("POSTs the public-client registration and returns the AS-minted client_id", async () => {
    const { fetchImpl, requests } = scriptedFetch(() =>
      jsonResponse(
        {
          client_id: "agd_client_zdTcbs8MbG_pfWUzDBKuJzLwAxGS0GtF",
          client_name: "AI Game Dev",
          redirect_uris: ["http://127.0.0.1/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_id_issued_at: 1784956127,
        },
        201,
      ),
    );

    const registration = await registerClient({
      registrationEndpoint: "https://ai-game.dev/oauth/register",
      redirectUris: ["http://127.0.0.1/callback"],
      clientName: "AI Game Dev",
      scope: "mcp:agent",
      fetchImpl,
    });

    expect(registration.clientId).toBe("agd_client_zdTcbs8MbG_pfWUzDBKuJzLwAxGS0GtF");
    expect(registration.clientIdIssuedAt).toBe(1784956127);
    expect(registration.registrationEndpoint).toBe("https://ai-game.dev/oauth/register");
    expect(registration.registeredAt).toBeTruthy();

    const request = requests[0]!;
    expect(request.init?.method).toBe("POST");
    const body = JSON.parse(String(request.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_name: "AI Game Dev",
      redirect_uris: ["http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:agent",
    });
  });

  it("defaults client_name to a human-readable product name (shown on the consent screen)", async () => {
    const { fetchImpl, requests } = scriptedFetch(() => jsonResponse({ client_id: "agd_client_x" }, 201));
    await registerClient({
      registrationEndpoint: "https://ai-game.dev/oauth/register",
      redirectUris: ["http://127.0.0.1/callback"],
      fetchImpl,
    });
    const body = JSON.parse(String(requests[0]!.init?.body)) as { client_name?: string };
    expect(body.client_name).toBe(DEFAULT_CLIENT_NAME);
    expect(body.client_name).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/); // never a slug like `ai-game-dev-app`
  });

  it("never persists a client_secret (this flow performs no client authentication)", async () => {
    const { fetchImpl } = scriptedFetch(() =>
      jsonResponse({ client_id: "agd_client_x", client_secret: "super-secret" }, 201),
    );
    const registration = await registerClient({
      registrationEndpoint: "https://ai-game.dev/oauth/register",
      redirectUris: ["http://127.0.0.1/callback"],
      fetchImpl,
    });
    expect(JSON.stringify(registration)).not.toContain("super-secret");
  });

  it("throws ClientRegistrationError carrying the status + error code on a refusal", async () => {
    const { fetchImpl } = scriptedFetch(() =>
      jsonResponse({ error: "invalid_redirect_uri", error_description: "fragment not allowed" }, 400),
    );
    await expect(
      registerClient({
        registrationEndpoint: "https://ai-game.dev/oauth/register",
        redirectUris: ["http://127.0.0.1/callback#frag"],
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "ClientRegistrationError",
      status: 400,
      errorCode: "invalid_redirect_uri",
    });
  });

  it("throws when the AS returns 2xx without a client_id", async () => {
    const { fetchImpl } = scriptedFetch(() => jsonResponse({ client_name: "nope" }, 201));
    await expect(
      registerClient({
        registrationEndpoint: "https://ai-game.dev/oauth/register",
        redirectUris: ["http://127.0.0.1/callback"],
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ClientRegistrationError);
  });
});

describe("ClientRegistrationStore — durable, per-authorization-server, fault-tolerant", () => {
  const REGISTRATION: ClientRegistration = {
    clientId: "agd_client_prod",
    clientName: "AI Game Dev",
    redirectUris: ["http://127.0.0.1/callback"],
  };

  it("round-trips a registration and stamps the schema version", () => {
    const dir = freshDir();
    const store = new ClientRegistrationStore(dir);
    store.save("https://ai-game.dev", REGISTRATION);

    expect(store.read("https://ai-game.dev")).toMatchObject(REGISTRATION);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, CLIENT_REGISTRATIONS_FILE_NAME), "utf-8")) as {
      version?: number;
    };
    expect(raw.version).toBe(1);
  });

  it("keys by authorization server so dev and production never collide", () => {
    const store = new ClientRegistrationStore(freshDir());
    store.save("https://ai-game.dev", REGISTRATION);
    store.save("http://localhost:8000", { clientId: "agd_client_dev" });

    expect(store.read("https://ai-game.dev")?.clientId).toBe("agd_client_prod");
    expect(store.read("http://localhost:8000")?.clientId).toBe("agd_client_dev");
    expect(store.read("https://other.example")).toBeNull();
  });

  it("normalizes the key: trailing slash and a /mcp hub segment both resolve to the AS root", () => {
    const store = new ClientRegistrationStore(freshDir());
    store.save("https://ai-game.dev", REGISTRATION);

    expect(store.read("https://ai-game.dev/")?.clientId).toBe("agd_client_prod");
    expect(store.read("https://ai-game.dev/mcp")?.clientId).toBe("agd_client_prod");
    expect(registrationStoreKey("https://ai-game.dev/mcp/")).toBe(registrationStoreKey("https://ai-game.dev"));
  });

  it("deletes one entry without disturbing the others", () => {
    const store = new ClientRegistrationStore(freshDir());
    store.save("https://ai-game.dev", REGISTRATION);
    store.save("http://localhost:8000", { clientId: "agd_client_dev" });

    store.delete("https://ai-game.dev");
    expect(store.read("https://ai-game.dev")).toBeNull();
    expect(store.read("http://localhost:8000")?.clientId).toBe("agd_client_dev");
    store.delete("https://ai-game.dev"); // idempotent
  });

  it("reads a missing, empty, or corrupt document as 'not registered' instead of throwing", () => {
    const dir = freshDir();
    const store = new ClientRegistrationStore(dir);
    expect(store.read("https://ai-game.dev")).toBeNull(); // missing

    fs.writeFileSync(store.registrationsPath, "");
    expect(store.read("https://ai-game.dev")).toBeNull(); // empty

    fs.writeFileSync(store.registrationsPath, "{ this is not json");
    expect(store.read("https://ai-game.dev")).toBeNull(); // corrupt
    expect(store.readAll()).toEqual({});

    // ...and a corrupt document is simply overwritten by the next registration.
    store.save("https://ai-game.dev", REGISTRATION);
    expect(store.read("https://ai-game.dev")?.clientId).toBe("agd_client_prod");
  });

  it("drops malformed entries that carry no clientId", () => {
    const dir = freshDir();
    const store = new ClientRegistrationStore(dir);
    fs.writeFileSync(
      store.registrationsPath,
      JSON.stringify({ version: 1, clients: { "https://ai-game.dev": { clientName: "no id" } } }),
    );
    expect(store.read("https://ai-game.dev")).toBeNull();
  });

  it.runIf(process.platform !== "win32")("restricts the document to the owner (0600) on POSIX", () => {
    const store = new ClientRegistrationStore(freshDir());
    store.save("https://ai-game.dev", REGISTRATION);
    expect(fs.statSync(store.registrationsPath).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind", () => {
    const dir = freshDir();
    const store = new ClientRegistrationStore(dir);
    store.save("https://ai-game.dev", REGISTRATION);
    store.save("http://localhost:8000", { clientId: "agd_client_dev" });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("resolveClientRegistration — discover → reuse → register", () => {
  function registrarFetch(idPrefix = "agd_client_") {
    let seq = 0;
    return scriptedFetch((url) => {
      if (url.includes("/.well-known/")) return jsonResponse(PRODUCTION_METADATA);
      if (url.endsWith("/oauth/register")) return jsonResponse({ client_id: `${idPrefix}${++seq}` }, 201);
      return new Response("not found", { status: 404 });
    });
  }

  it("registers once on a cold store and persists the minted id", async () => {
    const store = new MemoryRegistrationStore();
    const { fetchImpl } = registrarFetch();

    const resolved = await resolveClientRegistration({
      serverBaseUrl: "https://ai-game.dev",
      redirectUris: ["http://127.0.0.1/callback"],
      store,
      fetchImpl,
    });

    expect(resolved.reused).toBe(false);
    expect(resolved.clientId).toBe("agd_client_1");
    expect(store.read("https://ai-game.dev")?.clientId).toBe("agd_client_1");
    expect(resolved.metadata.registration_endpoint).toBe("https://ai-game.dev/oauth/register");
  });

  it("reuses the stored registration on the next call — no second registration", async () => {
    const store = new MemoryRegistrationStore();
    const { fetchImpl, requests } = registrarFetch();
    const options = {
      serverBaseUrl: "https://ai-game.dev",
      redirectUris: ["http://127.0.0.1/callback"],
      store,
      fetchImpl,
    };

    const first = await resolveClientRegistration(options);
    const second = await resolveClientRegistration(options);

    expect(second.reused).toBe(true);
    expect(second.clientId).toBe(first.clientId);
    expect(requests.filter((r) => r.url.endsWith("/oauth/register"))).toHaveLength(1);
  });

  it("forceRegister discards the cached registration and mints a fresh one", async () => {
    const store = new MemoryRegistrationStore();
    const { fetchImpl } = registrarFetch();
    const options = {
      serverBaseUrl: "https://ai-game.dev",
      redirectUris: ["http://127.0.0.1/callback"],
      store,
      fetchImpl,
    };

    const first = await resolveClientRegistration(options);
    const second = await resolveClientRegistration({ ...options, forceRegister: true });

    expect(second.clientId).not.toBe(first.clientId);
    expect(store.read("https://ai-game.dev")?.clientId).toBe(second.clientId);
  });

  it("re-registers when the cached entry does not cover the required redirect URI", async () => {
    const store = new MemoryRegistrationStore();
    store.save("https://ai-game.dev", {
      clientId: "agd_client_old",
      redirectUris: ["http://127.0.0.1/other-callback"],
    });
    const { fetchImpl } = registrarFetch();

    const resolved = await resolveClientRegistration({
      serverBaseUrl: "https://ai-game.dev",
      redirectUris: ["http://127.0.0.1/callback"],
      store,
      fetchImpl,
    });

    expect(resolved.reused).toBe(false);
    expect(resolved.clientId).toBe("agd_client_1");
  });

  it("skips its own discovery when metadata is supplied", async () => {
    const { fetchImpl, requests } = registrarFetch();
    await resolveClientRegistration({
      serverBaseUrl: "https://ai-game.dev",
      redirectUris: ["http://127.0.0.1/callback"],
      store: new MemoryRegistrationStore(),
      metadata: PRODUCTION_METADATA,
      fetchImpl,
    });
    expect(requests.some((r) => r.url.includes("/.well-known/"))).toBe(false);
  });

  it("still signs in when the store cannot be written (degrades to re-registering next launch)", async () => {
    const store = new MemoryRegistrationStore();
    const save = vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    const { fetchImpl } = registrarFetch();

    const resolved = await resolveClientRegistration({
      serverBaseUrl: "https://ai-game.dev",
      redirectUris: ["http://127.0.0.1/callback"],
      store,
      fetchImpl,
    });

    expect(resolved.clientId).toBe("agd_client_1");
    expect(save).toHaveBeenCalled();
  });

  it("propagates a registration refusal to the caller", async () => {
    const { fetchImpl } = scriptedFetch((url) => {
      if (url.includes("/.well-known/")) return jsonResponse(PRODUCTION_METADATA);
      return jsonResponse({ error: "invalid_client_metadata" }, 400);
    });
    await expect(
      resolveClientRegistration({
        serverBaseUrl: "https://ai-game.dev",
        redirectUris: ["http://127.0.0.1/callback"],
        store: new MemoryRegistrationStore(),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(ClientRegistrationError);
  });
});
