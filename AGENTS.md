# AGENTS.md

Shared TypeScript CLI core for the AI Game Dev engine CLIs (Unity / Unreal / Godot), published to npm
as `@baizor/gamedev-cli-core`. The three engine CLIs and the desktop App consume it from npm as thin
adapters, so a merge here ships nothing until a release is published. The package has zero runtime
dependencies; keep it that way.

## Build / test

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (ESM + .d.ts)
npm test            # vitest run (test/**/*.test.ts)
```

Node >= 22.14.0. The real-process concurrency suite is opt-in (`X2_CONCURRENCY=1`) and runs in
`.github/workflows/concurrency-suite.yml` together with MCP-Plugin-dotnet's C# refresh harness.

## Layout

- `src/` — flat ESM modules (one file per concern); `src/index.ts` is the only public entry, so
  export every new public symbol there. Relative imports use the `.js` suffix (NodeNext).
- `test/` — vitest specs `<module>.test.ts` (`*.subprocess.test.ts` spawn real processes);
  `test/fixtures/` worker scripts; `test/golden-vectors/` — vendored from MCP-Plugin-dotnet.
- `.github/workflows/` — `ci.yml` (typecheck + build + test, 3 OS), `concurrency-suite.yml`,
  `release.yml` (dispatch-only npm publish); `.github/scripts/chain_feed.py` is vendored, keep it byte-identical.

## Conventions

- Engine specifics live ONLY in `src/engine-adapter.ts` (`EngineAdapter`); nothing else branches on the engine.
- Credential refresh goes ONLY through `MachineCredentialProvider` (`src/credential-provider.ts`).
- Golden vectors are the byte-for-byte parity gate with the C# `McpPlugin`: never edit them here to
  make a test pass; change the C# source of truth and re-vendor.
- Record user-visible changes under `## Unreleased` in `CHANGELOG.md`.

## Releases

`package.json` stays at `0.0.0`; the version is set at publish time by
`gh workflow run release.yml -f version=X.Y.Z` (npm Trusted Publishing, OIDC). Never bump the version
or dispatch a release unless the owner asks. The publish step must stay inside `release.yml` itself
(the npm Trusted Publisher is bound to that file; reusable workflows break it).
