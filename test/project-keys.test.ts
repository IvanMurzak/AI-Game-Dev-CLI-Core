import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HttpProjectKeyTransport,
  MachineCredentialProvider,
  MachineCredentialStore,
  PROJECT_KEYS_FILE_NAME,
  ProjectKeyStore,
  defaultCredentialCodec,
  dpapiCredentialCodec,
  getOrMintProjectKey,
  identityCredentialCodec,
  projectKeyCacheKey,
  regenerateProjectKey,
  type CredentialCodec,
  type MachineCredentials,
  type ProjectKeyMintRequest,
  type ProjectKeyMintResult,
  type ProjectKeyRevokeResult,
  type ProjectKeyTransport,
  type ProjectKeyValidation,
  type TokenRefresher,
} from "../src/index.js";

const isWindows = process.platform === "win32";
const ISSUER = "https://ai-game.dev";
const PIN = "34ea75f2";
const created: string[] = [];

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-pk-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length) fs.rmSync(created.pop()!, { recursive: true, force: true });
});

/** A fake JWT whose payload carries `sub` (never verified client-side). */
function jwt(sub: string, tag: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ sub, tag })}.sig`;
}

const AGENT_TOKEN = jwt("usr_alice", "agent");
const PLUGIN_TOKEN = jwt("usr_alice", "plugin");
const FAR = new Date(Date.now() + 3_600_000).toISOString();

function signedInDoc(overrides: Partial<MachineCredentials> = {}): MachineCredentials {
  return {
    version: 2,
    serverTarget: ISSUER,
    families: {
      agent: { accessToken: AGENT_TOKEN, refreshToken: "rt-agent", expiresAt: FAR, clientId: "agd-app", scope: "mcp:agent" },
      plugin: { accessToken: PLUGIN_TOKEN, refreshToken: "rt-plugin", expiresAt: FAR, clientId: "unity-mcp-cli", scope: "mcp:plugin" },
    },
    ...overrides,
  };
}

const noRefresh: TokenRefresher = { refresh: async () => ({ ok: false, reason: "unused" }) };

function provider(doc: MachineCredentials | null, refresher: TokenRefresher = noRefresh): MachineCredentialProvider {
  const store = new MachineCredentialStore(freshDir(), identityCredentialCodec);
  if (doc) store.write(doc);
  return new MachineCredentialProvider(store, refresher);
}

/** A scripted transport recording every call. */
function fakeTransport(opts: {
  validate?: ProjectKeyValidation;
  mint?: (req: ProjectKeyMintRequest, n: number) => ProjectKeyMintResult;
  revoke?: ProjectKeyRevokeResult;
} = {}): ProjectKeyTransport & {
  mints: ProjectKeyMintRequest[];
  validations: string[];
  revokes: Array<{ issuer: string; accessToken: string; keyId: string }>;
} {
  const mints: ProjectKeyMintRequest[] = [];
  const validations: string[] = [];
  const revokes: Array<{ issuer: string; accessToken: string; keyId: string }> = [];
  return {
    mints,
    validations,
    revokes,
    async revoke(issuer, accessToken, keyId) {
      revokes.push({ issuer, accessToken, keyId });
      return opts.revoke ?? { ok: true };
    },
    async mint(req) {
      mints.push(req);
      return opts.mint
        ? opts.mint(req, mints.length)
        : { ok: true, minted: { key: `agd_pk_minted${mints.length}`, keyId: `k${mints.length}`, pin: req.pin, createdAt: "2026-09-23T00:00:00Z" } };
    },
    async validate(_issuer, key) {
      validations.push(key);
      return opts.validate ?? "valid";
    },
  };
}

function seedCache(store: ProjectKeyStore, sub = "usr_alice"): void {
  store.put({ key: "agd_pk_cached", keyId: "k0", pin: PIN, issuer: ISSUER, sub, engine: "unity", createdAt: "2026-09-01T00:00:00Z" });
}

describe("ProjectKeyStore — ~/.ai-game-dev/project-keys.json (contract §6)", () => {
  it("keys entries by <issuerOrigin>#<pin> (origin + lowercase pin, trailing slash/path ignored)", () => {
    expect(projectKeyCacheKey("https://ai-game.dev", "34EA75F2")).toBe("https://ai-game.dev#34ea75f2");
    expect(projectKeyCacheKey("https://ai-game.dev/", PIN)).toBe(`https://ai-game.dev#${PIN}`);
    expect(projectKeyCacheKey("https://ai-game.dev/mcp", PIN)).toBe(`https://ai-game.dev#${PIN}`);
  });

  it("writes the contract §6 plain JSON shape and reads it back", () => {
    const dir = freshDir();
    const store = new ProjectKeyStore(dir, identityCredentialCodec);
    expect(store.filePath).toBe(path.join(dir, PROJECT_KEYS_FILE_NAME));
    seedCache(store);
    const doc = JSON.parse(fs.readFileSync(store.filePath, "utf-8"));
    expect(doc).toEqual({
      version: 1,
      keys: {
        [`${ISSUER}#${PIN}`]: {
          key: "agd_pk_cached",
          keyId: "k0",
          pin: PIN,
          issuer: ISSUER,
          sub: "usr_alice",
          engine: "unity",
          createdAt: "2026-09-01T00:00:00Z",
        },
      },
    });
    expect(store.get(ISSUER, PIN)?.key).toBe("agd_pk_cached");
    expect(store.get(ISSUER, "00000000")).toBeUndefined();
    expect(store.get("https://other.example", PIN)).toBeUndefined();
  });

  it("preserves unknown top-level fields, other entries, and their unknown fields", () => {
    const dir = freshDir();
    const other = { key: "agd_pk_other", keyId: "x", pin: "aaaaaaaa", issuer: ISSUER, futureField: { a: 1 } };
    fs.writeFileSync(
      path.join(dir, PROJECT_KEYS_FILE_NAME),
      JSON.stringify({ version: 1, writer: "csharp", keys: { [`${ISSUER}#aaaaaaaa`]: other } }),
    );
    const store = new ProjectKeyStore(dir, identityCredentialCodec);
    seedCache(store);
    const doc = JSON.parse(fs.readFileSync(store.filePath, "utf-8"));
    expect(doc.writer).toBe("csharp");
    expect(doc.keys[`${ISSUER}#aaaaaaaa`]).toEqual(other);
    expect(doc.keys[`${ISSUER}#${PIN}`].key).toBe("agd_pk_cached");
  });

  it("a replacing put never inherits a KNOWN field (sub/engine/createdAt) from the replaced entry", () => {
    const dir = freshDir();
    const store = new ProjectKeyStore(dir, identityCredentialCodec);
    seedCache(store, "usr_previous_account");
    store.put({ key: "agd_pk_new", keyId: "k1", pin: PIN, issuer: ISSUER });
    const doc = JSON.parse(fs.readFileSync(store.filePath, "utf-8"));
    expect(doc.keys[`${ISSUER}#${PIN}`]).toEqual({ key: "agd_pk_new", keyId: "k1", pin: PIN, issuer: ISSUER });
  });

  it("applies the at-rest codec to the whole document and leaves no temp litter", () => {
    const dir = freshDir();
    const xor: CredentialCodec = {
      encrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
      decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
    };
    const store = new ProjectKeyStore(dir, xor);
    seedCache(store);
    const raw = fs.readFileSync(store.filePath);
    expect(raw.includes(Buffer.from("agd_pk_cached"))).toBe(false);
    expect(JSON.parse(xor.decrypt(raw).toString("utf-8")).keys[`${ISSUER}#${PIN}`].key).toBe("agd_pk_cached");
    expect(store.get(ISSUER, PIN)?.key).toBe("agd_pk_cached");
    expect(fs.readdirSync(dir)).toEqual([PROJECT_KEYS_FILE_NAME]);
  });

  it.skipIf(isWindows)("is owner-only on POSIX (0600 file)", () => {
    const store = new ProjectKeyStore(freshDir(), identityCredentialCodec);
    seedCache(store);
    expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600);
  });

  // On Windows every DPAPI transform is a PowerShell spawn (~1.5–2 s each, four here) — same budget
  // as the DPAPI cross-implementation suite.
  it("uses the credential store's platform codec by default (DPAPI on Windows, identity on POSIX)", { timeout: 30_000 }, () => {
    const store = new ProjectKeyStore(freshDir());
    seedCache(store);
    const raw = fs.readFileSync(store.filePath);
    const plain = defaultCredentialCodec.decrypt(raw).toString("utf-8");
    expect(JSON.parse(plain).keys[`${ISSUER}#${PIN}`].key).toBe("agd_pk_cached");
    if (isWindows) {
      // Same envelope as credentials.json: raw DPAPI bytes, not plaintext.
      expect(raw.includes(Buffer.from("agd_pk_cached"))).toBe(false);
      expect(JSON.parse(dpapiCredentialCodec.decrypt(raw).toString("utf-8")).version).toBe(1);
    } else {
      expect(raw.toString("utf-8")).toBe(plain);
    }
  });

  it("never overwrites an unreadable cache (put throws, bytes untouched)", () => {
    const dir = freshDir();
    const file = path.join(dir, PROJECT_KEYS_FILE_NAME);
    fs.writeFileSync(file, "{not json");
    const store = new ProjectKeyStore(dir, identityCredentialCodec);
    expect(store.readState().status).toBe("unreadable");
    expect(store.get(ISSUER, PIN)).toBeUndefined();
    expect(() => seedCache(store)).toThrow(/unreadable/);
    expect(fs.readFileSync(file, "utf-8")).toBe("{not json");
  });
});

