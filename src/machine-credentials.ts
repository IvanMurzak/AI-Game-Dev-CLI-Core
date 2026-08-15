import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeFileAtomicSync } from "./atomic-file.js";

/**
 * TypeScript client of the shared machine credential store — the same on-disk contract the plugin's
 * C# `MachineCredentialStore` (MCP-Plugin-dotnet, `com.IvanMurzak.McpPlugin.AgentConfig`) reads and
 * writes. A single ai-game.dev account credential lives once per machine at
 * `~/.ai-game-dev/credentials.json`, so `login` writes it here and every engine plugin/CLI reads it —
 * sign-in happens once per machine, never per project, and the credential is NEVER written into a
 * project file / VCS.
 *
 * **Schema v2 (unified-machine-auth 04 §1):** the document carries per-plane token families under
 * `families.{agent,plugin,legacy}`, each with its own `clientId` + `scope`. For the transition
 * window every v2 write also mirrors the **plugin-plane** family's three token fields at top level
 * (v1 compat mirror), because the shipped v1 readers key on top-level `accessToken`. A v1 document
 * (`{version:1, accessToken…}`) is interpreted as `families.legacy`; the first write by updated
 * code upgrades it to v2 (+mirror). See {@link adoptToV2} / {@link effectiveFamilies}.
 *
 * **At-rest protection matches the C# store byte-for-byte so the plugin can read what the CLI wrote:**
 *   - **POSIX** — plaintext JSON, file mode `0600`, inside a `0700` directory.
 *   - **Windows** — DPAPI-encrypted (CurrentUser scope, no entropy) via
 *     `System.Security.Cryptography.ProtectedData`, invoked through PowerShell. This is
 *     interoperable with the C# store's `CryptProtectData`/`CryptUnprotectData` (the description
 *     string and `CRYPTPROTECT_UI_FORBIDDEN` flag do not affect decryptability).
 *
 * **Unreadable store ≠ empty store (04 §1):** when the DPAPI unprotect fails (password reset,
 * roaming profile, service account, corrupted blob) or the PowerShell codec is blocked entirely
 * (WDAC/AppLocker **Constrained Language Mode** blocks `Add-Type`), the store surfaces a distinct
 * structured `"unreadable"` state via {@link MachineCredentialStore.readState} — it never crashes
 * the caller with a raw spawn error, never deletes the file, and never lets a background write
 * ({@link MachineCredentialStore.rotate}) overwrite it. Only an explicit re-authorization
 * (a fresh {@link MachineCredentialStore.write} from a login flow) may replace an unreadable store.
 *
 * **Corruption safety (auth-fixes design 03 F4 / DoD):** writes go through
 * {@link ../atomic-file.writeFileAtomicSync} — a **same-directory sibling** temp file that is
 * fsync'd and permission-restricted, then atomically `rename`d over the target (with an advisory
 * parent-directory fsync on POSIX). A crash, an exception while encrypting, or a full disk
 * therefore never leaves a torn/half-written `credentials.json` — the previous good file (or no
 * file) survives. See {@link MachineCredentialStore.write}.
 */

/** Directory name under the user home (or a project root) that holds the store. */
export const MACHINE_STORE_DIR_NAME = ".ai-game-dev";

/** File name of the secret credential document. */
export const CREDENTIALS_FILE_NAME = "credentials.json";

/** Schema version of the flat single-credential document (top-level token fields only). */
export const CREDENTIALS_SCHEMA_VERSION_V1 = 1;

/** Schema version of the families document (04 §1: `families.{agent,plugin,legacy}` + v1 mirror). */
export const CREDENTIALS_SCHEMA_VERSION_V2 = 2;

/**
 * @deprecated The store no longer stamps one global version on every write — {@link
 * MachineCredentialStore.write} persists each document's **actual** version (04 §1 "version
 * passthrough"; force-stamping produced hybrid `{version:1, families:{…}}` documents, 06
 * §Rollback). Kept at the v1 value so existing `version === CREDENTIALS_SCHEMA_VERSION` checks
 * retain their meaning ("is this a v1 document"). Use the V1/V2 constants explicitly.
 */
