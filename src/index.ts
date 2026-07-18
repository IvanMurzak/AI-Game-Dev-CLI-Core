/**
 * @baizor/gamedev-cli-core — shared CLI core for the AI Game Dev engine CLIs (Unity/Unreal/Godot).
 *
 * The security- and correctness-critical modules the three CLIs consume as thin adapters over ONE
 * source of truth, so every engine derives identical pins, writes identical config bytes, and follows
 * the same auth model (auth-fixes design D1/D4/T7):
 *
 *   b2 (auth core):
 *     - project identity / pin (v1 + v2), gated by the SAME golden vectors as the C# LIB;
 *     - the machine credential store (`~/.ai-game-dev/credentials.json`, DPAPI/0600, atomic writes);
 *     - the OAuth 2.1 device-grant login (RFC 8628) + the proactive/reactive refresh loop.
 *
 *   b3 (shared modules + engine-adapter contract):
 *     - the **engine-adapter contract** (`EngineAdapter`) — the single typed seam carrying every
 *       per-engine difference (serverName, project markers, stdio support, install-dir layout, login
 *       project-sink, client id); ZERO engine-specifics live anywhere else;
 *     - agent-config writers (JSON + TOML) — byte-for-byte parity with the C# `AgentConfig`, golden
 *       gated — plus the engine-neutral agents registry;
 *     - the setup-mcp policy (pinned URL default + `--no-pin` + `--token`-only credential; T4/M7/M8);
 *     - the install-plugin resolution policy (`path? → --path? → cwd` + marker probe; T5/B1);
 *     - enroll (writes the v2 pin, records the AS-root serverTarget — MED-2);
 *     - server-download (SHA256SUMS fail-closed gate + dependency-free in-process unzip);
 *     - project-marker, validation, ui/progress utilities.
 */

/** The package version, mirrored from package.json (bumped by release.yml). */
export const version = "0.0.0";

export { parseSemver, isValidSemver } from "./semver.js";
export type { SemVer } from "./semver.js";

// ── project identity / pin (v1 + v2) ──────────────────────────────────────────────────────────
export {
  MIN_PORT,
  MAX_PORT,
  PORT_RANGE,
  PIN_LENGTH,
  toLowerInvariant,
  // v1 (legacy hash)
  normalize,
  derivePin,
  derivePort,
  deriveProjectPathHash,
  deriveProjectIdentity,
  // v2 (auth-fixes T3 / B5 fix — '\' → '/')
  normalizeV2,
  derivePinV2,
  derivePortV2,
  deriveProjectPathHashV2,
  deriveProjectIdentityV2,
} from "./project-identity.js";
export type { ProjectIdentity } from "./project-identity.js";

// ── machine credential store ──────────────────────────────────────────────────────────────────
export {
  MachineCredentialStore,
  MACHINE_STORE_DIR_NAME,
  CREDENTIALS_FILE_NAME,
  CREDENTIALS_SCHEMA_VERSION,
  identityCredentialCodec,
  dpapiCredentialCodec,
  defaultCredentialCodec,
} from "./machine-credentials.js";
export type { MachineCredentials, CredentialCodec } from "./machine-credentials.js";

// ── OAuth 2.1 device-grant login (RFC 8628) ───────────────────────────────────────────────────
export {
  deviceLogin,
  HttpDeviceAuthTransport,
  decodeJwtSubject,
  deviceAuthorizationUrl,
  tokenUrl,
  OAUTH_DEVICE_AUTHORIZATION_PATH,
  OAUTH_TOKEN_PATH,
  DEVICE_CODE_GRANT_TYPE,
  DEFAULT_PLUGIN_SCOPE,
  DEFAULT_POLL_INTERVAL_MS,
  SLOW_DOWN_INCREMENT_MS,
} from "./oauth-device-flow.js";
export type {
  DeviceAuthorizeResponse,
  DeviceTokenResponse,
  DeviceAuthTransport,
  DeviceLoginOptions,
  DeviceLoginResult,
  HttpDeviceAuthTransportOptions,
} from "./oauth-device-flow.js";

// ── token refresh (HTTP seam + proactive/reactive loop) ───────────────────────────────────────
export {
  HttpTokenRefresher,
  normalizeServerBase,
  buildRefreshForm,
  buildRefreshResult,
} from "./token-refresher.js";
export type {
  TokenRefresher,
  TokenRefreshResult,
  HttpTokenRefresherOptions,
} from "./token-refresher.js";

export {
  MachineCredentialProvider,
  LoginRequiredError,
  DEFAULT_REFRESH_SKEW_MS,
} from "./credential-provider.js";
export type { MachineCredentialProviderOptions } from "./credential-provider.js";

