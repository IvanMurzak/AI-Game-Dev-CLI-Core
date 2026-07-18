import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ridForPlatform,
  serverExecutableName,
  SERVER_BINARY_BASENAME,
  type EngineAdapter,
} from "./engine-adapter.js";
import {
  serverChecksumsUrl,
  serverDownloadUrl,
  serverZipAssetName,
  verifyZip,
  checksumFailureReason,
  SHA256SUMS_ASSET_NAME,
} from "./server-checksum.js";
import { parseZip } from "./unzip.js";
import { emitProgress, type ProgressCallback } from "./progress.js";

/**
 * Download + install the shared `gamedev-mcp-server` binary into the adapter's install-dir layout — the
 * engine-agnostic port of the CLIs' `download-server` / `install-server`. The install directory comes
 * from the {@link EngineAdapter} ({@link EngineAdapter.serverInstallDir}) so this module has no engine
 * specifics.
 *
 * **Fail-closed integrity gate (verify-before-execute):** the downloaded zip bytes are UNTRUSTED. Before
 * unzipping, the release's `SHA256SUMS` manifest is fetched and the zip's SHA256 (node:crypto) is
 * compared against the manifest entry for THIS RID. On any non-`verified` verdict the binary is NOT
 * extracted and the operation fails — an unverified binary is never executed. The `--server-source`
 * escape hatch (a trusted, user-provided local zip/dir/binary or URL) deliberately SKIPS the gate (the
 * gate can only verify the pinned GitHub release).
 */

/** Attempts (1 + retries) for the `SHA256SUMS` fetch before failing closed. */
const SHA256SUMS_FETCH_ATTEMPTS = 3;

export interface DownloadServerOptions {
  /** The engine adapter (supplies the install-dir layout + server name). */
  adapter: EngineAdapter;
  /** The project root the server installs into. */
  projectDir: string;
  /** The pinned server version to download (REQUIRED — the pin lives in each CLI, not cli-core). */
  version: string;
  /** Offline/CI escape hatch: a local `.zip`, extracted dir, bare binary, or `http(s)://` zip URL. */
  source?: string;
  /** Re-download even when a matching cached binary is present. */
  force?: boolean;
  /** Injectable `fetch` (tests). */
  fetchImpl?: typeof fetch;
  /** Platform/arch overrides (tests / cross-RID). */
  os?: NodeJS.Platform;
  arch?: string;
  onProgress?: ProgressCallback;
}

export type DownloadServerResult =
  | {
      kind: "success";
      serverPath: string;
      source: "download" | "cache" | "source";
      version: string;
      verified: boolean;
      warnings: string[];
    }
  | { kind: "failure"; error: Error; url?: string; warnings: string[] };

/** The version recorded in the install dir's `version` marker, or null. */
export function readVersionMarker(installDir: string): string | null {
  const marker = path.join(installDir, "version");
  try {
    return fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8").trim() : null;
  } catch {
    return null;
  }
}

/** Locate the extracted binary under `stagingDir`, preferring the SHALLOWEST match. Null when absent. */
export function findExtractedBinary(stagingDir: string, executableName: string): string | null {
  let best: string | null = null;
  let bestDepth = Number.MAX_SAFE_INTEGER;
  const walk = (dir: string, depth: number): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name === executableName && depth < bestDepth) {
        best = full;
        bestDepth = depth;
      }
    }
  };
  walk(stagingDir, 1);
  return best;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/** Staging-extract a zip's bytes into `installDir`: unzip → find binary → move binary + sidecars in. */
