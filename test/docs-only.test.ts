import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, isDocsOnly, isDocsPath } from "../.github/scripts/docs-only.mjs";

const repoRoot = join(import.meta.dirname, "..");
const script = join(repoRoot, ".github", "scripts", "docs-only.mjs");
const PR = { event: "pull_request" };

type Git = (...args: string[]) => string;

function withRepo(check: (repo: string, git: Git) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "docs-only-"));
  const git: Git = (...args) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: repo,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  try {
    git("init", "-b", "main");
    check(repo, git);
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); // Windows briefly keeps git's handles
  }
}

interface Merge {
  repo: string;
  git: Git;
  /** main before the merge: what a push of the merge commit reports as `before`. */
  base: string;
}

/** A repo with one base commit, then the merge commit of a branch `change` applied to it. */
function withMerge(change: (repo: string, write: (path: string) => void) => void, check: (merge: Merge) => void): void {
  withRepo((repo, git) => {
    const write = (path: string): void => {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), path);
    };
    const commit = (message: string): void => {
      git("add", ".");
      git("commit", "-m", message);
    };
    write("src/a.ts");
    write("src/b.ts"); // keeps src/ alive, or git reads a rename of a.ts as moving the folder
    commit("base");
    git("checkout", "-b", "pr");
    change(repo, write);
    commit("pr");
    git("checkout", "main");
    write("src/moved-on-main.ts");
    commit("main moved");
    const base = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "-m", "merge", "pr");
    check({ repo, git, base });
  });
}

describe("docs-only gate", () => {
  it("isDocsPath lists docs/ and the root AGENTS.md, nothing else", () => {
    const skip = ["AGENTS.md", "docs/a.md", "docs/deep/image.png"];
    const run = [
      "README.md", // published in the npm package
      "LICENSE", // published in the npm package
      "CHANGELOG.md", // the release train's version source
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vitest.config.ts",
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/scripts/docs-only.mjs",
      ".github/scripts/chain_feed.py",
      "src/index.ts",
      "src/AGENTS.md",
      "test/golden-vectors/project-keys.golden.json",
      "docs",
      "documents/a.md",
      "agents.md",
    ];
    for (const path of skip) expect(isDocsPath(path), path).toBe(true);
    for (const path of run) expect(isDocsPath(path), path).toBe(false);
  });

  it("isDocsOnly needs at least one file and every file on the list", () => {
    expect(isDocsOnly(["docs/a.md", "AGENTS.md"])).toBe(true);
    expect(isDocsOnly(["docs/a.md", "package.json"])).toBe(false);
    expect(isDocsOnly([])).toBe(false);
  });

  it("nothing on the list is published in the npm package", () => {
    const { files } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { files: string[] };
    expect(files.filter((path) => isDocsPath(path) || path === "docs")).toEqual([]);
  });

  it("changedFiles lists only what the pull request changes, not what main gained", () => {
    withMerge(
      (_repo, write) => write("docs/a.md"),
      ({ repo }) => expect(changedFiles(repo, PR)).toEqual(["docs/a.md"]),
    );
  });

  it("a rename from code into docs lists both sides, so it is not docs-only", () => {
    withMerge(
      (repo) => {
        mkdirSync(join(repo, "docs"));
        renameSync(join(repo, "src/a.ts"), join(repo, "docs/a.ts"));
      },
      ({ repo }) => {
        expect(changedFiles(repo, PR).sort()).toEqual(["docs/a.ts", "src/a.ts"]);
        expect(isDocsOnly(changedFiles(repo, PR))).toBe(false);
      },
    );
  });

  it("a non-ASCII docs path stays unquoted, so it still matches the list", () => {
    withMerge(
      (_repo, write) => write("docs/заметка.md"),
      ({ repo }) => expect(isDocsOnly(changedFiles(repo, PR))).toBe(true),
    );
  });

  it("changedFiles refuses a pull_request HEAD that is not a merge commit", () => {
    withRepo((repo, git) => {
      git("commit", "--allow-empty", "-m", "base");
      git("commit", "--allow-empty", "-m", "only");
      expect(() => changedFiles(repo, PR)).toThrow();
    });
  });

  it("a push reads its merge commit's own range and refuses any other range", () => {
    withMerge(
      (_repo, write) => write("docs/a.md"),
      ({ repo, base }) => {
        expect(changedFiles(repo, { event: "push", before: base })).toEqual(["docs/a.md"]);
        for (const before of ["0".repeat(40), undefined]) {
          expect(() => changedFiles(repo, { event: "push", before })).toThrow();
        }
      },
    );
  });

  it("the script writes the output only when HEAD is the commit under test", () => {
    withMerge(
      (_repo, write) => write("docs/a.md"),
      ({ repo, git }) => {
        const output = join(repo, "output.txt");
        const run = (sha: string) =>
          spawnSync(process.execPath, [script], {
            cwd: repo,
            encoding: "utf8",
            env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_SHA: sha, GITHUB_EVENT_NAME: "pull_request" },
          });

        expect(run("0".repeat(40)).status).not.toBe(0);
        expect(() => readFileSync(output)).toThrow();

        expect(run(git("rev-parse", "HEAD")).status).toBe(0);
        expect(readFileSync(output, "utf8")).toBe("docs_only=true\n");
      },
    );
  });
});
