import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** The package root. */
export const repoRoot = path.resolve(import.meta.dirname, "..");
/** The fixture scripts (plain node, importing dist/). */
export const fixtures = path.join(repoRoot, "test", "fixtures");

/**
 * Rebuild dist/ when any source is newer than its index: the fixtures run outside vitest's
 * transpiler. Vitest's `globalSetup`, so the build runs once, before the parallel test files.
 */
export default function ensureDistBuilt(): void {
  const out = path.join(repoRoot, "dist", "index.js");
  const srcDir = path.join(repoRoot, "src");
  const builtAt = fs.existsSync(out) ? fs.statSync(out).mtimeMs : -1;
  const stale = fs.readdirSync(srcDir).some((f) => fs.statSync(path.join(srcDir, f)).mtimeMs > builtAt);
  if (stale) {
    const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", path.join(repoRoot, "tsconfig.json")], { cwd: repoRoot, stdio: "inherit" });
  }
}
