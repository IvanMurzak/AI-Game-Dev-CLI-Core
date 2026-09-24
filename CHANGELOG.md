# Changelog

All notable changes to `@baizor/gamedev-cli-core`.

Versions are set at publish time by the `release.yml` workflow input (`gh workflow run release.yml
-f version=X.Y.Z`); `package.json` intentionally stays at `0.0.0` in-repo. On the 0.x line the
MINOR component is the breaking-capable one (caret consumers on `^0.3.0` do not auto-resolve
`0.4.0` — adopt deliberately).

## Unreleased

## 0.6.0 — 2026-09-24

### Added — Antigravity's two config locations; regenerate keeps the other agents working

- **Antigravity is configured in BOTH of its candidate global files** —
  `~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity/mcp_config.json` (which one an install
  reads differs per machine). An `AgentDefinition` may now declare several candidate files through the
  optional `getConfigPaths(projectPath)` (`configPathsOf(agent, projectPath)` resolves either shape;
  `getConfigPath` stays the first one). `setupMcp` writes every candidate, and a failure writing any of
  them is now a `failure` result naming the failed path (and the ones that were written) instead of a
  silent success. The success result gains `configPaths`; `SetupMcpPlan` gains `configPaths`;
  `writeSetupMcpPlanPaths(plan, io)` reports `{ written, failed }` per file. Antigravity's
  `configPathDisplay` lists both paths.
- **`getMcpConfigStatus(opts)`** — configured ⇔ EVERY candidate file exists AND carries a correct entry
  (a missing or stale one makes the agent "not configured", so Configure creates/repairs both). Reports
  `configPaths`, `existingPaths`, `misconfiguredPaths`.
- **`removeMcpConfig(opts)`** — removes the entry from every EXISTING candidate file (never creates or
  deletes a file); reports `removedPaths` and `failedPaths`.
- `JsonAiAgentConfig` / `TomlAiAgentConfig` gain a read-only `readServerEntry(configPath, io)`.

### Fixed — `regenerateKey` locked every other agent of the project out

- `setupMcp({ regenerateKey: true })` rewrote only the one agent's config and then revoked the previous
  key, which every other agent config of the same project still carried. It now moves every other
  config of the project (project-local and user-global) whose http entry is pinned to this project's pin
  and carries `Authorization: Bearer <previous key>` (Codex: `http_headers`) to the new key — touching
  nothing else in the file — and then checks that no existing config still contains the previous key.
  If any does (a failed write, an unpinned or renamed entry), the revoke is SKIPPED and the paths are
  reported in `warnings`. The success result gains `rewrittenConfigPaths`; the `ok` `ProjectKeyResult`
  gains `previousKey` (present exactly when `revokePrevious` is). An injected resolver that returns
  `revokePrevious` without `previousKey` keeps the old behaviour.

## 0.5.0 — 2026-09-23

> **Upgrading from 0.4.x:** breaking on the 0.x line — consumers on `^0.4.x` do not receive
> 0.5.0; widen the range to `^0.5.0` and `await setupMcp(...)`.
>
> **Known issue (fixed under Unreleased):** `setupMcp({ regenerateKey: true })` rewrites only the one
> agent's config and then revokes the previous key, which the project's other agent configs still
> carry — they start getting 401 until re-run. The previous key is revoked only when the new key was
> cached for the same signed-in account (`sub`) and its `keyId` differs; otherwise it stays live.

### Added — project keys (BREAKING: `setupMcp` is now async)

- **Cloud `setup-mcp` writes a per-project, non-expiring credential for EVERY agent.** A Cloud
  (non-loopback) http config now carries `Authorization: Bearer agd_pk_…` — a **project key**
  strictly bound to the project's v2 pin, minted with the machine credential via
  `POST {issuer}/api/mcp/project-keys` and reused from `~/.ai-game-dev/project-keys.json` while
  `GET …/project-keys/current` still accepts it (a transient failure also reuses). Codex gets it
  through its documented `http_headers` table and Antigravity through `headers`, so no client is
  left URL-only. An explicit `token` still wins; `oauth: true` writes the URL-only config (and
  removes a previously written header); `regenerateKey: true` mints a fresh key and — only after the cache and the config are rewritten —
  revokes the previously cached key (`DELETE /api/mcp/project-keys/{keyId}` with the mint's access
  token; a revoke failure is a warning, never fatal). The normal get-or-mint path never revokes. With no machine
  login, or when minting fails, the config falls back to URL-only with a warning. stdio and
  local-server configs are unchanged. The "access token under the project root may be committed"
  warning is gone (owner ruling).