describe("getOrMintProjectKey — the §6 get-or-mint rule", () => {
  function setup(doc: MachineCredentials | null = signedInDoc(), refresher?: TokenRefresher) {
    const credentials = provider(doc, refresher);
    const store = new ProjectKeyStore(freshDir(), identityCredentialCodec);
    return { credentials, store };
  }

  it("mints with the machine access token, caches the entry, and returns it", async () => {
    const { credentials, store } = setup();
    const transport = fakeTransport();
    const res = await getOrMintProjectKey({
      pin: PIN, engine: "unity", issuer: ISSUER, machineName: "box", label: "/p/game", credentials, store, transport,
    });
    expect(res).toMatchObject({ kind: "ok", key: "agd_pk_minted1", keyId: "k1", source: "minted" });
    expect(transport.mints).toHaveLength(1);
    // The agent family is presented first (agent → plugin → legacy).
    expect(transport.mints[0]).toEqual({
      issuer: ISSUER, accessToken: AGENT_TOKEN, pin: PIN, engine: "unity", machineName: "box", label: "/p/game",
    });
    expect(store.get(ISSUER, PIN)).toMatchObject({ key: "agd_pk_minted1", keyId: "k1", sub: "usr_alice", engine: "unity" });
  });

  it("falls back to the plugin family when there is no agent family", async () => {
    const doc = signedInDoc();
    delete doc.families!.agent;
    const { credentials, store } = setup(doc);
    const transport = fakeTransport();
    await getOrMintProjectKey({ pin: PIN, engine: "godot", issuer: ISSUER, credentials, store, transport });
    expect(transport.mints[0]!.accessToken).toBe(PLUGIN_TOKEN);
  });

  it("reuses a cached key of the same account that the server still accepts — no mint", async () => {
    const { credentials, store } = setup();
    seedCache(store);
    const transport = fakeTransport({ validate: "valid" });
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res).toMatchObject({ kind: "ok", key: "agd_pk_cached", source: "reused" });
    expect(transport.validations).toEqual(["agd_pk_cached"]);
    expect(transport.mints).toHaveLength(0);
  });

  it("reuses the cached key on a TRANSIENT validation failure", async () => {
    const { credentials, store } = setup();
    seedCache(store);
    const transport = fakeTransport({ validate: "transient" });
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res).toMatchObject({ kind: "ok", key: "agd_pk_cached", source: "reused" });
    expect(transport.mints).toHaveLength(0);
  });

  it("re-mints and overwrites the entry when the server rejects the cached key (401)", async () => {
    const { credentials, store } = setup();
    seedCache(store);
    const transport = fakeTransport({ validate: "invalid" });
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res).toMatchObject({ kind: "ok", key: "agd_pk_minted1", source: "minted" });
    expect(store.get(ISSUER, PIN)?.key).toBe("agd_pk_minted1");
  });

  it("re-mints (without validating) when the cached key belongs to another account", async () => {
    const { credentials, store } = setup();
    seedCache(store, "usr_bob");
    const transport = fakeTransport();
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res).toMatchObject({ kind: "ok", key: "agd_pk_minted1" });
    expect(transport.validations).toHaveLength(0);
    expect(store.get(ISSUER, PIN)?.sub).toBe("usr_alice");
  });

  it("prefers the stored `subject` over the token's sub claim", async () => {
    const { credentials, store } = setup(signedInDoc({ subject: "usr_stored" }));
    const transport = fakeTransport();
    await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(store.get(ISSUER, PIN)?.sub).toBe("usr_stored");
  });

  it("no machine login ⇒ no-login, nothing minted", async () => {
    const { credentials, store } = setup(null);
    const transport = fakeTransport();
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res.kind).toBe("no-login");
    expect(transport.mints).toHaveLength(0);
  });

  it("never presents a credential issued by ANOTHER server (no token leak) ⇒ no-login", async () => {
    const { credentials, store } = setup(signedInDoc({ serverTarget: "https://staging.ai-game.dev" }));
    const transport = fakeTransport();
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res.kind).toBe("no-login");
    expect(transport.mints).toHaveLength(0);
  });

  it("a mint 401 refreshes the machine credential once and retries with the new token", async () => {
    const refresher: TokenRefresher = {
      refresh: async () => ({ ok: true, accessToken: "fresh-agent", refreshToken: "rt2", expiresAt: FAR }),
    };
    const { credentials, store } = setup(signedInDoc(), refresher);
    const transport = fakeTransport({
      mint: (req, n) =>
        n === 1
          ? { ok: false, status: 401, reason: "HTTP 401" }
          : { ok: true, minted: { key: "agd_pk_retry", keyId: "k2", pin: req.pin, createdAt: "t" } },
    });
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res).toMatchObject({ kind: "ok", key: "agd_pk_retry" });
    expect(transport.mints.map((m) => m.accessToken)).toEqual([AGENT_TOKEN, "fresh-agent"]);
  });

  it("a mint failure is an error result and leaves the cache untouched", async () => {
    const { credentials, store } = setup();
    const transport = fakeTransport({ mint: () => ({ ok: false, status: 503, reason: "HTTP 503" }) });
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res.kind).toBe("error");
    expect(store.readState().status).toBe("missing");
  });

  it("an uncacheable (unreadable) store still returns the minted key, with a warning", async () => {
    const { credentials, store } = setup();
    fs.mkdirSync(store.baseDirectory, { recursive: true });
    fs.writeFileSync(store.filePath, "garbage");
    const res = await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport: fakeTransport() });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.warnings.join(" ")).toMatch(/could not be cached/);
    expect(fs.readFileSync(store.filePath, "utf-8")).toBe("garbage");
  });

  it("writes the cache entry while holding the machine credential lock", async () => {
    const { credentials, store } = setup();
    let heldDuringWrite = false;
    const originalPut = store.put.bind(store);
    store.put = (entry) => {
      heldDuringWrite = fs.existsSync(path.join(credentials.store.baseDirectory, "credentials.lock"));
      originalPut(entry);
    };
    await getOrMintProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport: fakeTransport() });
    expect(heldDuringWrite).toBe(true);
  });

  it("rejects a malformed pin without any network call", async () => {
    const { credentials, store } = setup();
    const transport = fakeTransport();
    const res = await getOrMintProjectKey({ pin: "nothex!!", engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res.kind).toBe("error");
    expect(transport.mints).toHaveLength(0);
  });

  it("regenerate: revokePrevious revokes the OLD key id with the mint's access token, only when called", async () => {
    const { credentials, store } = setup();
    seedCache(store);
    const transport = fakeTransport();
    const res = await regenerateProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    if (res.kind !== "ok") throw new Error(res.reason);
    expect(transport.revokes).toHaveLength(0); // deferred until the caller rewrote the configs
    expect(await res.revokePrevious!()).toBeUndefined();
    expect(transport.revokes).toEqual([{ issuer: ISSUER, accessToken: AGENT_TOKEN, keyId: "k0" }]);
  });

  it("regenerate: a revoke failure is a warning string, never a throw", async () => {
    const { credentials, store } = setup();
    seedCache(store);
    const transport = fakeTransport({ revoke: { ok: false, status: 500, reason: "HTTP 500" } });
    const res = await regenerateProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    if (res.kind !== "ok") throw new Error(res.reason);
    expect(await res.revokePrevious!()).toMatch(/k0.*HTTP 500/);
  });

  it("revoke uses the REFRESHED token when the mint needed a 401 retry", async () => {
    const refresher: TokenRefresher = {
      refresh: async () => ({ ok: true, accessToken: "fresh-agent", refreshToken: "rt2", expiresAt: FAR }),
    };
    const { credentials, store } = setup(signedInDoc(), refresher);
    seedCache(store);
    const transport = fakeTransport({
      mint: (req, n) =>
        n === 1 ? { ok: false, status: 401, reason: "HTTP 401" } : { ok: true, minted: { key: "agd_pk_r", keyId: "k9", pin: req.pin, createdAt: "t" } },
    });
    const res = await regenerateProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    if (res.kind !== "ok") throw new Error(res.reason);
    await res.revokePrevious!();
    expect(transport.revokes[0]!.accessToken).toBe("fresh-agent");
  });

  it("get-or-mint NEVER revokes, even when it re-mints over a rejected cached key", async () => {
    const { credentials, store } = setup();
    seedCache(store);
    const res = await getOrMintProjectKey({
      pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport: fakeTransport({ validate: "invalid" }),
    });
    expect(res.kind === "ok" && res.revokePrevious).toBeUndefined();
  });

  it("regenerate with nothing cached has nothing to revoke", async () => {
    const { credentials, store } = setup();
    const res = await regenerateProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport: fakeTransport() });
    expect(res.kind === "ok" && res.revokePrevious).toBeUndefined();
  });

  it("regenerateProjectKey mints even over a valid cached key and overwrites the entry", async () => {
    const { credentials, store } = setup();
    seedCache(store);
    const transport = fakeTransport({ validate: "valid" });
    const res = await regenerateProjectKey({ pin: PIN, engine: "unity", issuer: ISSUER, credentials, store, transport });
    expect(res).toMatchObject({ kind: "ok", key: "agd_pk_minted1", source: "minted" });
    expect(transport.validations).toHaveLength(0);
    expect(store.get(ISSUER, PIN)?.key).toBe("agd_pk_minted1");
  });
});

