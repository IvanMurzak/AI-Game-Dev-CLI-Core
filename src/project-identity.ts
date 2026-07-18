import { createHash } from "node:crypto";

/**
 * The single canonical derivation of a project's **routing pin** and its **deterministic local
 * port** from the project root path — the TypeScript port of the shared .NET reference
 * `com.IvanMurzak.McpPlugin.AgentConfig.ProjectIdentity`
 * (`MCP-Plugin-dotnet/McpPlugin/src/AgentConfig/ProjectIdentity.cs`). Every runtime (the
 * Unity/Godot/Unreal plugins, the .NET sidecar, and the three engine CLIs) derives identical
 * values with no shared state and no probing, so an agent session launched in a project folder
 * routes strictly to that project's engine instance.
 *
 * Two normalizations are shipped side by side (auth-fixes design 02 T3 / defect B5):
 *
 *   - **v1** (`normalize` / `derivePin` / `derivePort` / `deriveProjectPathHash`) — the legacy
 *     algorithm, kept verbatim so old `.mcp.json` pins keep matching during the dual-hash
 *     transition (decision M1). Separators are NOT converted: `C:\a` and `C:/a` hash differently.
 *   - **v2** (`normalizeV2` / `derivePinV2` / `derivePortV2` / `deriveProjectPathHashV2`) — the
 *     new algorithm the configurators now emit. It adds ONE step to the v1 normalization —
 *     converting `\` to `/` — so a Windows project root reported with backslashes (`C:\a\b`) and
 *     the same root reported with forward slashes (`C:/a/b`) hash IDENTICALLY. That kills B5.
 *
 * Cross-language parity (C# vs TS) is gated byte-for-byte by the committed golden-vector files
 * (`ProjectIdentity.GoldenVectors.json` v1 and `ProjectIdentity.GoldenVectors.v2.json` v2),
 * vendored under `test/golden-vectors/` and reproduced by `test/project-identity.test.ts`. The
 * files also pin the one Unicode divergence that matters for real paths — U+0130 (see
 * {@link toLowerInvariant}).
 *
 * Algorithm (v1; v2 inserts the `\`→`/` substitution at step 2):
 *   1. Trim trailing directory separators (`/` and `\`) so `/a/b` and `/a/b/` are the same project.
 *   2. Lowercase with an invariant fold (`ToLowerInvariant`-equivalent — see {@link toLowerInvariant}).
 *   3. UTF-8 encode, then SHA-256 hash.
 *   4. pin  = the first 4 bytes of the hash as 8 lowercase hex chars.
 *   5. port = 20000 + (littleEndianUInt32(first 4 bytes) % 10000).  Range 20000-29999.
 */

/** Inclusive lower bound of the deterministic local-port range. */
export const MIN_PORT = 20000;

/** Inclusive upper bound of the deterministic local-port range. */
export const MAX_PORT = 29999;

/** Number of ports in the deterministic range (10000). */
export const PORT_RANGE = MAX_PORT - MIN_PORT + 1;

/** Number of hex characters in the routing pin (first 4 bytes of the hash). */
export const PIN_LENGTH = 8;

/** Number of bytes taken from the front of the hash for the routing pin. */
const PIN_BYTES = PIN_LENGTH / 2;

const SEPARATOR_FORWARD = "/";
const SEPARATOR_BACK = "\\";

/**
 * Characters where JS `String.prototype.toLowerCase()` diverges from .NET
 * `string.ToLowerInvariant()`. `ToLowerInvariant` is the canonical origin of the ProjectIdentity
 * derivation, so the TS port must reproduce it byte-for-byte. Each entry maps a code point to the
 * value `ToLowerInvariant` produces:
 *   - **U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE** — `ToLowerInvariant` leaves it unchanged
 *     (no case fold), whereas `toLowerCase()` folds it to `U+0069 U+0307` (i + COMBINING DOT
 *     ABOVE), which produces a DIFFERENT hash. The golden-vector files pin both values so this
 *     special-case can never silently regress.
 */
const INVARIANT_LOWER_OVERRIDES: Readonly<Record<string, string>> = {
  "İ": "İ",
};

/**
 * Lowercase a string the way .NET `string.ToLowerInvariant()` does: a simple, culture-independent,
 * per-code-point mapping (no context-sensitive rules such as the Greek final-sigma or the
 * Turkish-i special cases). Each code point is lowered on its own; {@link INVARIANT_LOWER_OVERRIDES}
 * corrects the few points where JS disagrees with .NET.
 */
export function toLowerInvariant(value: string): string {
  let result = "";
  for (const ch of value) {
    result += INVARIANT_LOWER_OVERRIDES[ch] ?? ch.toLowerCase();
  }
  return result;
}

/**
 * Trim trailing directory separators (`/` and `\`) so `/a/b` and `/a/b/` are the same project.
 * Never trims below length 1 (matches `ProjectIdentity.TrimTrailingSeparators`).
 */
function trimTrailingSeparators(path: string): string {
  let end = path.length;
  while (end > 1 && (path[end - 1] === SEPARATOR_FORWARD || path[end - 1] === SEPARATOR_BACK)) {
    end--;
  }
  return end === path.length ? path : path.slice(0, end);
}

function assertString(projectRoot: string): void {
  if (typeof projectRoot !== "string") {
    throw new TypeError("projectRoot must be a string");
  }
}