export const CREDENTIALS_SCHEMA_VERSION = CREDENTIALS_SCHEMA_VERSION_V1;

/**
 * One token family (04 §1): the token triple plus the OAuth client identity it was minted under.
 * `clientId`/`scope` are REQUIRED for the `agent`/`plugin` families (written from the value
 * actually presented at mint/exchange — never inferred) and absent BY DEFINITION for `legacy`
 * (a v1 credential's mint client is unknown). Unknown fields are preserved for forward-compat.
 */
export interface MachineTokenFamily {
  /** The current short-lived JWT access token for this family's plane. */
  accessToken?: string;
  /** The rotating refresh token used to mint a new access token before `expiresAt`. */
  refreshToken?: string;
  /** ISO-8601 absolute expiry of `accessToken`; used to schedule proactive refresh. */
  expiresAt?: string;
  /** OAuth client id the family was minted under (absent for `legacy` — unknown by definition). */
  clientId?: string;
  /** OAuth scope of the family's grant (`mcp:agent` / `mcp:plugin`; absent for `legacy`). */
  scope?: string;
  [key: string]: unknown;
}

/** The per-plane token families of a v2 document (04 §1). Unknown family names are preserved. */
export interface MachineCredentialFamilies {
  /** The `mcp:agent`-scope family (agent plane). */
  agent?: MachineTokenFamily;
  /** The `mcp:plugin`-scope family (plugin plane), minted via RFC 8693 token exchange. */
  plugin?: MachineTokenFamily;
  /** A v1 credential adopted into a v2 document (F11.1) — mint client/scope unknown. */
  legacy?: MachineTokenFamily;
  [key: string]: MachineTokenFamily | undefined;
}

/**
 * The secret credential material persisted in the store. Mirrors the C# `MachineCredentials` schema
 * (camelCase JSON keys). Unknown fields are preserved on read for forward-compatibility.
 *
 * In a **v2** document the top-level `accessToken`/`refreshToken`/`expiresAt` are the v1 COMPAT
 * MIRROR of the plugin-plane family (04 §1) — old readers key on them; updated readers use
 * {@link effectiveFamilies}. In a **v1** document they are the credential itself.
 */
export interface MachineCredentials {
  /** Schema version of the persisted document (1 = flat, 2 = families; written as-is, never stamped). */
  version?: number;
  /** v1: the access token. v2: the v1-compat mirror of the plugin-plane family's access token. */
  accessToken?: string;
  /** v1: the refresh token. v2: the v1-compat mirror of the plugin-plane family's refresh token. */
  refreshToken?: string;
  /** v1: the expiry. v2: the v1-compat mirror of the plugin-plane family's expiry. */
  expiresAt?: string;
  /** The server target the credential was issued for (hosted `https://ai-game.dev` or a local URL). */
  serverTarget?: string;
  /** The account id (`sub`) the credential resolves to. Audit/diagnostic only. */
  subject?: string;
  /** v2 (04 §1): the per-plane token families. Absent in a v1 document. */
  families?: MachineCredentialFamilies;
  [key: string]: unknown;
}

/**
 * Structured result of {@link MachineCredentialStore.readState} (04 §1 "unreadable ≠ empty"):
 *  - `ok` — the document parsed; `credentials` holds it.
 *  - `missing` — no credential file (or an empty one). The machine has no stored credential.
 *  - `unreadable` — a credential file EXISTS but cannot be read (DPAPI unprotect failed, the
 *    PowerShell codec is blocked by Constrained Language Mode, or the content is corrupted).
 *    Callers must surface "sign in required" and MUST NOT delete or overwrite the file until the
 *    user explicitly re-authorizes. This state is why `exists` alone is never a signed-in signal.
 */
