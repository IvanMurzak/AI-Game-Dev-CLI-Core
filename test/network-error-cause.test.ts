import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  ClientRegistrationError,
  HttpTokenRefresher,
  MCP_AGENT_SCOPE,
  authCodeLogin,
  describeErrorWithCause,
  deviceLogin,
  registerClient,
  type ClientRegistration,
  type ClientRegistrationStoreLike,
  type DeviceAuthTransport,
} from "../src/index.js";

/**
 * GlitchTip desktop #364: twenty sign-in failures from two machines reached telemetry as
 * `Cannot reach the authorization server: Could not reach the client registration endpoint: fetch
 * failed` — and nothing else. undici reports EVERY transport failure as `TypeError: fetch failed`
 * and keeps the errno + address only on `err.cause`, which `err.message` discarded, so a DNS
 * failure, a refused connection, a TLS-intercepting proxy and a happy-eyeballs abort were
 * indistinguishable. These tests pin that the cause now survives into the user/telemetry message.
 */

/**
 * The exact shape undici raised in the reproduction of #364 (Electron 43 / Node 24.17, a server
 * ~280 ms away, an unusable second address family): Node's happy-eyeballs connect aborted the IPv4
 * attempt at its 250 ms default and the IPv6 one failed, rejecting with an AggregateError whose own
 * message is EMPTY — the per-address attempts are the whole story.
 */
function happyEyeballsFetchFailure(): TypeError {
  const v4 = Object.assign(new Error("connect ETIMEDOUT 51.81.222.213:443"), { code: "ETIMEDOUT" });
  const v6 = Object.assign(new Error("connect ENETUNREACH 2604:2dc0:202:300::89f:443"), {
    code: "ENETUNREACH",
  });
  const aggregate = Object.assign(new AggregateError([v4, v6], ""), { code: "ETIMEDOUT" });
  return new TypeError("fetch failed", { cause: aggregate });
}

const rejectingFetch = (async () => {
  throw happyEyeballsFetchFailure();
}) as typeof fetch;

class MemoryRegistrationStore implements ClientRegistrationStoreLike {
  read(): ClientRegistration | null {
    return null;
  }
  save(): void {}
  clear(): void {}
}

/** A localhost port with nothing listening on it — a REAL refused connection, no mocks. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("describeErrorWithCause", () => {
  it("renders the happy-eyeballs AggregateError: code and every attempted address", () => {
    const text = describeErrorWithCause(happyEyeballsFetchFailure());
    expect(text).toBe(
      "fetch failed (cause: AggregateError ETIMEDOUT [connect ETIMEDOUT 51.81.222.213:443; " +
        "connect ENETUNREACH 2604:2dc0:202:300::89f:443])",
    );
  });

  it("is just the message when there is no cause, and survives non-Errors and cycles", () => {
    expect(describeErrorWithCause(new Error("plain"))).toBe("plain");
    expect(describeErrorWithCause("a string")).toBe("a string");
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(describeErrorWithCause(a)).toBe("a (cause: Error: b)");
  });
});

describe("the sign-in path keeps the transport cause (GlitchTip #364)", () => {
  it("authCodeLogin over REAL undici fetch names the errno and the address it could not reach", async () => {
    const port = await closedPort();
    const result = await authCodeLogin({
      serverBaseUrl: `http://127.0.0.1:${port}`,
      scope: MCP_AGENT_SCOPE,
      registrationStore: new MemoryRegistrationStore(),
      openBrowser: () => {
        throw new Error("the browser must not open when the AS is unreachable");
      },
      timeoutMs: 4000,
    });

    expect(result).toMatchObject({ ok: false, reason: "error" });
    if (result.ok) return;
    expect(result.message).toMatch(
      new RegExp(
        "^Cannot reach the authorization server: Could not reach the client registration endpoint: " +
          `fetch failed \\(cause: .*ECONNREFUSED.*127\\.0\\.0\\.1:${port}`,
      ),
    );
  });

  it("registerClient carries the happy-eyeballs detail into ClientRegistrationError", async () => {
    const error = await registerClient({
      registrationEndpoint: "https://ai-game.dev/oauth/register",
      redirectUris: ["http://127.0.0.1/callback"],
      fetchImpl: rejectingFetch,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ClientRegistrationError);
    expect((error as Error).message).toContain("connect ETIMEDOUT 51.81.222.213:443");
    expect((error as Error).message).toContain("ENETUNREACH");
  });

  it("deviceLogin keeps the cause too", async () => {
    const transport: DeviceAuthTransport = {
      requestDeviceCode: async () => {
        throw happyEyeballsFetchFailure();
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
    expect(result.message).toMatch(/^Cannot reach the authorization server: fetch failed \(cause: AggregateError ETIMEDOUT/);
  });

  it("a refresh that cannot connect reports the cause, not a bare `fetch failed`", async () => {
    const refresher = new HttpTokenRefresher({
      defaultServerBaseUrl: "https://ai-game.dev",
      fetchImpl: rejectingFetch,
    });
    const result = await refresher.refresh({ refreshToken: "rt", clientId: "agd_client_x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("connect ETIMEDOUT 51.81.222.213:443");
  });
});
