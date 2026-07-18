# AI-Game-Dev-CLI-Core

Shared TypeScript CLI core for the AI Game Dev engine CLIs (Unity / Unreal / Godot),
published to npm as **`@baizor/gamedev-cli-core`** via **npm Trusted Publishing (OIDC, tokenless)**.

> **Status: bootstrap.** This repo currently holds only a placeholder `0.0.0` package used to
> claim the npm name so Trusted Publishing can be bound to it. The real shared modules —
> project identity / pin hashing, OAuth 2.1 device-grant login, the machine credential store,
> and the `setup-mcp` / `install-plugin` logic the three engine CLIs consume — land through the
> `auth-fixes` design (tasks b1–b4): scaffold + vitest CI, module extraction, then the first
> real OIDC publish.

## Bootstrap publish (one-time, owner)

1. `npm login` as the `baizor` account.
2. `npm publish` (the scoped package publishes public via `publishConfig.access`).
3. In the npm web UI → the package's **Settings → Trusted Publishing**, bind the GitHub repo
   `IvanMurzak/AI-Game-Dev-CLI-Core` and the workflow `release.yml` (added in b1).

## Release (after bootstrap)

`gh workflow run release.yml -f version=X.Y.Z` — publishes via OIDC (automatic provenance;
requires npm ≥ 11.5.1 and Node ≥ 22.14.0 in the job).