export type MachineCredentialStoreState =
  | { status: "ok"; credentials: MachineCredentials }
  | { status: "missing" }
  | { status: "unreadable"; reason: string; cause?: unknown };

/**
 * Thrown by {@link MachineCredentialStore.read} / {@link MachineCredentialStore.rotate} when the
 * store is in the structured `"unreadable"` state — a typed error so callers can distinguish
 * "sign in required (store unreadable)" from a programming error, and so background writers fail
 * CLOSED instead of overwriting a credential file the user can still recover (04 §1).
 */
export class MachineCredentialStoreUnreadableError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`machine credential store unreadable: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = "MachineCredentialStoreUnreadableError";
  }
}

/**
 * The schema version {@link MachineCredentialStore.write} will persist for `credentials` — the
 * document's own version, passed through (04 §1). Defaults by shape when absent (families ⇒ v2,
 * flat ⇒ v1). A families-bearing document is NEVER written with a version below 2: the hybrid
 * `{version:1, families:{…}}` form is exactly what 06 §Rollback forbids shipping.
 */
export function documentSchemaVersion(credentials: MachineCredentials): number {
  const hasFamilies = credentials.families !== undefined;
  if (typeof credentials.version === "number") {
    if (hasFamilies && credentials.version < CREDENTIALS_SCHEMA_VERSION_V2) {
      return CREDENTIALS_SCHEMA_VERSION_V2;
    }
    return credentials.version;
  }
  return hasFamilies ? CREDENTIALS_SCHEMA_VERSION_V2 : CREDENTIALS_SCHEMA_VERSION_V1;
}

/**
 * Return `document` with the v1 COMPAT MIRROR applied (04 §1): in a v2 (families-bearing)
 * document, the top-level token triple is set from the plugin-plane family — `families.plugin`,
 * falling back to `families.legacy` when no plugin family exists (an adopted v1 credential IS the
 * plugin-plane credential). When the document has no plugin-plane family at all, the top-level
 * triple is REMOVED — a stale mirror would hand old readers a token the families say is gone.
 *
 * A v1 document (no `families`) is returned unchanged: its top-level fields are the credential
 * itself, not a mirror.
 */
export function applyV1CompatMirror(document: MachineCredentials): MachineCredentials {
  if (document.families === undefined) {
    return { ...document };
  }
  const mirrored: MachineCredentials = { ...document };
  const source = document.families.plugin ?? document.families.legacy;
  if (source !== undefined) {
    mirrored.accessToken = source.accessToken;
    mirrored.refreshToken = source.refreshToken;
    mirrored.expiresAt = source.expiresAt;
  } else {
    delete mirrored.accessToken;
    delete mirrored.refreshToken;
    delete mirrored.expiresAt;
  }
  return mirrored;
}

/**
 * Upgrade a credential document to schema v2 (04 §1 / F11.1). A v1 document's top-level token
 * triple becomes `families.legacy` (mint client/scope unknown by definition); identity fields
 * (`serverTarget`/`subject`) and every unknown forward-compat field are preserved; the v1 compat
 * mirror is applied. An already-v2 document is returned mirror-normalized. Pure — does not write.
 */
export function adoptToV2(credentials: MachineCredentials): MachineCredentials {
  if (credentials.families !== undefined) {
    return applyV1CompatMirror({ ...credentials, version: documentSchemaVersion(credentials) });
  }

  const { version: _version, accessToken, refreshToken, expiresAt, ...rest } = credentials;
  const hasTokens = accessToken !== undefined || refreshToken !== undefined || expiresAt !== undefined;
  const families: MachineCredentialFamilies = hasTokens
    ? { legacy: { accessToken, refreshToken, expiresAt } }
    : {};
  return applyV1CompatMirror({
    ...rest,
    version: CREDENTIALS_SCHEMA_VERSION_V2,
    families,
  });
}

/**
 * The families view of a credential document, independent of its stored schema version (04 §1
 * v1 read-compat): a v2 document's own `families`; a v1 document's top-level token triple viewed
 * as `families.legacy`. Pure — never mutates or writes.
 */
export function effectiveFamilies(credentials: MachineCredentials): MachineCredentialFamilies {
  if (credentials.families !== undefined) {
    return credentials.families;
  }
  const { accessToken, refreshToken, expiresAt } = credentials;
  if (accessToken === undefined && refreshToken === undefined && expiresAt === undefined) {
    return {};
  }
  return { legacy: { accessToken, refreshToken, expiresAt } };
}

/**
 * The at-rest transform applied to the credential bytes before they hit disk. The default is
 * platform-selected ({@link defaultCredentialCodec}); it is injectable so tests can exercise the
 * store's atomic-write / corruption-safety behaviour without spawning PowerShell, and so a future
 * engine adapter can substitute a different keystore.
 */
export interface CredentialCodec {
  /** Encrypt (or pass through) the plaintext credential document on its way to disk. */
  encrypt(plaintext: Buffer): Buffer;
  /** Decrypt (or pass through) the on-disk credential bytes on their way back to memory. */
  decrypt(ciphertext: Buffer): Buffer;
}

const isWindows = process.platform === "win32";

/** Identity codec — the POSIX at-rest form (plaintext, protected by `0600`/`0700` file modes). */
export const identityCredentialCodec: CredentialCodec = {
  encrypt: (plaintext) => plaintext,
  decrypt: (ciphertext) => ciphertext,
};

/** Windows DPAPI codec (CurrentUser scope) — interoperable with the C# store. */
export const dpapiCredentialCodec: CredentialCodec = {
  encrypt: (plaintext) => dpapiTransform("Protect", plaintext),
  decrypt: (ciphertext) => dpapiTransform("Unprotect", ciphertext),
};

/** The platform-default codec: DPAPI on Windows, plaintext-with-0600 on POSIX (matches C#). */
export const defaultCredentialCodec: CredentialCodec = isWindows
  ? dpapiCredentialCodec
  : identityCredentialCodec;

/**
 * The shared machine credential store. Defaults to `~/.ai-game-dev/`; pass an explicit
 * `baseDirectory` for tests or for the `--project` per-project store (`<project>/.ai-game-dev/`),
 * and an explicit `codec` to override the platform-default at-rest transform (tests).
 */
export class MachineCredentialStore {
  private readonly _baseDirectory: string;
  private readonly _codec: CredentialCodec;

  constructor(baseDirectory?: string, codec: CredentialCodec = defaultCredentialCodec) {
    this._baseDirectory = baseDirectory ?? path.join(os.homedir(), MACHINE_STORE_DIR_NAME);
    this._codec = codec;
  }

  /** Absolute path of the store directory. */
  get baseDirectory(): string {
    return this._baseDirectory;
  }

  /** Absolute path of the secret credential file. */
  get credentialsPath(): string {
    return path.join(this._baseDirectory, CREDENTIALS_FILE_NAME);
  }

  /**
   * True when a credential file exists in the store. **Never a signed-in signal** (04 §1): the
   * file may be present yet unreadable (DPAPI/CLM) — use {@link readState} to decide.
   */
  get exists(): boolean {
    return fs.existsSync(this.credentialsPath);
  }

  /**
   * Encrypt (Windows) / restrict (POSIX) and write `credentials` to the store, creating the store
   * directory with owner-only permissions if needed. The persisted `version` is the DOCUMENT'S
   * OWN version, passed through ({@link documentSchemaVersion} — 04 §1; the store must never
   * force-stamp v1, which produced hybrid `{version:1, families:{…}}` documents, 06 §Rollback).
   * On a v2 (families-bearing) document the v1 compat mirror is normalized on EVERY write
   * ({@link applyV1CompatMirror}). Undefined fields are omitted (matching the C# `WhenWritingNull`
   * policy).
   *
   * This is the EXPLICIT write path (login / re-auth flows) — it intentionally can replace an
   * unreadable store. Background writers go through {@link rotate} / {@link writeFamily}, which
   * refuse to touch an unreadable store.
   *
   * The write is **atomic and corruption-safe**: the document is serialized and encrypted fully in
   * memory (any failure here throws before touching disk), then written to a unique same-directory
   * sibling temp file, fsync'd, permission-restricted, and finally `rename`d over the target. The
   * temp file is always cleaned up on failure, so an interrupted or failed write never corrupts an
   * existing good credential file.
   */
  write(credentials: MachineCredentials): void {
    // Serialize + encrypt BEFORE creating any file: a failure here must not touch the store.
    const document: MachineCredentials = applyV1CompatMirror({
      ...credentials,
      version: documentSchemaVersion(credentials),
    });
    const json = JSON.stringify(document, undefinedOmittingReplacer, 2);
    const bytes = this._codec.encrypt(Buffer.from(json, "utf-8"));

    writeFileAtomicSync(this.credentialsPath, bytes);
  }

  /**
   * Read the store into its structured state (04 §1): `ok` with the parsed document, `missing`
   * when no credential file exists (or it is empty), or `unreadable` when a file exists but
   * cannot be decrypted/parsed — DPAPI unprotect failure, the PowerShell codec blocked by
   * Constrained Language Mode, or a corrupted blob. NEVER throws for an environmental failure and
   * NEVER deletes or rewrites the file: an unreadable store stays on disk untouched until the
   * user explicitly re-authorizes.
   */
  readState(): MachineCredentialStoreState {
    let raw: Buffer;
    try {
      if (!fs.existsSync(this.credentialsPath)) {
        return { status: "missing" };
      }
      raw = fs.readFileSync(this.credentialsPath);
    } catch (err) {
      return {
        status: "unreadable",
        reason: `reading the credential file failed: ${errorMessage(err)}`,
        cause: err,
      };
    }
    if (raw.length === 0) {
      return { status: "missing" };
    }

    let plaintext: Buffer;
    try {
      plaintext = this._codec.decrypt(raw);
    } catch (err) {
      return {
        status: "unreadable",
        reason:
          "decrypting the credential file failed (DPAPI unavailable for this user/session, the " +
          `PowerShell codec is blocked, or the blob is corrupted): ${errorMessage(err)}`,
        cause: err,
      };
    }

    const json = plaintext.toString("utf-8");
    if (json.trim().length === 0) {
      return { status: "missing" };
    }

    try {
      return { status: "ok", credentials: JSON.parse(json) as MachineCredentials };
    } catch (err) {
      return {
        status: "unreadable",
        reason: `parsing the credential document failed (corrupted content): ${errorMessage(err)}`,
        cause: err,
      };
    }
  }

  /**
   * Read and decrypt the stored credentials, or null when none are present / the file is empty.
   * Throws {@link MachineCredentialStoreUnreadableError} when the store exists but is unreadable
   * (04 §1) — callers that need the distinction without an exception use {@link readState}.
   */
  read(): MachineCredentials | null {
    const state = this.readState();
    if (state.status === "ok") {
      return state.credentials;
    }
    if (state.status === "missing") {
      return null;
    }
    throw new MachineCredentialStoreUnreadableError(state.reason, state.cause);
  }

  /**
   * Replace the plugin-plane token material (access + refresh + expiry) while preserving the
   * stored identity fields (`serverTarget` / `subject`), every other family, and any unknown
   * forward-compat fields, then persist atomically. Returns the written credentials.
   *
   * v2 semantics (04 §1): the rotation lands in the plugin-plane family — `families.plugin`,
   * falling back to `families.legacy` — and the v1 compat mirror follows it. A v1 document is
   * adopted to v2 on this write (F11.1 "first write by updated code upgrades"), its credential
   * continuing as `families.legacy`. Mirrors the C# `MachineCredentialStore.Rotate` used by the
   * proactive refresh loop.
   *
   * Fails CLOSED on an unreadable store: throws {@link MachineCredentialStoreUnreadableError}
   * without touching the file — a background refresh must never overwrite a store the user could
   * still recover (04 §1).
   */
  rotate(accessToken: string, refreshToken: string, expiresAt?: string): MachineCredentials {
    const current = this.read() ?? {};
    const adopted = adoptToV2(current);
    const families = adopted.families ?? {};
    const targetFamily: "plugin" | "legacy" = families.plugin !== undefined ? "plugin" : "legacy";
    const rotated: MachineCredentials = applyV1CompatMirror({
      ...adopted,
      families: {
        ...families,
        [targetFamily]: {
          ...families[targetFamily],
          accessToken,
          refreshToken,
          expiresAt,
        },
      },
    });
    this.write(rotated);
    return rotated;
  }

  /**
   * Set one token family in the store (04 §1) and persist atomically: read the current document,
   * adopt it to v2 if it is still v1 (preserving the old credential as `families.legacy` and all
   * unknown fields), replace `family`, re-apply the v1 compat mirror, write. Returns the written
   * document.
   *
   * Fails CLOSED on an unreadable store unless `options.replaceUnreadable` is set — pass it ONLY
   * from an explicit user re-authorization flow (a fresh login owns the store; a background writer
   * never does).
   */
  writeFamily(
    name: "agent" | "plugin" | "legacy",
    family: MachineTokenFamily,
    options: { serverTarget?: string; subject?: string; replaceUnreadable?: boolean } = {},
  ): MachineCredentials {
    const state = this.readState();
    if (state.status === "unreadable" && options.replaceUnreadable !== true) {
      throw new MachineCredentialStoreUnreadableError(state.reason, state.cause);
    }
    const current = state.status === "ok" ? state.credentials : {};
    const adopted = adoptToV2(current);
    const document = applyV1CompatMirror({
      ...adopted,
      ...(options.serverTarget !== undefined ? { serverTarget: options.serverTarget } : {}),
      ...(options.subject !== undefined ? { subject: options.subject } : {}),
      families: {
        ...adopted.families,
        [name]: family,
      },
    });
    this.write(document);
    return document;
  }

  /** Delete the stored credentials (explicit sign-out only). No-op when none exist. */
  delete(): void {
    if (fs.existsSync(this.credentialsPath)) {
      fs.rmSync(this.credentialsPath);
    }
  }
}

/** JSON replacer that omits `undefined`-valued keys (matches C# `JsonIgnoreCondition.WhenWritingNull`). */
function undefinedOmittingReplacer(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a Windows DPAPI Protect/Unprotect round trip through PowerShell's
 * `System.Security.Cryptography.ProtectedData` (CurrentUser scope, no entropy) — interoperable with
 * the C# store's `CryptProtectData`/`CryptUnprotectData`. Input and output are passed as base64
 * through an environment variable so the plaintext never lands in argv or the process table. Only
 * ever invoked on Windows.
 *
 * Under WDAC/AppLocker **Constrained Language Mode** the `Add-Type` call (and any .NET method
 * invocation) is blocked, so PowerShell exits non-zero and `execFileSync` throws — the store maps
 * that throw to the structured `"unreadable"` state instead of crashing (04 §1/§4).
 */
function dpapiTransform(action: "Protect" | "Unprotect", input: Buffer): Buffer {
  const script =
    "$ErrorActionPreference='Stop';" +
    "Add-Type -AssemblyName System.Security;" +
    "$in=[Convert]::FromBase64String($env:AIGD_DPAPI_IN);" +
    `$out=[System.Security.Cryptography.ProtectedData]::${action}($in,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);` +
    "[Convert]::ToBase64String($out)";

  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf-8",
      env: { ...process.env, AIGD_DPAPI_IN: input.toString("base64") },
      timeout: 20000,
      windowsHide: true,
    },
  );

  return Buffer.from(stdout.trim(), "base64");
}