- `setupMcp` now returns a `Promise` — callers add `await`. The result gains `credential`
  (`"token" | "project-key" | "none"`), `projectKeyId` and `projectKeySource`; the options gain
  `oauth`, `regenerateKey`, `machineName` and an injectable `projectKeyResolver`
  (`createProjectKeyResolver(adapter, provider?)` is the default).
- The project-key cache is gated by the cross-language golden vector
  `test/golden-vectors/project-keys.golden.json`, vendored byte-identical from MCP-Plugin-dotnet
  (`McpPlugin/src/AgentConfig/`, commit `2157b6c`): WHATWG-origin entry names, strict 8-hex pins,
  http(s)-only issuers, and a put that keeps the replaced entry's unknown fields.
- New public API: `ProjectKeyStore`, `getOrMintProjectKey`, `regenerateProjectKey`,
  `HttpProjectKeyTransport`, `projectKeyCacheKey`, `isCloudUrl`, and
  `AgentDefinition.httpHeadersKey`.

## 0.4.2 — 2026-09-16

### Fixed

- **Cloud `run-tool` / `run-system-tool` / `status` answered `401 invalid_token` on every call,
  even right after `login --force`.** The engine CLIs resolve the Bearer for the MCP server's
  HTTP API (`/api/tools/*`, `/api/system-tools/*`, streamable `/mcp`) through
  `MachineCredentialProvider.getAccessToken({ family: "plugin" })` (or the default plane), which
  resolved `families.plugin` → `families.legacy`. After a normal login `families.plugin` is the
  RFC 8693 exchange-derived credential with `aud=urn:agd:hub` — and the MCP server validates
  every HTTP route on its AGENT plane, which accepts only its canonical `/mcp` resource as
  audience and refuses `urn:agd:hub` outright. The reactive refresh-and-retry then rotated the
  same plugin family and retried with another hub-audienced token, so the call could never
  succeed. The `plugin` plane (and the default) now resolves **`families.agent` first**, then
  `families.plugin`, then `families.legacy` — the agent family is the `mcp:agent` credential the
  HTTP routes accept, and its refresh presents the agent family's own stored `clientId`. Stores
  with no agent family (`--tools-only`, enroll-minted, adopted v1) resolve exactly as before. No
  consumer change is needed: the shipped CLIs pick this up on their existing `^0.4.0` range.
- **`refresh()` could hand back a token other than the one it refreshed.** Callers read the
  returned document's top-level `accessToken` first; that is the v1 compat mirror of the plugin
  plane, and when the rotation could not be persisted it was the STALE on-disk token. The
  returned document's top-level `accessToken`/`refreshToken`/`expiresAt` are now always those of
  the family that was refreshed (in-memory when persisting failed); the on-disk mirror is
  unchanged.
- **Windows login was fatal on a PATH without PowerShell** (`spawnSync powershell.exe ENOENT`).
  The DPAPI codec resolved its PowerShell host through **PATH** via the bare name
  `powershell.exe`, so on a machine whose PATH has lost
  `%SystemRoot%\System32\WindowsPowerShell\v1.0` (edited/truncated PATH, hardened or
  "debloated" Windows) the spawn failed — and because `MachineCredentialStore.write()` did not
  map codec failures the way `readState()` does, the raw errno error escaped the credential
  persist that runs immediately AFTER a successful sign-in. The user could complete OAuth over
  and over and never get past login. The host is now resolved by **absolute path with
  fallbacks** (`powerShellHostCandidates`): `$AIGD_DPAPI_POWERSHELL` (only when absolute and
  existing) → `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` →
  `<SystemRoot>\SysWOW64\...` → `pwsh.exe` → `powershell.exe`, cached per environment
  fingerprint so the hot `readState()` path does not re-probe the filesystem.

### Added

- **`MachineCredentialStoreUnwritableError`** — the write-side mirror of
  `MachineCredentialStoreUnreadableError`. `write()` now maps any at-rest codec failure to this
  structured error, whose message names the remedy (add the PowerShell directory to PATH, or set
  `AIGD_DPAPI_POWERSHELL`) and never carries the raw error or any token material (the original
  error rides on `cause`). The encrypt-before-any-file-touch ordering is unchanged, so the throw
  leaves an existing `credentials.json` byte-identical with no temp sibling behind.
