# Changelog

All notable changes to `@baizor/gamedev-cli-core`.

Versions are set at publish time by the `release.yml` workflow input (`gh workflow run release.yml
-f version=X.Y.Z`); `package.json` intentionally stays at `0.0.0` in-repo. On the 0.x line the
MINOR component is the breaking-capable one (caret consumers on `^0.3.0` do not auto-resolve
`0.4.0` — adopt deliberately).

## Unreleased

### Added — the account-switch question about the surface's own account (minor: 0.8.0)

- **`fallbackStoredSubject` on `commitAgentLogin` (and `runAccountSwitchGuard`), a third
  `evaluateAccountSwitch` parameter.** The account the login surface is signed in as (the App's
  session subject). When the machine store names no account (missing, unreadable, or subject-less), a
  mint for another account asks `confirmAccountSwitch` with it as `storedSubject`, exactly as a
  store-named account is asked: a decline revokes the mint and writes nothing (`switch-declined`), no
  callback declines. A confirmed switch writes as a login to an account-less store does (merged in;
  families of an unknown account are kept, not revoked). A store naming any account other than the new
  one, the fallback account included, written while the question waited aborts the commit
  (`guard-premise-changed`): nothing is replaced and the surface asks again on retry. A store that names
  an account is compared as before and the fallback is ignored. Omitted: unchanged behaviour. Consumers
  that rely on the question must require `^0.8.0`.

## 0.7.2 — 2026-10-23

### Fixed — credential refresh robustness (production `invalid_grant` loops)

- **Client-id fallback for families that store no `clientId`.** An old engine plugin that predates
  the `families` schema rewrites `credentials.json` as pure v1 (dropping the plugin family's
  `clientId`), and enroll credentials from servers older than a6 carry none either. The CLIs read
  those as a client-less family and refreshed them with their OWN id (`unity-mcp-cli`,
  `godot-cli`), which the server refuses with `client_id does not match the refresh token` — a
  check it makes on a live token without writing anything. `MachineCredentialProvider` now presents
  the other first-party ids on exactly that answer (the CLI's sibling plugin first, then
  `agd_enroll`, then the rest of `FIRST_PARTY_REFRESH_CLIENT_IDS`), within one lock hold and a 20 s
  budget, and records the id that worked on the family. A family with a stored `clientId` is never
  re-presented under another id. A mismatch on every candidate is reported as "the saved sign-in
  was issued to another application … sign in again" — never as a family death (no `family-dead`
  telemetry, nothing persisted). New option `fallbackClientIds` (`[]` disables); the candidates
  come from the engine adapters (new optional `EngineAdapter.pluginClientId`).
