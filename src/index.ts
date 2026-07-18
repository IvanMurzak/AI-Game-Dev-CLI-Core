/**
 * @baizor/gamedev-cli-core — shared CLI core for the AI Game Dev engine CLIs.
 *
 * The security- and correctness-critical modules the Unity/Unreal/Godot CLIs consume as thin
 * adapters (auth-fixes design task b2):
 *   - project identity / pin (v1 + v2), gated by the SAME golden vectors as the C# LIB;
 *   - the machine credential store (`~/.ai-game-dev/credentials.json`, DPAPI/0600, atomic writes);
 *   - the OAuth 2.1 device-grant login (RFC 8628) + the proactive/reactive refresh loop.
 *
 * The remaining modules (agents-registry, setup-mcp, install-plugin, enroll, server-download, …)
 * land in task b3.
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
