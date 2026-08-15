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
    `/oauth/token`) with token rotation and a clean `login required` on family-revoke.
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
- **Landed (c1/c2 + DCR — desktop browser sign-in):**
  - **OAuth 2.1 authorization-code login** — `authCodeLogin` (RFC 8252 native app, RFC 7636 PKCE
    S256, `state` CSRF check, an ephemeral `127.0.0.1` loopback listener, RFC 8707 `resource`),
    returning the same `MachineCredentials` shape as `deviceLogin`.
  - **Discovery + dynamic client registration** — `discoverAuthorizationServer` (RFC 8414
    `/.well-known/oauth-authorization-server`, falling back to the hardcoded paths) and
    `resolveClientRegistration` / `registerClient` (RFC 7591). `/oauth/authorize` resolves
    `client_id` by an exact registry lookup whose only writer is `POST /oauth/register` — which mints
    its OWN id — so a hardcoded client id is always rejected with `invalid_client`. The minted id is
    persisted per authorization server in `~/.ai-game-dev/oauth-clients.json` (`ClientRegistrationStore`,
    same atomic owner-only write as the credential store) and reused on every later launch; only the
    loopback **port** floats, so one registration serves every run. On `invalid_client` the flow
    re-registers exactly once. **The device grant deliberately keeps its static client id** — the
    server binds each refresh-token family to the id used at issue time, so moving it would
    invalidate every existing CLI login.

- **Landed (unified-machine-auth c3 — the shared refresher/provider + login plumbing):**
  - **`MachineCredentialProvider` — THE single entry point for credential access + refresh.** The
    three engine CLIs (W2: d2/e2/f2) and the desktop App (W3) obtain access tokens EXCLUSIVELY via
    `getAccessToken({family})` / `refresh({family})`; nothing else re-implements refresh. It is
    family-aware over store schema v2 (`agent` / `plugin` / `legacy` planes), runs every refresh
    under the cross-process `MachineCredentialLock` with a **double-checked re-read** (a peer's
    rotation is adopted without a network call), presents the **family's stored `clientId`**
    (component default ONLY for `families.legacy`), **omits `scope`/`resource` on refresh**
    (P0-3), keeps the previous refresh token when the server does not rotate one, treats
    `invalid_grant` after a post-failure re-read as family death (one structured telemetry event,
    other families untouched, never loops), rate-limits to one attempt per family per skew
    window, and surfaces busy locks / unreadable stores as typed non-sign-out errors.
  - **RFC 8693 token exchange** — `HttpTokenExchangeClient` (the frozen a5 wire shape:
    `subject_token` = fresh agent access token, exact URNs, `scope=mcp:plugin`,
    `audience` only as the exact `urn:agd:hub`), deriving the plugin family from the agent family.
  - **Login-surface commit plumbing** — `commitAgentLogin` (the F1/F2 two-lock-hold sequence:
    agent family under hold 1 → exchange → plugin family + v1 mirror under hold 2; a failed
    exchange leaves the committed agent family and a "partially authorized, retrying" state
    resumable via `derivePluginFamily`), `commitToolsOnlyLogin` (the `--tools-only` / O10
    plugin-only mint for CI — F10), the D6/F7 **account-switch guard** (`evaluateAccountSwitch` /
    `runAccountSwitchGuard`; decline revokes the just-minted family and leaves the store
    untouched; **`runEnroll` routes through the same guard**), `signOutMachineWide` (F6:
    best-effort RFC 7009 revocation of every family, then the lock-guarded store delete), and
    `revokeTokenBestEffort` (RFC 7009). Every commit **re-verifies the world under its lock
    hold** before writing (`commitFamilyUnderHold`): a guard premise that changed during the
    confirm dialog, a subject switched between the two holds, a store deleted by a concurrent
    sign-out (never recreated), or a store turned unreadable (never overwritten) each abort with
    a typed `CommitAbortReason` result — never a throw, never a mixed-account or resurrected
    store.

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