- **`AIGD_DPAPI_POWERSHELL`** (`DPAPI_POWERSHELL_HOST_ENV`) — a support lever to point the DPAPI
  codec at a specific PowerShell binary with no release. Honoured ONLY when it is an absolute
  path that exists; a bare/relative value is ignored rather than resolved through PATH.
- **`CredentialPlane` `"hub"`** — the plugin-plane credential proper (`families.plugin`, then
  `families.legacy`), for a caller connecting to the SignalR hub, which validates on the PLUGIN
  plane. It is what `"plugin"` resolved to before the run-tool 401 fix above.

## 0.4.1 — 2026-08-24

### Fixed

- **`invalid_target` on refresh is terminal** (defensive hardening, b1): an `invalid_target`
  OAuth error on a refresh attempt now takes the same terminal path as `invalid_grant` —
  post-failure store re-read, then the dead-family memo (never a retry loop; re-arms when
  another surface replaces the credential) — with its own raw reason preserved end-to-end in
  the dead-family telemetry and warning, never remapped. The TS refresher sends no `resource`
  on refresh, so a conformant authorization server cannot answer `invalid_target` today; the
  mapping exists so any future resource-bearing refresh inherits sane terminal behavior
  instead of retry-forever via the generic `failed` path.

## 0.4.0 — 2026-08-15

The unified-machine-auth release: credential store v2, the cross-process store lock, and
`MachineCredentialProvider` as the single credential access + refresh entry point.

### Added

- **Machine credential store v2** (`MachineCredentialStore`): per-plane token **families** schema
  (`families.plugin` / `families.tools` / `families.legacy`) with a v1 compatibility mirror
  (`applyV1CompatMirror`, `adoptToV2`, `effectiveFamilies`), schema-version passthrough,
  explicit unreadable-store state (`MachineCredentialStoreUnreadableError` — the file is never
  overwritten on read failure), and credential-loss-mitigation degradation.
- **Cross-process credential-store lock**: `MachineCredentialLock` implementing the shared lock
  protocol (`credentials.lock` + takeover file, stale-lock classification, acquire budget),
  `CredentialLockBusyError`, `parseLockContent`, `classifyLockDocument`. The C# twin implements
  the same protocol; both sides interoperate on one store directory.
- **`MachineCredentialProvider` — THE single entry point for credential access + refresh**:
  family-aware (`getAccessToken({ family })`), lock-guarded, double-checked refresh (re-reads the
  store under the lock before refreshing so concurrent processes never double-spend a refresh
  token), structured telemetry sink (`onTelemetry`), `defaultClientId` fallback for families that
  store no client id. Nothing else re-implements refresh.
- **RFC 8693 token exchange**: `HttpTokenExchangeClient`, `buildTokenExchangeForm`,
  `buildTokenExchangeResult` (frozen wire shape; hub audience).
- **Login-surface commit plumbing**: `commitAgentLogin` and friends — two-lock-hold commit,
  tools-only mint support.
- **Atomic-file hardening (Windows)**: `writeFileAtomicSync` now retries the final rename on the
  Windows transient-holder error shapes (`EPERM`/`EACCES`/`EBUSY`), `RENAME_RETRY_ATTEMPTS` (5) ×
  `RENAME_RETRY_DELAY_MS` (250 ms), so a concurrent reader holding the destination open no longer
  fails the write. `tempSiblingPathFor` exported for the lock/store temp-file convention.

### Changed (breaking)

- **`TokenRefresher.refresh` takes a single `TokenRefreshRequest` object** — previously positional
  `(refreshToken, serverTarget?, signal?)`. Implementers and callers of the seam must adopt the
  request shape.
- **`buildRefreshForm(refreshToken, clientId)`** — the refresh wire rules now send the **stored**
  `client_id` and no `scope`/`resource` parameters.
- `MachineCredentials` documents are written in the v2 families schema (v1 documents are read and
  adopted; a v1 compatibility mirror is maintained for older readers).

### Verified

- **Cross-language golden-vector parity**: committed golden vectors pin store-v2 documents,
  cohort derivation, and DPAPI round-trips byte-compatible between this TypeScript implementation
  and the C# twin — either side reads the other's store.
- **Mixed-language real-process concurrency suite**: real TS + C# processes contending on one
  store directory against a fake authorization server — single refresh under contention, no lost
  writes, no double-spend.

## 0.3.0 — 2026-07-25 and earlier

Releases before 0.4.0 (0.1.0, 0.2.0, 0.3.0) predate this changelog; see the git history.
