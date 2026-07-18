import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  downloadServer,
  serverDownloadUrl,
  serverChecksumsUrl,
  serverZipAssetName,
  unityAdapter,
} from "../src/index.js";
import { makeZip } from "./zip-builder.js";

const VERSION = "9.1.0";
const RID = "linux-x64";
const EXE = "gamedev-mcp-server"; // os:'linux' → no .exe

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-server-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fetch mock serving a zip (+ correct SHA256SUMS by default) from the release URLs. */
function makeFetch(zip: Buffer, opts: { manifest?: string | null; badDigest?: boolean } = {}): typeof fetch {
  const digest = opts.badDigest ? "0".repeat(64) : createHash("sha256").update(zip).digest("hex");
  const manifest = opts.manifest ?? `${digest}  ${serverZipAssetName(RID)}\n`;
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === serverDownloadUrl(RID, VERSION)) {
      return new Response(zip, { status: 200 });
    }
    if (url === serverChecksumsUrl(VERSION)) {
      if (opts.manifest === null) return new Response("nope", { status: 404 });
      return new Response(manifest, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

const serverZip = () => makeZip({ [EXE]: "#!binary", "appsettings.json": "{}", "NLog.config": "<nlog/>" });

describe("server-download — SHA256SUMS fail-closed gate", () => {
  it("downloads, verifies, extracts the binary + sidecars, and writes the version marker", async () => {
    const res = await downloadServer({
      adapter: unityAdapter,
      projectDir: tmp,
      version: VERSION,
      os: "linux",
      arch: "x64",
      fetchImpl: makeFetch(serverZip()),
    });
    expect(res.kind).toBe("success");
    if (res.kind !== "success") return;
    expect(res.source).toBe("download");
    expect(res.verified).toBe(true);
    expect(fs.existsSync(res.serverPath)).toBe(true);
    const installDir = path.dirname(res.serverPath);
    expect(fs.existsSync(path.join(installDir, "appsettings.json"))).toBe(true);
    expect(fs.readFileSync(path.join(installDir, "version"), "utf-8")).toBe(VERSION);
  });

  it("REFUSES to extract on a digest mismatch (no binary installed)", async () => {
    const res = await downloadServer({
      adapter: unityAdapter,
      projectDir: tmp,
      version: VERSION,
      os: "linux",
      arch: "x64",
      fetchImpl: makeFetch(serverZip(), { badDigest: true }),
    });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") expect(res.error.message).toMatch(/did not match|fail-closed/);
    expect(fs.existsSync(unityAdapter.serverBinaryPath(tmp, "linux", "x64"))).toBe(false);
  });

  it("fails closed when the SHA256SUMS manifest cannot be fetched", async () => {
    const res = await downloadServer({
      adapter: unityAdapter,
      projectDir: tmp,
      version: VERSION,
      os: "linux",
      arch: "x64",
      fetchImpl: makeFetch(serverZip(), { manifest: null }),
    });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") expect(res.error.message).toMatch(/unverified|fail-closed/);
  });

  it("reuses a cached binary whose version marker matches", async () => {
    const first = await downloadServer({
      adapter: unityAdapter, projectDir: tmp, version: VERSION, os: "linux", arch: "x64", fetchImpl: makeFetch(serverZip()),
    });
    expect(first.kind).toBe("success");
    const second = await downloadServer({
      adapter: unityAdapter,
      projectDir: tmp,
      version: VERSION,
      os: "linux",
      arch: "x64",
      // A fetch that would 404 everything — proving the cache hit did no network.
      fetchImpl: (async () => new Response("x", { status: 404 })) as typeof fetch,
    });
    expect(second.kind === "success" && second.source).toBe("cache");
  });

  it("--server-source installs a local zip WITHOUT the checksum gate (trusted artifact)", async () => {
    const zipPath = path.join(tmp, "local-server.zip");
    fs.writeFileSync(zipPath, serverZip());
    const res = await downloadServer({
      adapter: unityAdapter,
      projectDir: tmp,
      version: VERSION,
      os: "linux",
      arch: "x64",
      source: zipPath,
      fetchImpl: (async () => new Response("x", { status: 404 })) as typeof fetch,
    });
    expect(res.kind === "success" && res.source).toBe("source");
    if (res.kind === "success") expect(res.verified).toBe(false);
  });

  it("requires a pinned version", async () => {
    const res = await downloadServer({ adapter: unityAdapter, projectDir: tmp, version: "" });
    expect(res.kind).toBe("failure");
  });
});