- **Dead-family verdicts persist across processes.** The verdict is written as the hash-only sidecar
  `plugin-dead-family.json` next to the store (`{version, refreshTokenSha256, reason,
  declaredDeadAt}` — the same file MCP-Plugin-dotnet's `PersistedDeadFamilyMemo` uses), so the
  next CLI run no longer re-presents a token the server already declared dead. A client-id mismatch
  is never persisted, and a recorded mismatch verdict is ignored. New exports
  `PersistedDeadFamilyMemo`, `DEAD_FAMILY_MEMO_FILE_NAME`, `hashRefreshToken`; option
  `persistDeadFamilyMemo` (default `true`).
- **Transient refresh failures are retried inside the server's rotation grace window.** A network
  error, timeout, 5xx/429/408 or non-JSON body is now `transient` on `TokenRefreshResult` (a
  throwing refresher counts as transient too, and a transient response is never a dead verdict even
  when it carries `invalid_grant`). When the caller needs a new token (expired, or a reactive
  `refresh()`), the provider retries once after ~1 s — re-reading the store first, so a peer's
  rotation is adopted, and presenting the client id whose attempt failed transiently first, so the
  retry hits the server's same-client grace. Then the family is held back for
  `TRANSIENT_REFRESH_COOLDOWN_MS` (5 s) instead of the whole 60 s skew window — a lost rotation
  response no longer turns into `reuse detected; token family revoked`. New option
  `transientRetryDelayMs`.
- **Clearer sign-in messages.** `TokenRefreshResult` failures carry the server's `error_description`
  (`description`; also on the `family-dead` telemetry event). A dead family raises
  `LoginRequiredError("login required: the saved sign-in is no longer valid (invalid_grant: refresh
  token has expired); sign in again")`; an expired token whose refresh failed transiently says
  "retry shortly" instead.

## 0.7.1 — 2026-10-19

Follow-ups to `EditorSession` from the Unity, Godot and Unreal CLI integrations. New options are
opt-in, but some defaults change for every consumer on `^0.7.0` — see **Changed**.

### Added — editor-session follow-ups

- **The lease records the server.** New `EditorSessionOptions.serverUrl` / `connectionMode`, written
  into the lease as optional `SessionLease.serverUrl` / `connectionMode`, so `close --owned-only` and
  `open` reach the editor's plugin without a `--url`. Leases written by 0.7.0 (without them) still
  parse. New `readSessionLease(projectRoot)` reads the lease before any session (or connection) is
  built.
- **`beforeLaunch(projectRoot, mode, { editorBinary })`** — runs only when this call is about to
  start the editor (never when it reuses, joins or waits for one), after the binary is resolved,
  under the startup lock. Concurrent cold callers wait for it and then join the editor, so a
  pre-launch C# build (Godot) or UBT build (Unreal) runs once per project. The lock is
  **heartbeated** while held (new `MachineCredentialLock` option `heartbeat`, which runs the new
  `refresh()` — bumping the mtime peers judge staleness by — every quarter of the staleness bar; also
  new: the `onWait` option and `takeoverFileName(lockFileName)`), so a build longer than the 60 s
  staleness bar is never taken over; a crashed holder stops heartbeating and is still taken over
  after 60 s. If the lock was nevertheless taken over while the hook ran (e.g. the machine slept
  through the heartbeat), nothing is launched and the session decides again (normally joining the
  peer's editor). Waiters keep waiting for a live holder up to `startupLockWaitMs` (default
  `DEFAULT_SESSION_STARTUP_LOCK_WAIT_MS`, 30 min), reporting "Waiting for another CLI call that is
  starting the editor..." through `onStatus`. A throwing hook propagates from `ensure` unchanged (no
  editor started, lock released) — including a `CredentialLockBusyError` of another lock. The hook
  must not block the event loop.
- **`requestClose(pid, projectRoot, lease)`** — the adapter hook now receives the verified lease
  (nonce, `serverUrl`), so engines no longer re-read it.
- **Foreign editors.** `findRunningEditor` may return the editor's pid instead of `true`. While a
  foreign editor is waited for, the session notices when it exits (pid gone, or — pid unknown — the
  hook no longer finds it on two re-checks in a row; re-run every `foreignRecheckIntervalMs`,
  default 10 s) and decides again. New `foreignReadyTimeoutMs` (default `readyTimeoutMs`) fails fast
  on a foreign editor whose MCP server never answers, with a generic hint in the message.
- **`EditorSessionError.source`** (`foreign` / `owned` / `started`) on `exited` / `not-ready`: which
  editor was waited for, so CLIs can tailor their hint (new type `WaitedEditorSource`).
- **`ensureAiGameDevGitignore(projectRoot, entries)`** and `SESSION_GITIGNORE_ENTRIES`
  (`session.json`, `session.lock`, `session.lock.takeover`): makes sure
  `<project>/.ai-game-dev/.gitignore` lists the entries — created when absent, otherwise only the
  missing lines are appended in the file's line ending; user lines are never rewritten and a user's
  `!entry` negation is respected. Best-effort (returns false, never throws). Usable for the
  per-project credential files too.
- `WaitForReadyOptions.stopReason` may be async (a throw counts as "not stopped").

