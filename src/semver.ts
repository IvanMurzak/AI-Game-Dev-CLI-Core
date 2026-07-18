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
