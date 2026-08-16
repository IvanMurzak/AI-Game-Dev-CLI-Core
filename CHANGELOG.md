# Changelog

All notable changes to `@baizor/gamedev-cli-core`.

Versions are set at publish time by the `release.yml` workflow input (`gh workflow run release.yml
-f version=X.Y.Z`); `package.json` intentionally stays at `0.0.0` in-repo. On the 0.x line the
MINOR component is the breaking-capable one (caret consumers on `^0.3.0` do not auto-resolve
`0.4.0` — adopt deliberately).

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