// ── agent-config writers (JSON + TOML; parity with C# AgentConfig, golden-vector gated) ─────────
export {
  JsonAiAgentConfig,
  TomlAiAgentConfig,
  RawTomlValue,
  ValueComparisonMode,
  nodeFs,
  bodyPathSegments,
  DEFAULT_MCP_SERVER_NAME,
  DEFAULT_DEPRECATED_MCP_SERVER_NAMES,
  DEFAULT_IDENTITY_KEYS,
  DEFAULT_BODY_PATH,
  BODY_PATH_DELIMITER,
} from "./agent-config.js";
export type { JsonNode, TomlValue, AgentConfigOptions, AgentConfigFs } from "./agent-config.js";

// ── engine-adapter contract (T7) — the single per-engine seam ───────────────────────────────────
export {
  ridForPlatform,
  serverExecutableName,
  defaultStdioArgs,
  toAuthServerRoot,
  getEngineAdapter,
  engineAdapters,
  unityAdapter,
  unrealAdapter,
  godotAdapter,
  SERVER_BINARY_BASENAME,
  SERVER_ARG_NAMES,
} from "./engine-adapter.js";
export type { EngineAdapter, EngineId, ProjectMarkerSpec, StdioArgsParams } from "./engine-adapter.js";

// ── agents registry ─────────────────────────────────────────────────────────────────────────────
export { agentRegistry, getAgentById, getAgentIds, REQUIRED_PROP_KEYS } from "./agents-registry.js";
export type { AgentDefinition, AgentProps, AgentPropValue } from "./agents-registry.js";

// ── project-pin routing URL helpers ─────────────────────────────────────────────────────────────
export { pinUrl, stripPinFromUrl } from "./routing.js";

// ── project marker (committable per-project `.ai-game-dev/project.json`) ─────────────────────────
export {
  readProjectMarker,
  writeProjectMarker,
  projectMarkerPath,
  projectMarkerDir,
  PROJECT_MARKER_FILE,
} from "./project-marker.js";
export type { ProjectMarker } from "./project-marker.js";

// ── validation helpers ──────────────────────────────────────────────────────────────────────────
export { requireProjectPath, requireExistingPath, resolveProjectPathLadder } from "./validation.js";
export type { ValidatedPath } from "./validation.js";

// ── setup-mcp policy (T4/M7/M8) ─────────────────────────────────────────────────────────────────
export {
  setupMcp,
  resolveSetupMcpPlan,
  writeSetupMcpPlan,
  DEFAULT_HOSTED_MCP_URL,
  PROJECT_ARG_NAME,
} from "./setup-mcp.js";
export type { SetupMcpOptions, SetupMcpResult, SetupMcpPlan, SetupMcpPlanInput, McpTransport } from "./setup-mcp.js";

// ── install-plugin resolution policy (T5/B1) ────────────────────────────────────────────────────
export { resolveInstallTarget, probeProjectMarkers } from "./install-plugin.js";
export type { ResolveInstallTargetOptions, ResolveInstallTargetResult, MarkerProbeResult } from "./install-plugin.js";

// ── enroll (v2 pin, AS-root serverTarget — MED-2) ───────────────────────────────────────────────
export {
  runEnroll,
  redeemEnrollmentCode,
  normalizeRedeemResponse,
  resolveEnrollCode,
  upsertProjectPinIntoConfigs,
  EnrollmentError,
  DEFAULT_CLOUD_BASE_URL,
} from "./enroll.js";
export type { RedeemedCredential, RedeemOptions, RunEnrollOptions, RunEnrollResult, PinUpsertResult } from "./enroll.js";

// ── server download (SHA256SUMS gate + in-process unzip) ────────────────────────────────────────
export { downloadServer, findExtractedBinary, readVersionMarker } from "./server-download.js";
export type { DownloadServerOptions, DownloadServerResult } from "./server-download.js";
export {
  verifyZip,
  parseSha256Sums,
  lookupDigest,
  verifyDigest,
  checksumFailureReason,
  serverChecksumsUrl,
  serverDownloadUrl,
  serverZipAssetName,
  SERVER_RELEASE_REPO,
  SHA256SUMS_ASSET_NAME,
} from "./server-checksum.js";
export type { ChecksumVerdict } from "./server-checksum.js";
export { parseZip } from "./unzip.js";
export type { ZipEntry } from "./unzip.js";

// ── ui / progress utilities ─────────────────────────────────────────────────────────────────────
export { renderTable, truncate } from "./ui.js";
export { emitProgress } from "./progress.js";
export type { ProgressEvent, ProgressCallback } from "./progress.js";
