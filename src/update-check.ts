import * as fs from "node:fs";

import { isNewerVersion, isNumericVersion } from "./semver.js";

/**
 * The npm self-update check of the engine CLIs: the `latest` version of a package on the npm
 * registry, cached for a day in a small JSON file so a command does not wait on the network every
 * time. Rendering the notice (colours, wording) stays in each CLI.
 */

/** How long a cached `latest` version is trusted (24 h). */
export const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Network timeout of one registry request (ms). */
export const UPDATE_CHECK_FETCH_TIMEOUT_MS = 3000;

export interface FetchLatestNpmVersionOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The `latest` version of `packageName` on the public npm registry. Throws on a network or registry failure. */
export async function fetchLatestNpmVersion(
  packageName: string,
  options: FetchLatestNpmVersionOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://registry.npmjs.org/${packageName}/latest`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? UPDATE_CHECK_FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
  const data = (await response.json()) as { version?: string };
  if (!data.version) throw new Error("No version field in registry response");
  return data.version;
}

export interface UpdateInfo {
  current: string;
  latest: string;
}

export interface NpmUpdateCheckOptions extends FetchLatestNpmVersionOptions {
  packageName: string;
  /** The JSON cache file (e.g. `~/.unity-mcp-cli-update.json`). */
  cacheFile: string;
  /** Clock seam for tests. */
  now?: () => number;
}

interface UpdateCache {
  latestVersion: string;
  lastChecked: number;
}

/**
 * Whether a newer version of the package than `currentVersion` is published: from the cache when
 * it is younger than {@link UPDATE_CHECK_CACHE_TTL_MS}, else from the registry (then the cache is
 * rewritten). `null` when the CLI is current. Never throws: any failure is `null`.
 */
export async function checkForNpmUpdate(
  currentVersion: string,
  options: NpmUpdateCheckOptions,
): Promise<UpdateInfo | null> {
  const now = options.now ?? Date.now;
  try {
    const cache = readUpdateCache(options.cacheFile);
    let latest: string;
    if (cache && now() - cache.lastChecked < UPDATE_CHECK_CACHE_TTL_MS) {
      latest = cache.latestVersion;
    } else {
      latest = await fetchLatestNpmVersion(options.packageName, options);
      writeUpdateCache(options.cacheFile, { latestVersion: latest, lastChecked: now() });
    }
    return isNewerVersion(currentVersion, latest) ? { current: currentVersion, latest } : null;
  } catch {
    return null; // best-effort: an update check never disrupts the command
  }
}

function readUpdateCache(file: string): UpdateCache | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as UpdateCache;
    if (parsed.latestVersion && typeof parsed.lastChecked === "number" && isNumericVersion(parsed.latestVersion)) {
      return parsed;
    }
  } catch {
    // missing or corrupt: ignore
  }
  return null;
}

function writeUpdateCache(file: string, data: UpdateCache): void {
  try {
    fs.writeFileSync(file, JSON.stringify(data), "utf-8");
  } catch {
    // non-critical
  }
}

/**
 * The exact command that updates a globally installed CLI, meant to be printed ALONE on its line:
 * the old wording "Run npm i -g <cli> to update" was copied whole, so npm also installed the
 * unrelated `to` and `update` packages.
 */
export function npmGlobalInstallCommand(packageName: string): string {
  return `npm i -g ${packageName}`;
}

/** True when the CLI was most likely started through `npx` / `npm exec` (a global update does not apply). */
export function isRunningViaNpx(env: NodeJS.ProcessEnv = process.env): boolean {
  const execPath = env["npm_execpath"] ?? "";
  const npmCommand = env["npm_command"] ?? "";
  return execPath.includes("npx") || npmCommand === "exec";
}
