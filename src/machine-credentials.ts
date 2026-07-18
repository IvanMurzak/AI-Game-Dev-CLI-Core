import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * TypeScript client of the shared machine credential store — the same on-disk contract the plugin's
 * C# `MachineCredentialStore` (MCP-Plugin-dotnet, `com.IvanMurzak.McpPlugin.AgentConfig`) reads and
 * writes. A single ai-game.dev account credential lives once per machine at
 * `~/.ai-game-dev/credentials.json`, so `login` writes it here and every engine plugin/CLI reads it —
 * sign-in happens once per machine, never per project, and the credential is NEVER written into a
 * project file / VCS.
 *
 * **At-rest protection matches the C# store byte-for-byte so the plugin can read what the CLI wrote:**
 *   - **POSIX** — plaintext JSON, file mode `0600`, inside a `0700` directory.
 *   - **Windows** — DPAPI-encrypted (CurrentUser scope, no entropy) via
 *     `System.Security.Cryptography.ProtectedData`, invoked through PowerShell. This is
 *     interoperable with the C# store's `CryptProtectData`/`CryptUnprotectData` (the description
 *     string and `CRYPTPROTECT_UI_FORBIDDEN` flag do not affect decryptability).
 *
 * **Corruption safety (auth-fixes design 03 F4 / DoD):** writes go to a sibling temp file that is
 * fsync'd and permission-restricted, then atomically `rename`d over the target. A crash, an
 * exception while encrypting, or a full disk therefore never leaves a torn/half-written
 * `credentials.json` — the previous good file (or no file) survives. See {@link write}.
 */

/** Directory name under the user home (or a project root) that holds the store. */
export const MACHINE_STORE_DIR_NAME = ".ai-game-dev";

/** File name of the secret credential document. */
export const CREDENTIALS_FILE_NAME = "credentials.json";

/** Current persisted-document schema version. */
export const CREDENTIALS_SCHEMA_VERSION = 1;

/**
 * The secret credential material persisted in the store. Mirrors the C# `MachineCredentials` schema
 * (camelCase JSON keys). Unknown fields are preserved on read for forward-compatibility.
 */
export interface MachineCredentials {
  /** Schema version of the persisted document (currently 1). */
  version?: number;
  /** The current short-lived JWT access token (MCP audience). */
  accessToken?: string;
  /** The rotating refresh token used to mint a new access token before `expiresAt`. */
  refreshToken?: string;
  /** ISO-8601 absolute expiry of `accessToken`; used to schedule proactive refresh. */
  expiresAt?: string;
  /** The server target the credential was issued for (hosted `https://ai-game.dev` or a local URL). */
  serverTarget?: string;
  /** The account id (`sub`) the credential resolves to. Audit/diagnostic only. */
  subject?: string;
  [key: string]: unknown;
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

  /** True when a credential file exists in the store. */
  get exists(): boolean {
    return fs.existsSync(this.credentialsPath);
  }

  /**
   * Encrypt (Windows) / restrict (POSIX) and write `credentials` to the store, creating the store
   * directory with owner-only permissions if needed. `version` is always written as 1; undefined
   * fields are omitted (matching the C# `WhenWritingNull` policy).
   *
   * The write is **atomic and corruption-safe**: the document is serialized and encrypted fully in
   * memory (any failure here throws before touching disk), then written to a unique sibling temp
   * file, fsync'd, permission-restricted, and finally `rename`d over the target. The temp file is
   * always cleaned up on failure, so an interrupted or failed write never corrupts an existing good
   * credential file.
   */
  write(credentials: MachineCredentials): void {
    // Serialize + encrypt BEFORE creating any file: a failure here must not touch the store.
    const document: MachineCredentials = { ...credentials, version: CREDENTIALS_SCHEMA_VERSION };
    const json = JSON.stringify(document, undefinedOmittingReplacer, 2);
    const bytes = this._codec.encrypt(Buffer.from(json, "utf-8"));

    this.ensureBaseDirectory();

    const target = this.credentialsPath;
    const tempPath = path.join(
      this._baseDirectory,
      `${CREDENTIALS_FILE_NAME}.${process.pid}.${Date.now().toString(36)}.tmp`,
    );

    let fd: number | undefined;
    try {
      // wx: fail if the temp path somehow already exists (never reuse a stranger's temp).
      fd = fs.openSync(tempPath, "wx", 0o600);
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (!isWindows) {
        fs.chmodSync(tempPath, 0o600);
      }
      // Atomic replace: readers see either the old file or the new file, never a torn write.
      fs.renameSync(tempPath, target);
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closing on the error path */
        }
      }
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        /* best-effort cleanup; the target is untouched regardless */
      }
      throw err;
    }
  }

  /** Read and decrypt the stored credentials, or null when none are present / the file is empty. */
  read(): MachineCredentials | null {
    if (!fs.existsSync(this.credentialsPath)) {
      return null;
    }

    const raw = fs.readFileSync(this.credentialsPath);
    if (raw.length === 0) {
      return null;
    }

    const plaintext = this._codec.decrypt(raw);
    const json = plaintext.toString("utf-8");
    if (json.trim().length === 0) {
      return null;
    }

    return JSON.parse(json) as MachineCredentials;
  }

  /**
   * Replace the token material (access + refresh + expiry) while preserving the stored identity
   * fields (`serverTarget` / `subject`) and any unknown forward-compat fields, then persist
   * atomically. Returns the written credentials. Mirrors the C# `MachineCredentialStore.Rotate`
   * used by the proactive refresh loop.
   */
  rotate(accessToken: string, refreshToken: string, expiresAt?: string): MachineCredentials {
    const current = this.read() ?? {};
    const rotated: MachineCredentials = {
      ...current,
      accessToken,
      refreshToken,
      expiresAt,
    };
    this.write(rotated);
    return rotated;
  }

  /** Delete the stored credentials (sign-out). No-op when none exist. */
  delete(): void {
    if (fs.existsSync(this.credentialsPath)) {
      fs.rmSync(this.credentialsPath);
    }
  }

  private ensureBaseDirectory(): void {
    fs.mkdirSync(this._baseDirectory, { recursive: true });
    if (!isWindows) {
      fs.chmodSync(this._baseDirectory, 0o700);
    }
  }
}

/** JSON replacer that omits `undefined`-valued keys (matches C# `JsonIgnoreCondition.WhenWritingNull`). */
function undefinedOmittingReplacer(_key: string, value: unknown): unknown {
  return value === undefined ? undefined : value;
}

/**
 * Run a Windows DPAPI Protect/Unprotect round trip through PowerShell's
 * `System.Security.Cryptography.ProtectedData` (CurrentUser scope, no entropy) — interoperable with
 * the C# store's `CryptProtectData`/`CryptUnprotectData`. Input and output are passed as base64
 * through an environment variable so the plaintext never lands in argv or the process table. Only
 * ever invoked on Windows.
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
