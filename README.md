# AI-Game-Dev-CLI-Core

Shared TypeScript CLI core for the AI Game Dev engine CLIs (Unity / Unreal / Godot),
published to npm as **`@baizor/gamedev-cli-core`** via **npm Trusted Publishing (OIDC, tokenless)**.

This package is the single source of truth for CLI logic; the three engine CLIs are thin,
engine-specific adapters over it. The shared modules land here through the `auth-fixes` design
(tasks b2/b3):

- **Landed (b2 — correctness/security core):**
  - **project identity / pin** — `derivePin`/`derivePort`/`deriveProjectPathHash` (v1) and the
    `…V2` variants (separator-normalized, the B5 fix), gated byte-for-byte against the SAME golden
    vectors as the C# LIB (`test/golden-vectors/`, vendored from `MCP-Plugin-dotnet`).
  - **machine credential store** — `MachineCredentialStore` at `~/.ai-game-dev/credentials.json`,
    full `MachineCredentials`, DPAPI on Windows / `0600` on POSIX, atomic (crash-safe) writes.
  - **OAuth 2.1 device-grant login** — `deviceLogin` (RFC 8628, `/oauth/device_authorization` +
    `/oauth/token`) plus the proactive/reactive refresh loop (`HttpTokenRefresher`,
    `MachineCredentialProvider`) with token rotation and a clean `login required` on family-revoke.
- **Landed (b3 — shared modules + the engine-adapter contract):**
  - **engine-adapter contract** — `EngineAdapter` (+ `unityAdapter` / `unrealAdapter` / `godotAdapter`),
    the single typed seam that carries every per-engine difference: `serverName`, project markers,
    `stdioSupported` + `stdioArgs`, the server install-dir layout, `loginServerTarget`, and the OAuth
    `clientId`. **No engine specifics live anywhere else in the package.**
  - **agent-config writers** — `JsonAiAgentConfig` / `TomlAiAgentConfig`, byte-for-byte parity with
    the C# `com.IvanMurzak.McpPlugin.AgentConfig`, gated by `test/golden-vectors/AgentConfig.GoldenVectors.json`,
    plus the engine-neutral `agentRegistry`.
  - **setup-mcp policy** — `setupMcp` / `resolveSetupMcpPlan`: pins the routing URL by default
    (`/mcp/p/<pin-v2>` http, `project=<pin>` stdio; B4), with a `--no-pin` escape hatch, and writes a
    static credential **only** on an explicit `--token` opt-in (M7 — the default config is
    credential-free; the pin is routing-only, not part of the OAuth resource — M8).
  - **install-plugin policy** — `resolveInstallTarget`: resolves the project path
    `positional → --path → cwd` (B1) then marker-probes it, failing with a message listing exactly
    what was checked. Ancestor walk-up is out of scope (M5).
  - **enroll** — `runEnroll` / `redeemEnrollmentCode`: writes the v2 pin (the B5 fix replaces the
    Unity CLI's local `\`→`/` workaround) and records the **AS-root** `serverTarget`, never a pinned
    hub URL (b2 review MED-2).
  - **server-download** — `downloadServer` with a fail-closed `SHA256SUMS` verify-before-execute gate
    and a dependency-free in-process `parseZip` unzip.
  - **project-marker, validation, ui/progress** utilities.

A small semver utility slice is also exposed. The package has **zero runtime dependencies**.

## Requirements

- Node.js **>= 22.14.0**
- npm **>= 11.5.1** (required for OIDC Trusted Publishing; below this the publish silently degrades)

## Develop

```bash
npm install       # install dependencies
npm run build     # tsc -> dist/ (ESM + .d.ts)
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

## Release (npm Trusted Publishing / OIDC)

Releases are cut from the `release.yml` GitHub Actions workflow, which publishes to npm over OIDC
(no npm token, no `--provenance` flag — provenance is attached automatically). Run it from your
machine with the GitHub CLI:

```bash
gh workflow run release.yml -f version=X.Y.Z
```

The workflow enforces the Node >= 22.14.0 / npm >= 11.5.1 floors, sets the package version from the
`version` input, builds, and publishes.

### Trusted Publishing binding (owner, one-time)

The npm Trusted Publisher for `@baizor/gamedev-cli-core` is bound to **this exact repo + workflow**
(`.github/workflows/release.yml`). The publish step lives directly in that workflow file — it is
**not** factored into a reusable workflow, because reusable-workflow bindings are a known npm TP
limitation for `workflow_dispatch`.

## License

[MIT](LICENSE) © Ivan Murzak
