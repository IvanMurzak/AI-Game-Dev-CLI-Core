/**
 * Minimal semantic-version helpers.
 *
 * This is a small, real slice of the shared CLI-core surface (T7 lists semver
 * utilities among the core modules). It gives CI something meaningful to build
 * and test today; the larger cli-core modules (project identity/pin, OAuth
 * device login, machine credentials, setup-mcp/install-plugin) land in b2/b3.
 */

export interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Parse a strict `MAJOR.MINOR.PATCH` version string (no pre-release / build
 * metadata). Returns `null` for anything that is not a well-formed core semver.
 */
export function parseSemver(input: string): SemVer | null {
  const match = SEMVER_CORE.exec(input.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Whether `input` is a strict `MAJOR.MINOR.PATCH` version string. */
export function isValidSemver(input: string): boolean {
  return parseSemver(input) !== null;
}

// ── loose numeric versions (npm `latest`, package manifests) ───────────────────────────────────

const NUMERIC_VERSION = /^\d+(\.\d+)*$/;

/** Whether `version` is dot-separated digits of any length (`1`, `1.2`, `1.2.3.4`): no pre-release, no `v`. */
export function isNumericVersion(version: string): boolean {
  return NUMERIC_VERSION.test(version);
}

/**
 * Compare two dot-separated numeric versions component by component; a missing component is 0
 * (`1.2` equals `1.2.0`). Returns -1, 0 or 1. A non-numeric component compares equal to anything.
 */
export function compareNumericVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

/** True when `latest` is strictly greater than `current` ({@link compareNumericVersions}). */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareNumericVersions(current, latest) < 0;
}