function extractServerZip(
  zipBytes: Buffer,
  installDir: string,
  exeName: string,
  sourceLabel: string,
  warnings: string[],
): string {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `${SERVER_BINARY_BASENAME}-extract-`));
  try {
    for (const entry of parseZip(zipBytes)) {
      if (entry.isDirectory) continue;
      const target = path.join(stagingDir, entry.path);
      if (target !== stagingDir && !path.resolve(target).startsWith(path.resolve(stagingDir) + path.sep)) {
        warnings.push(`Skipped suspicious zip entry: ${entry.path}`);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.bytes);
    }

    const extractedBinary = findExtractedBinary(stagingDir, exeName);
    if (!extractedBinary) throw new Error(`Server binary '${exeName}' not found inside ${sourceLabel}.`);

    fs.rmSync(installDir, { recursive: true, force: true });
    fs.mkdirSync(installDir, { recursive: true });
    const sourceDir = path.dirname(extractedBinary);
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      fs.renameSync(path.join(sourceDir, entry.name), path.join(installDir, entry.name));
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  const exePath = path.join(installDir, exeName);
  if (!fs.existsSync(exePath)) throw new Error(`Server binary not found after unpack at: ${exePath}`);
  return exePath;
}

/** Install from an already-extracted local directory (or a dir holding a bare binary): copy in. */
function installServerFromDir(sourceDir: string, installDir: string, exeName: string): string {
  const extractedBinary = findExtractedBinary(sourceDir, exeName);
  if (!extractedBinary) throw new Error(`Server binary '${exeName}' not found under source '${sourceDir}'.`);
  fs.rmSync(installDir, { recursive: true, force: true });
  fs.mkdirSync(installDir, { recursive: true });
  const dir = path.dirname(extractedBinary);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(dir, entry.name), path.join(installDir, entry.name));
  }
  const exePath = path.join(installDir, exeName);
  if (!fs.existsSync(exePath)) throw new Error(`Server binary not found after copy at: ${exePath}`);
  return exePath;
}

