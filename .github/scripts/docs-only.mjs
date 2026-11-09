/**
 * CI gate: does this pull request, or this push to main, change only documentation?
 *
 *   node .github/scripts/docs-only.mjs
 *
 * Writes `docs_only=true|false` to $GITHUB_OUTPUT; ci.yml and concurrency-suite.yml skip their heavy
 * jobs only on an explicit `true`. So every doubt means a full run: a path not listed below, an empty
 * diff, a commit range this cannot prove, or a failure here, since this step is `continue-on-error`
 * and leaves the output empty. HEAD must be GITHUB_SHA.
 *
 * Reads the diff of the merge commit GitHub builds for a pull_request run (HEAD^1 is the base), or of
 * the pushed commit when it is the only one in the push. Needs `fetch-depth: 2` and no token or API.
 * `--no-renames` because a rename from src/ into docs/ would otherwise list only its docs/ side.
 *
 * To skip CI for more paths, edit isDocsPath and its table in test/docs-only.test.ts. List only what
 * no skipped job reads. These do not qualify:
 *   README.md, LICENSE  published in the npm package (package.json `files`)
 * CHANGELOG.md does: no CI job reads it. The release train takes this package's version from it
 * (software `.chain/manifest.yml`, `version.source: changelog`) when it generates a lock, and CI
 * under a lock runs in full. So do the root .claude/ and .agents/ (agent settings and skills): the
 * ".claude/skills" and ".agents/skills" in src/ are paths in the user's project.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** @param {string} path repo-relative, forward slashes */
export function isDocsPath(path) {
  return path === "AGENTS.md" || path === "CHANGELOG.md" || /^(docs|\.claude|\.agents)\//.test(path);
}

/** @param {readonly string[]} files */
export function isDocsOnly(files) {
  return files.length > 0 && files.every(isDocsPath);
}

/** The files the commit under test changes against its base. Throws when the range is not provable. */
export function changedFiles(repo, { event, before }) {
  if (event === "pull_request") git(repo, "rev-parse", "--verify", "HEAD^2"); // the PR's merge commit
  else if (git(repo, "rev-parse", "HEAD^1").trim() !== before) throw new Error(`the push holds more than HEAD: before=${before}`);
  return git(repo, "diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD").split("\0").filter(Boolean);
}

function main() {
  const repo = process.cwd();
  const head = git(repo, "rev-parse", "HEAD").trim();
  if (head !== process.env.GITHUB_SHA) throw new Error(`HEAD ${head} is not GITHUB_SHA ${process.env.GITHUB_SHA}`);
  const files = changedFiles(repo, { event: process.env.GITHUB_EVENT_NAME, before: process.env.PUSH_BEFORE });
  const docsOnly = isDocsOnly(files);
  const other = files.find((file) => !isDocsPath(file));
  console.log(`${files.length} changed file(s)${other ? `, e.g. ${other} is outside the docs list` : ""}`);
  console.log(`docs_only=${docsOnly}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
}

// realpath: import.meta.url has its symlinks resolved, argv[1] does not, and a mismatch would exit 0 with no output.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