### Changed — default behaviour (consumers on `^0.7.0` get these without opting in)

- **A launch writes `<project>/.ai-game-dev/.gitignore`** (see above). Opt out with
  `gitignore: false`.
- **A held startup lock is waited for up to 30 min** (`startupLockWaitMs`) instead of failing with
  `lock-busy` after the 75 s acquire budget. Invalid values (NaN, negative, infinite) of
  `startupLockWaitMs`, `readyTimeoutMs`, `foreignReadyTimeoutMs` and `foreignRecheckIntervalMs` fall
  back to their defaults. Lease cleanup after a close or a failed start waits at most 5 s for the
  lock (a busy lock leaves the dead lease for the next `ensure`).
- **A foreign editor that exits while waited for no longer fails `ensure`**: the session starts its
  own editor. This fixes the Unity race where the plugin deletes the lease just before it exits and
  a parallel `exec` waited out the whole ready timeout on the dying editor. Up to three
  decide-and-wait rounds per `ensure` (0.7.0: two).
- The `not-ready` message for a foreign editor now explains that its MCP server did not answer.
- `EditorLaunchSpec.findRunningEditor` returns `Promise<boolean | number>` (implementations
  returning `boolean` still type-check; code that calls the hook and expects a `boolean` must
  handle a pid).
- **The editor binary is resolved only once a launch is decided** (no live editor of the project,
  ours or foreign), outside the startup lock, at most once per `ensure`. 0.7.0 started resolving it
  as soon as the warm probe failed, even when the call then joined an editor.

## 0.7.0 — 2026-10-19

### Added — editor sessions (`EditorSession`, Code-Exec §4.6)

- **`EditorSession`** — the shared policy behind `exec` / `open --headless` / `close --owned-only`
  for the Unity, Godot and Unreal CLIs. `ensure({ mode })` reuses any live editor of the project
  (ours or the user's, never closed by us); otherwise it starts one (headless by default, `window`
  optional) with `AIGD_SESSION_IDLE_SECONDS` / `AIGD_SESSION_OWNER=cli` / `AIGD_SESSION_NONCE` in
  its environment and waits for the readiness probe. `closeOwned({ timeoutMs, force })` closes only
  an editor named by a valid lease; `prepareWindowOpen()` stops our headless editor before a GUI
  open. Errors are `EditorSessionError` with a `reason` (`unsupported`, `no-editor-binary`,
  `launch-failed`, `exited`, `not-ready`, `lock-busy`).
- **Lease** `<project>/.ai-game-dev/session.json` (`pid`, `nonce`, `engine`, `mode`, `startedAt`,
  `ownedBy: "cli"`, `hostId`, `processStart`), written atomically. A lease is valid only on the
  same host, with the pid alive and its OS process start time unchanged (a reused pid never
  matches; an unverifiable start time is treated as not ours — never closed, but waited for rather
  than replaced by a second editor). Stale leases are removed by
  compare-and-delete on the nonce.
- **One start per project**: the decide-and-launch step runs under
  `<project>/.ai-game-dev/session.lock` (the `MachineCredentialLock` protocol); concurrent cold
  callers wait for the editor the winner started instead of launching a second one.
- **Readiness helpers**: `waitForReady` (generic poll with a stop reason), `probeMcpServer` and
  `mcpReadinessProbe` (`POST /api/system-tools/ping`, first answering URL wins, losers aborted;
  a 401/403 counts as an answering server). Process helpers:
  `isProcessAlive`, `readProcessStart`, `defaultSessionProcessOps`.
- **`EngineAdapter.editor?: EditorLaunchSpec`** (optional — adapters defined elsewhere keep
  compiling): `args(projectRoot, mode)`, optional `requestClose(pid, projectRoot)` and
  `findRunningEditor(projectRoot)`. Built in: Unity `-batchmode -projectPath` (graphics kept) /
  `-projectPath`; Godot `--headless --editor --path` / `--editor --path`; Unreal
  `<uproject> -RenderOffscreen -unattended -nosplash` / `<uproject>` (new `findUprojectFile`).
  Brutal has none. The editor binary stays with each CLI (passed as `editorBinary`).