describe("HttpProjectKeyTransport — the contract §2 wire shape", () => {
  type Call = { url: string; init: RequestInit };
  function fetchStub(status: number, body: unknown, calls: Call[]): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as typeof fetch;
  }
  const req: ProjectKeyMintRequest = {
    issuer: "https://ai-game.dev/", accessToken: "AT", pin: PIN, engine: "unreal", machineName: "box", label: "C:/game",
  };

  it("POSTs {project_pin, engine, machine_name, label} with the access token and parses a 201", async () => {
    const calls: Call[] = [];
    const t = new HttpProjectKeyTransport({
      fetchImpl: fetchStub(201, { key: "agd_pk_abc", key_id: "7", project_pin: PIN, created_at: "2026-09-23T01:02:03Z" }, calls),
    });
    const res = await t.mint(req);
    expect(res).toEqual({ ok: true, minted: { key: "agd_pk_abc", keyId: "7", pin: PIN, createdAt: "2026-09-23T01:02:03Z" } });
    expect(calls[0]!.url).toBe("https://ai-game.dev/api/mcp/project-keys");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer AT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      project_pin: PIN, engine: "unreal", machine_name: "box", label: "C:/game",
    });
  });

  it("maps 400/401 to failures carrying the status", async () => {
    const t400 = new HttpProjectKeyTransport({ fetchImpl: fetchStub(400, { error: "invalid_project_pin" }, []) });
    expect(await t400.mint(req)).toEqual({ ok: false, status: 400, reason: "HTTP 400 invalid_project_pin" });
    const t401 = new HttpProjectKeyTransport({ fetchImpl: fetchStub(401, {}, []) });
    expect(await t401.mint(req)).toMatchObject({ ok: false, status: 401 });
  });

  it("rejects a response that is not an agd_pk_ key or is bound to another pin", async () => {
    const bad = new HttpProjectKeyTransport({ fetchImpl: fetchStub(201, { key: "eyJhbGci", key_id: "1", project_pin: PIN }, []) });
    expect((await bad.mint(req)).ok).toBe(false);
    const other = new HttpProjectKeyTransport({ fetchImpl: fetchStub(201, { key: "agd_pk_x", key_id: "1", project_pin: "ffffffff" }, []) });
    expect((await other.mint(req)).ok).toBe(false);
  });

  it("an invalid pin or issuer is a status-0 failure — never a throw, never a request", async () => {
    const calls: Call[] = [];
    const t = new HttpProjectKeyTransport({ fetchImpl: fetchStub(201, {}, calls) });
    await expect(t.mint({ ...req, pin: "nothex!!" })).resolves.toMatchObject({ ok: false, status: 0 });
    await expect(t.mint({ ...req, issuer: "ai-game.dev" })).resolves.toMatchObject({ ok: false, status: 0, reason: expect.stringContaining("invalid issuer") });
    expect(calls).toHaveLength(0);
  });

  it("a network failure is status 0 (never throws)", async () => {
    const t = new HttpProjectKeyTransport({ fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(await t.mint(req)).toMatchObject({ ok: false, status: 0 });
    expect(await t.validate(ISSUER, "agd_pk_x", PIN)).toBe("transient");
  });

  it("revokes with DELETE …/project-keys/{keyId} and the access token; 2xx/404 ⇒ ok, else a failure", async () => {
    const calls: Call[] = [];
    const t = new HttpProjectKeyTransport({ fetchImpl: fetchStub(204, undefined, calls) });
    expect(await t.revoke("https://ai-game.dev/mcp", "AT", "pk 7")).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("https://ai-game.dev/api/mcp/project-keys/pk%207");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer AT");
    expect(await new HttpProjectKeyTransport({ fetchImpl: fetchStub(404, {}, []) }).revoke(ISSUER, "AT", "x")).toEqual({ ok: true });
    expect(await new HttpProjectKeyTransport({ fetchImpl: fetchStub(403, {}, []) }).revoke(ISSUER, "AT", "x")).toMatchObject({ ok: false, status: 403 });
  });

  it("validates with GET …/current authenticated by the key itself", async () => {
    const calls: Call[] = [];
    const t = new HttpProjectKeyTransport({ fetchImpl: fetchStub(200, { key_id: "7", project_pin: PIN, active: true }, calls) });
    expect(await t.validate(ISSUER, "agd_pk_x", PIN)).toBe("valid");
    expect(calls[0]!.url).toBe("https://ai-game.dev/api/mcp/project-keys/current");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer agd_pk_x");
  });

  it("401 ⇒ invalid; 5xx/404 ⇒ transient; a pin mismatch or active:false ⇒ invalid", async () => {
    const v = (status: number, body: unknown) =>
      new HttpProjectKeyTransport({ fetchImpl: fetchStub(status, body, []) }).validate(ISSUER, "agd_pk_x", PIN);
    expect(await v(401, {})).toBe("invalid");
    expect(await v(503, {})).toBe("transient");
    expect(await v(404, {})).toBe("transient");
    expect(await v(200, { project_pin: "ffffffff", active: true })).toBe("invalid");
    expect(await v(200, { project_pin: PIN, active: false })).toBe("invalid");
  });
});
