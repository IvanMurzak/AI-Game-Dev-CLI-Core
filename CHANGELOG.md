# Changelog

All notable changes to `@baizor/gamedev-cli-core`.

Versions are set at publish time by the `release.yml` workflow input (`gh workflow run release.yml
-f version=X.Y.Z`); `package.json` intentionally stays at `0.0.0` in-repo. On the 0.x line the
MINOR component is the breaking-capable one (caret consumers on `^0.3.0` do not auto-resolve
`0.4.0` — adopt deliberately).

## Unreleased

### Fixed

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