/** The resolved identity for a project root (pin + resolved port). */
export interface ProjectIdentity {
  /** The routing pin: first 8 lowercase hex chars of the SHA-256 of the normalized project root. */
  pin: string;
  /** The resolved local port — the hash-derived port unless an explicit override was supplied. */
  port: number;
  /** True when {@link ProjectIdentity.port} came from an explicit user override rather than the hash. */
  portIsOverridden: boolean;
}

// ── v1 (legacy hash; separators NOT converted) ───────────────────────────────────────────────

/**
 * The v1 pre-hash string: the project root with trailing directory separators trimmed, then
 * invariant-lowercased. Separators are NOT converted — `C:\a` and `C:/a` stay distinct.
 */
export function normalize(projectRoot: string): string {
  assertString(projectRoot);
  return toLowerInvariant(trimTrailingSeparators(projectRoot));
}

/** The v1 routing pin (first 8 lowercase hex chars of the hash). Never affected by overrides. */
export function derivePin(projectRoot: string): string {
  return hashOf(normalize(projectRoot)).subarray(0, PIN_BYTES).toString("hex");
}

/** The v1 hash-derived port (ignores any override). Range 20000-29999. */
export function derivePort(projectRoot: string): number {
  return portFromHash(hashOf(normalize(projectRoot)));
}

/**
 * The FULL v1 project-path hash: the complete 64-char lowercase hex SHA-256 of the normalized
 * project root — the legacy `projectPathHashLegacy` an engine plugin sends in its hub
 * instance-metadata handshake. The v1 routing pin is a case-insensitive prefix of this value.
 */
export function deriveProjectPathHash(projectRoot: string): string {
  return hashOf(normalize(projectRoot)).toString("hex");
}

/**
 * Derive the v1 identity for `projectRoot`. When `portOverride` is non-null (the user's explicit
 * override from the project marker) it always wins for {@link ProjectIdentity.port}; the
 * {@link ProjectIdentity.pin} is always hash-derived.
 */
export function deriveProjectIdentity(
  projectRoot: string,
  portOverride?: number | null,
): ProjectIdentity {
  const hash = hashOf(normalize(projectRoot));
  const pin = hash.subarray(0, PIN_BYTES).toString("hex");
  if (portOverride !== undefined && portOverride !== null) {
    return { pin, port: portOverride, portIsOverridden: true };
  }
  return { pin, port: portFromHash(hash), portIsOverridden: false };
}

// ── v2 (auth-fixes T3 / B5 fix; '\' → '/' before hashing) ────────────────────────────────────

/**
 * The v2 pre-hash string: the project root with trailing directory separators trimmed, every
 * backslash converted to a forward slash, then invariant-lowercased. This single primitive backs
 * the v2 pin, the full v2 project-path hash, and the v2 deterministic port — so a Windows root
 * reported with `\` and the same root with `/` derive identically (the B5 fix).
 */
export function normalizeV2(projectRoot: string): string {
  assertString(projectRoot);
  return toLowerInvariant(
    trimTrailingSeparators(projectRoot).split(SEPARATOR_BACK).join(SEPARATOR_FORWARD),
  );
}

/** The v2 routing pin (first 8 lowercase hex chars of the SHA-256 of {@link normalizeV2}). */
export function derivePinV2(projectRoot: string): string {
  return hashOf(normalizeV2(projectRoot)).subarray(0, PIN_BYTES).toString("hex");
}

/** The v2 hash-derived port (ignores any override). Range 20000-29999. */
export function derivePortV2(projectRoot: string): number {
  return portFromHash(hashOf(normalizeV2(projectRoot)));
}

/**
 * The FULL v2 project-path hash (64-char lowercase hex of the SHA-256 of {@link normalizeV2}) —
 * the `projectPathHash` an engine plugin sends in its hub instance-metadata handshake. The v2
 * routing pin is a case-insensitive prefix of this value by construction.
 */
export function deriveProjectPathHashV2(projectRoot: string): string {
  return hashOf(normalizeV2(projectRoot)).toString("hex");
}

/**
 * Derive the v2 identity for `projectRoot`. When `portOverride` is non-null it always wins for
 * {@link ProjectIdentity.port}; the {@link ProjectIdentity.pin} is always hash-derived.
 */
export function deriveProjectIdentityV2(
  projectRoot: string,
  portOverride?: number | null,
): ProjectIdentity {
  const hash = hashOf(normalizeV2(projectRoot));
  const pin = hash.subarray(0, PIN_BYTES).toString("hex");
  if (portOverride !== undefined && portOverride !== null) {
    return { pin, port: portOverride, portIsOverridden: true };
  }
  return { pin, port: portFromHash(hash), portIsOverridden: false };
}

// ── shared primitives ────────────────────────────────────────────────────────────────────────

function hashOf(normalized: string): Buffer {
  return createHash("sha256").update(Buffer.from(normalized, "utf8")).digest();
}

function portFromHash(hash: Buffer): number {
  // First 4 bytes as an explicit little-endian uint32 — matches the C# byte-shift
  // (`hash[0] | hash[1]<<8 | hash[2]<<16 | hash[3]<<24`) and is CPU-endianness independent.
  const value = hash.readUInt32LE(0);
  return MIN_PORT + (value % PORT_RANGE);
}
