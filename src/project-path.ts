import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Comparing project folders, and finding the project an editor process opened from its command line —
 * so an editor session never mistakes another project's editor for its own (a project folder copied
 * together with its `.ai-game-dev/session.json`).
 */

/** Windows and macOS file systems ignore case by default. */
function ignoresCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/** A UNC path (`\\server\share\…`): resolving it can block for the SMB timeout while the share is offline. */
function isUncPath(p: string): boolean {
  return p.startsWith("\\\\");
}

/** The existing path `p` with symlinks resolved and in its on-disk case; undefined when it cannot be resolved. */
function realPath(p: string): string | undefined {
  if (isUncPath(p)) return undefined;
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** The absolute path with symlinks resolved; as `path.resolve` gives it when it cannot be resolved. */
export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  return realPath(resolved) ?? resolved;
}

/**
 * Whether `a` and `b` name the same folder: equal as absolute paths, or with symlinks resolved and
 * in their on-disk case (`/tmp/x` and `/private/tmp/x` on macOS, a junction and its target,
 * `C:\Proj` and `c:\proj`). Only when a path cannot be resolved (it is gone, or a UNC path, never
 * resolved: an offline share blocks for the SMB timeout) are they compared case-insensitively on
 * Windows and macOS — so on a case-sensitive volume `Proj` and `proj` stay two folders.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const resolvedA = path.resolve(a);
  const resolvedB = path.resolve(b);
  if (resolvedA === resolvedB) return true;
  const realA = realPath(resolvedA);
  const realB = realPath(resolvedB);
  if (realA !== undefined && realB !== undefined) return realA === realB;
  const key = (p: string) => (ignoresCase(platform) ? p.toLowerCase() : p);
  return key(realA ?? resolvedA) === key(realB ?? resolvedB);
}

/**
 * Whether an editor's command line opens the folder `root`, from the candidates for its project
 * argument ({@link commandLineFlagValues} / {@link commandLineFileArgs}) mapped to folders by
 * `folderOf`. A `ps` line is ambiguous (`-projectPath /p/Game - old` holds `/p/Game` and
 * `/p/Game - old`): the editor's real argument is the longest candidate that exists; only a single
 * candidate is taken as it is when none exists. Relative candidates never count (an editor session
 * starts the editor with an absolute path; a relative one would resolve against OUR working
 * directory). Undefined: the command line does not tell.
 */
export function commandLineOpensFolder(
  candidates: readonly string[],
  root: string,
  folderOf: (candidate: string) => string = (candidate) => candidate,
): boolean | undefined {
  const absolute = candidates.map((candidate) => candidate.trim()).filter((candidate) => path.isAbsolute(candidate));
  if (absolute.length === 0) return false;
  const existing = absolute.filter((candidate) => fs.existsSync(candidate)).sort((x, y) => y.length - x.length);
  const argument = existing[0] ?? (absolute.length === 1 ? absolute[0] : undefined);
  return argument === undefined ? undefined : samePath(folderOf(argument), root);
}

/** `ch` may start or end an argument: none (the line's edge), whitespace or a quote. */
function isArgEdge(ch: string | undefined): boolean {
  return ch === undefined || ch === '"' || /\s/.test(ch);
}

/**
 * The values `flag` may have in a process command line (`-projectPath <path>`, `--path=<path>`), as
 * candidates: a quoted value exactly; an unquoted one — a POSIX `ps` line joins the arguments with
 * spaces, so a path may contain some — as every prefix that ends where another option could start
 * (whitespace, then `-`) and the rest of the line. The flag matches case-insensitively.
 */
export function commandLineFlagValues(commandLine: string, flag: string): string[] {
  const values: string[] = [];
  const lower = commandLine.toLowerCase();
  const name = flag.toLowerCase();
  for (let at = lower.indexOf(name); at >= 0; at = lower.indexOf(name, at + 1)) {
    if (!isArgEdge(commandLine[at - 1])) continue;
    let rest = commandLine.slice(at + name.length);
    if (rest.startsWith('"')) rest = rest.slice(1); // a quoted flag: `"-projectPath" <path>`
    const separator = /^(=|\s+)/.exec(rest);
    if (separator === null) continue;
    rest = rest.slice(separator[0].length);
    if (rest.startsWith('"')) {
      // Windows `\"` escapes are not decoded: a session never starts an editor with them.
      const end = rest.indexOf('"', 1);
      values.push(end < 0 ? rest.slice(1) : rest.slice(1, end));
      continue;
    }
    for (const option of rest.matchAll(/\s+(?=-)/g)) {
      if (option.index > 0) values.push(rest.slice(0, option.index));
    }
    const whole = rest.trimEnd();
    if (whole) values.push(whole);
  }
  return values;
}

/**
 * The arguments of a process command line that are files ending in `ext` (`X.uproject`), as candidates:
 * a quoted one exactly; an unquoted one (maybe with spaces, see {@link commandLineFlagValues}) starting
 * after every whitespace before it. The extension matches case-insensitively.
 */
export function commandLineFileArgs(commandLine: string, ext: string): string[] {
  const values: string[] = [];
  const lower = commandLine.toLowerCase();
  const suffix = ext.toLowerCase();
  for (let at = lower.indexOf(suffix); at >= 0; at = lower.indexOf(suffix, at + 1)) {
    const end = at + suffix.length;
    if (!isArgEdge(commandLine[end])) continue;
    const head = commandLine.slice(0, end);
    const quote = head.lastIndexOf('"');
    if (commandLine[end] !== '"') {
      for (let i = head.length - 1; i > quote; i--) {
        if (/\s/.test(head[i]!)) values.push(head.slice(i + 1));
      }
    }
    values.push(head.slice(quote + 1));
  }
  return values.filter((value) => value.length > suffix.length);
}
