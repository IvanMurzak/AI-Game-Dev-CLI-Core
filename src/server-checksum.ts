import { SERVER_BINARY_BASENAME } from "./engine-adapter.js";

/**
 * Pure (no I/O, no network) download-integrity logic for the shared `gamedev-mcp-server` binary — the
 * port of the CLIs' `server-checksum` seam. {@link verifyZip} is the single fail-closed verdict the
 * downloader calls BETWEEN fetching the zip bytes and unzipping them, so a downloaded server zip is
 * NEVER extracted or executed unless its SHA256 matches the release's published `SHA256SUMS` manifest
 * (a compromised release asset or a trusted-CA MITM would otherwise yield arbitrary code execution).
 * Keeping this pure makes every decision unit-testable with no real download.
 */

/** GitHub repo the server binaries + the `SHA256SUMS` manifest are released from. */
export const SERVER_RELEASE_REPO = "IvanMurzak/GameDev-MCP-Server";

/** The integrity-manifest asset name attached to every release. */
export const SHA256SUMS_ASSET_NAME = "SHA256SUMS";

/** The per-RID server zip asset name, e.g. `gamedev-mcp-server-win-x64.zip`. */
export function serverZipAssetName(rid: string): string {
  return `${SERVER_BINARY_BASENAME}-${rid}.zip`;
}

/** The release-asset download URL for a RID + version (tags are `v`-prefixed). */
export function serverDownloadUrl(rid: string, version: string): string {
  return `https://github.com/${SERVER_RELEASE_REPO}/releases/download/v${version}/${serverZipAssetName(rid)}`;
}

/** The `SHA256SUMS` manifest URL — the sibling of the per-RID zip under the same `v<version>` tag. */
export function serverChecksumsUrl(version: string): string {
  return `https://github.com/${SERVER_RELEASE_REPO}/releases/download/v${version}/${SHA256SUMS_ASSET_NAME}`;
}

function isHex64(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Parse a coreutils `sha256sum` manifest into a `{ filename → lowercase-hex }` map. Tolerates CRLF/LF,
 * blank lines, a single-space or tab separator, and the binary-mode `*` marker. A line whose first
 * token is not 64-hex, or with no filename, is skipped (never produces a spurious entry). On a
 * duplicate filename the last entry wins. Never throws.
 */
export function parseSha256Sums(sha256SumsText: string | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!sha256SumsText) return map;

  for (const rawLine of sha256SumsText.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const sep = /\s/.exec(line);
    if (!sep || sep.index <= 0) continue;

    const digestToken = line.slice(0, sep.index);
    if (!isHex64(digestToken)) continue;

    let fileName = line.slice(sep.index).trimStart();
    if (fileName.startsWith("*")) fileName = fileName.slice(1);
    fileName = fileName.trim();
    if (fileName.length === 0) continue;

    map.set(fileName, digestToken.toLowerCase());
  }
  return map;
}

/** Look up the expected digest for an EXACT asset name (`linux-x64` never matches `linux-arm64`). */
export function lookupDigest(parsed: Map<string, string>, assetZipName: string): string | null {
  if (!parsed || !assetZipName) return null;
  return parsed.get(assetZipName) ?? null;
}

/** Case-insensitive hex-digest equality; an empty digest on either side is NEVER a match (fail-closed). */
export function verifyDigest(expected: string | null | undefined, actual: string | null | undefined): boolean {
  const e = (expected ?? "").trim();
  const a = (actual ?? "").trim();
  if (e.length === 0 || a.length === 0) return false;
  return e.toLowerCase() === a.toLowerCase();
}

/** The verdict of verifying a downloaded zip against a release `SHA256SUMS` manifest. */
export type ChecksumVerdict =
  | "verified"
  | "manifest-unparsable"
  | "missing-entry"
  | "digest-mismatch";

/**
 * The single fail-closed integrity decision the downloader calls BEFORE unzipping: parse `SHA256SUMS`,
 * find the entry for `assetZipName`, compare (case-insensitive hex) to the downloaded zip's SHA256.
 * Returns `'verified'` ONLY when the manifest parsed, contained the asset, and the digest matched;
 * every other outcome is a distinct fail-closed verdict the caller MUST treat as "do NOT extract".
 */
export function verifyZip(
  sha256SumsText: string | null | undefined,
  assetZipName: string,
  actualZipHexDigest: string | null | undefined,
): ChecksumVerdict {
  const parsed = parseSha256Sums(sha256SumsText);
  if (parsed.size === 0) return "manifest-unparsable";
  const expected = lookupDigest(parsed, assetZipName);
  if (expected === null) return "missing-entry";
  return verifyDigest(expected, actualZipHexDigest) ? "verified" : "digest-mismatch";
}

/** A short, actionable reason for a non-`verified` verdict. */
export function checksumFailureReason(verdict: ChecksumVerdict, assetZipName: string): string {
  switch (verdict) {
    case "manifest-unparsable":
      return `the downloaded ${SHA256SUMS_ASSET_NAME} manifest was empty or unparsable`;
    case "missing-entry":
      return `the ${SHA256SUMS_ASSET_NAME} manifest has no entry for '${assetZipName}'`;
    case "digest-mismatch":
      return `the downloaded '${assetZipName}' SHA256 did not match the ${SHA256SUMS_ASSET_NAME} manifest entry`;
    default:
      return "the checksum was verified";
  }
}
