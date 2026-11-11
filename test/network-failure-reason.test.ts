import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyToolFailure, networkFailureReason } from "../src/index.js";

const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code });
const fetchFailed = (cause: unknown, message = "fetch failed"): Error => new TypeError(message, { cause });

describe("networkFailureReason", () => {
  it("reads the code on the error, on its cause chain, and on an AggregateError's attempts", () => {
    expect(networkFailureReason(coded("ECONNREFUSED"))).toBe("connection-refused");
    expect(networkFailureReason(fetchFailed(coded("ECONNREFUSED")))).toBe("connection-refused");
    expect(networkFailureReason(fetchFailed(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")])))).toBe("connection-refused");
    expect(networkFailureReason(fetchFailed(coded("ENOTFOUND")))).toBe("network-error");
    expect(networkFailureReason(fetchFailed(coded("UND_ERR_CONNECT_TIMEOUT")))).toBe("network-error");
  });

  it("calls every dropped connection a reset", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CLOSED", "ERR_STREAM_PREMATURE_CLOSE"]) {
      expect(networkFailureReason(fetchFailed(coded(code))), code).toBe("connection-reset");
    }
    // Node's http client: "socket hang up" carries ECONNRESET; undici mid-body: "terminated" <- "other side closed".
    expect(networkFailureReason(coded("ECONNRESET", "socket hang up"))).toBe("connection-reset");
    expect(networkFailureReason(fetchFailed(coded("UND_ERR_SOCKET", "other side closed"), "terminated"))).toBe("connection-reset");
  });

  it("is undefined for anything that is not a network failure, and never throws", () => {
    expect(networkFailureReason(new DOMException("aborted", "AbortError"))).toBeUndefined();
    expect(networkFailureReason(new TypeError("x is not a function"))).toBeUndefined();
    expect(networkFailureReason(coded("constructor"))).toBeUndefined();
    expect(networkFailureReason("ECONNRESET")).toBeUndefined();
    expect(networkFailureReason(null)).toBeUndefined();
    const cyclic = new Error("loop") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(networkFailureReason(cyclic)).toBeUndefined();
    const hostile = { get code(): string { throw new Error("boom"); } };
    expect(networkFailureReason(hostile)).toBeUndefined();
  });

  it("maps to exit 7 UNREACHABLE through the shared table", () => {
    expect(classifyToolFailure({ reason: networkFailureReason(fetchFailed(coded("UND_ERR_SOCKET")))! })).toEqual({ exitCode: 7, code: "UNREACHABLE" });
  });
});

describe("networkFailureReason on real dropped connections (Node fetch)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/before-headers") return void req.socket.destroy();
        if (req.url === "/rst") return void req.socket.resetAndDestroy();
        // Headers and part of the body, then the socket goes away.
        res.writeHead(200, { "content-type": "application/json", "content-length": "200" });
        res.write('{"status":"succ');
        setTimeout(() => req.socket.destroy(), 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function thrown(path: string): Promise<unknown> {
    try {
      const response = await fetch(`${base}${path}`, { method: "POST", body: "{}" });
      await response.text();
    } catch (err) {
      return err;
    }
    throw new Error(`${path}: no error`);
  }

  it("before the headers, in the middle of the body, and on a reset", async () => {
    expect(networkFailureReason(await thrown("/before-headers"))).toBe("connection-reset");
    expect(networkFailureReason(await thrown("/mid-body"))).toBe("connection-reset");
    expect(networkFailureReason(await thrown("/rst"))).toBe("connection-reset");
  });

  it("a closed port is refused", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const err = await fetch(`http://127.0.0.1:${port}/`).then(() => undefined, (e: unknown) => e);
    expect(networkFailureReason(err)).toBe("connection-refused");
  }, 20_000); // Windows retries a refused loopback connect for about 2 s
});