function finalizeServerInstall(
  exePath: string,
  installDir: string,
  platform: NodeJS.Platform,
  version: string,
  warnings: string[],
): void {
  if (platform !== "win32") {
    try {
      fs.chmodSync(exePath, 0o755);
    } catch (err) {
      warnings.push(`Could not mark the server binary executable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  fs.writeFileSync(path.join(installDir, "version"), version, "utf-8");
}

async function installFromSource(
  source: string,
  installDir: string,
  exeName: string,
  platform: NodeJS.Platform,
  version: string,
  fetchImpl: typeof fetch,
  onProgress: ProgressCallback | undefined,
  warnings: string[],
): Promise<string> {
  const trimmed = source.trim();
  if (isHttpUrl(trimmed)) {
    emitProgress(onProgress, { phase: "start", message: `Fetching server from --server-source URL: ${trimmed}` });
    const response = await fetchImpl(trimmed);
    if (!response.ok) throw new Error(`--server-source download failed: HTTP ${response.status} for ${trimmed}.`);
    const zipBytes = Buffer.from(await response.arrayBuffer());
    const exePath = extractServerZip(zipBytes, installDir, exeName, `the --server-source URL (${trimmed})`, warnings);
    finalizeServerInstall(exePath, installDir, platform, version, warnings);
    return exePath;
  }

  const abs = path.resolve(trimmed);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new Error(`--server-source path does not exist: ${abs}`);
  }

  if (stat.isFile() && abs.toLowerCase().endsWith(".zip")) {
    emitProgress(onProgress, { phase: "start", message: `Extracting server from --server-source zip: ${abs}` });
    const zipBytes = fs.readFileSync(abs);
    const exePath = extractServerZip(zipBytes, installDir, exeName, `the --server-source zip (${abs})`, warnings);
    finalizeServerInstall(exePath, installDir, platform, version, warnings);
    return exePath;
  }

  emitProgress(onProgress, { phase: "start", message: `Installing server from --server-source path: ${abs}` });
  const sourceDir = stat.isDirectory() ? abs : path.dirname(abs);
  const exePath = installServerFromDir(sourceDir, installDir, exeName);
  finalizeServerInstall(exePath, installDir, platform, version, warnings);
  return exePath;
}

async function fetchSha256SumsText(url: string, fetchImpl: typeof fetch, warnings: string[]): Promise<string | null> {
  for (let attempt = 1; attempt <= SHA256SUMS_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return await response.text();
      warnings.push(`${SHA256SUMS_ASSET_NAME} fetch attempt ${attempt}/${SHA256SUMS_FETCH_ATTEMPTS}: HTTP ${response.status}.`);
    } catch (err) {
      warnings.push(
        `${SHA256SUMS_ASSET_NAME} fetch attempt ${attempt}/${SHA256SUMS_FETCH_ATTEMPTS}: ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
  }
  return null;
}

/**
 * Download + install the pinned server. Resolution order:
 *   1. `--server-source` escape hatch → installed WITHOUT the SHA256SUMS gate (trusted user artifact).
 *   2. Cached binary whose `version` marker equals the pin → reused (unless `force`).
 *   3. Download the release zip, VERIFY against `SHA256SUMS` (fail-closed), staging-extract + install.
 * Never throws past the boundary.
 */
export async function downloadServer(opts: DownloadServerOptions): Promise<DownloadServerResult> {
  const warnings: string[] = [];
  let url: string | undefined;
  try {
    if (!opts.projectDir) throw new Error("projectDir is required.");
    if (!opts.version || !opts.version.trim()) throw new Error("A pinned server version is required.");
    const platform = opts.os ?? (os.platform() as NodeJS.Platform);
    const arch = opts.arch ?? process.arch;
    const version = opts.version.trim();
    const installDir = opts.adapter.serverInstallDir(opts.projectDir, platform, arch);
    const exeName = serverExecutableName(platform);
    const exePath = path.join(installDir, exeName);
    const fetchImpl = opts.fetchImpl ?? fetch;

    // 1. --server-source escape hatch (trusted; no checksum gate).
    if (opts.source && opts.source.trim().length > 0) {
      const resolved = await installFromSource(
        opts.source,
        installDir,
        exeName,
        platform,
        version,
        fetchImpl,
        opts.onProgress,
        warnings,
      );
      emitProgress(opts.onProgress, { phase: "file-written", message: `Server ready from --server-source: ${resolved}`, filePath: resolved });
      return { kind: "success", serverPath: resolved, source: "source", version, verified: false, warnings };
    }

    // 2. Cache hit.
    if (!opts.force && fs.existsSync(exePath) && readVersionMarker(installDir) === version) {
      return { kind: "success", serverPath: exePath, source: "cache", version, verified: false, warnings };
    }

    // 3. Download + verify + extract.
    const rid = ridForPlatform(platform, arch);
    url = serverDownloadUrl(rid, version);
    emitProgress(opts.onProgress, { phase: "start", message: `Downloading ${SERVER_BINARY_BASENAME} ${version} (${rid}) from ${url}` });
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(
        `Download failed: HTTP ${response.status} for ${url}. Does the GameDev-MCP-Server v${version} release exist?`,
      );
    }
    const zipBytes = Buffer.from(await response.arrayBuffer());

    const sumsUrl = serverChecksumsUrl(version);
    const sha256SumsText = await fetchSha256SumsText(sumsUrl, fetchImpl, warnings);
    if (sha256SumsText === null) {
      throw new Error(
        `Refusing to install an unverified server: could not download the ${SHA256SUMS_ASSET_NAME} manifest from ${sumsUrl} ` +
          `after ${SHA256SUMS_FETCH_ATTEMPTS} attempt(s). The binary was NOT extracted (fail-closed).`,
      );
    }
    const actualDigest = createHash("sha256").update(zipBytes).digest("hex");
    const assetZipName = serverZipAssetName(rid);
    const verdict = verifyZip(sha256SumsText, assetZipName, actualDigest);
    if (verdict !== "verified") {
      throw new Error(
        `Refusing to install server ${version} for ${rid}: ${checksumFailureReason(verdict, assetZipName)} (fail-closed).`,
      );
    }
    emitProgress(opts.onProgress, { phase: "info", message: `Verified ${assetZipName} against ${SHA256SUMS_ASSET_NAME}.` });

    extractServerZip(zipBytes, installDir, exeName, `the downloaded zip (${url})`, warnings);
    finalizeServerInstall(exePath, installDir, platform, version, warnings);
    emitProgress(opts.onProgress, { phase: "file-written", message: `Server ready: ${exePath} (v${version})`, filePath: exePath });
    return { kind: "success", serverPath: exePath, source: "download", version, verified: true, warnings };
  } catch (err) {
    return { kind: "failure", error: err instanceof Error ? err : new Error(String(err)), url, warnings };
  }
}