- `MachineCredentialLockOptions.lockFileName` — reuse the lock protocol under another file name
  (intent `<name>.takeover`). The credential store keeps the default.

### Added — Brutal engine adapter

- **New engine `brutal`** (the BRUTAL C# framework, a .NET 10 project). `EngineId` and
  `ProjectKeyEngine` gain `"brutal"`; the new exported `brutalAdapter` (also in `engineAdapters`)
  mirrors Godot: client id `brutal-cli`, server entry `ai-game-developer`, http-only (stdio is
  rejected), server installed flat under `<project>/.ai-game-dev/server/`, AS-root login target.
- **New project-marker kind `csproj-ref`** (`{ kind: "csproj-ref"; packagePrefix }`): matches when a
  `*.csproj` directly in the project root (non-recursive) has an `Include="<prefix>…"` reference
  (prefix case-insensitive, single or double quotes, whitespace tolerated; XML comments ignored). The Brutal marker is
  `Ahwoo.BRUTAL.`, so a Godot C# `*.csproj` without that reference does not match.
  `probeProjectMarkers` now switches exhaustively over marker kinds. Consumers that switch over
  `ProjectMarkerSpec.kind` or exhaustively over `EngineId` must handle the new members.

### Fixed — sign-in failures are diagnosable; a cold DPAPI start no longer fails the login commit

- **Network failures keep their cause.** undici reports every transport failure as `TypeError:
  fetch failed` and keeps the errno and address only on `err.cause`; the OAuth flows read
  `err.message` alone, so the desktop's `Could not reach the client registration endpoint: fetch
  failed` (GlitchTip desktop #364) said nothing about WHY. Registration, the auth-code and device
  flows, token refresh and token exchange now append the cause chain via the new exported
  `describeErrorWithCause` — e.g. `fetch failed (cause: AggregateError ETIMEDOUT [connect ETIMEDOUT
  51.81.222.213:443; connect ENETUNREACH 2604:…:443])`. Messages that previously ended in `fetch
  failed` are now longer; nothing else about the result shapes changes.
- **A cold DPAPI PowerShell start no longer fails the login commit.** A cold PowerShell 5.1 start on
  a slow machine overran the 20 s budget and the post-approval credential write threw
  `MachineCredentialStoreUnwritableError` (`spawnSync … powershell.exe ETIMEDOUT`, GlitchTip desktop
  #1260). `commitAgentLogin` / `commitToolsOnlyLogin` now first `await store.warmUpCodec()` — an
  ASYNC, lock-free throwaway round trip with a 60 s budget (no-op off Windows and once warm) — so the
  synchronous calls under the lock run warm. No synchronous call is retried or lengthened: the event
  loop is never blocked longer than before, and the lock's stale-ordering contract
  (readState + Protect + HTTP < `LOCK_STALE_MS`) still holds. New: `MachineCredentialStore.warmUpCodec()`.

## 0.6.0 — 2026-09-24

> **Upgrading from 0.5.x:** consumers on `^0.5.0` do not receive 0.6.0 (0.x MINOR); widen the
> range to `^0.6.0` to get the `regenerateKey` fix below. Changes a consumer can observe:
> `SetupMcpPlan.configPaths` and the success result's `configPaths` are new REQUIRED fields, and
> `writeSetupMcpPlan` now writes `plan.configPaths` (not `plan.configPath`), so a hand-built plan
> must carry them. `setupMcp` now returns `failure` when a config file cannot be written, for EVERY
> agent (0.5.x reported `success`). An Antigravity install configured by 0.5.x in only one of its two
> files now reports "not configured" until Configure is re-run.

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
> **Known issue (fixed in 0.6.0 — widen to `^0.6.0`):** `setupMcp({ regenerateKey: true })` rewrites only the one
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
