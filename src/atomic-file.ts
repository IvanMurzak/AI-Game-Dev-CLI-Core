import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Crash-safe, owner-only file primitives shared by every on-disk store this package keeps under
 * `~/.ai-game-dev/` — the {@link ../machine-credentials.MachineCredentialStore} (secret token
 * material) and the {@link ../oauth-dcr.ClientRegistrationStore} (the RFC 7591 dynamic client
 * registration).
 *
 * The write is **atomic**: bytes go to a unique sibling temp file that is `fsync`'d and
 * permission-restricted, then `rename`d over the target. A crash, an exception mid-write, or a full
 * disk therefore never leaves a torn/half-written document — the previous good file (or no file)
 * survives. The temp file is always cleaned up on failure, so a failed write leaves no litter.
 *
 * Extracted from `MachineCredentialStore.write` so both stores get the identical guarantees from ONE
 * implementation; the credential store's corruption-safety specs gate it.
 */

const isWindows = process.platform === "win32";

/** Owner-only file mode (`rw-------`) applied to every store file on POSIX. */
export const OWNER_ONLY_FILE_MODE = 0o600;

/** Owner-only directory mode (`rwx------`) applied to the store directory on POSIX. */
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/**
 * Create `directory` (recursively, no-op when it exists) and restrict it to the owner on POSIX.
 * Windows relies on the user-profile ACL instead — `chmod` there is a no-op that would only mislead.
 */
export function ensureOwnerOnlyDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  if (!isWindows) {
    fs.chmodSync(directory, OWNER_ONLY_DIRECTORY_MODE);
  }
}

/**
 * Atomically write `bytes` to `targetPath`, creating the containing directory owner-only if needed.
 *
 * Callers MUST fully serialize (and, where applicable, encrypt) in memory before calling: any
 * failure there must throw before a single byte touches the store. On POSIX the temp file is created
 * `0600` and re-`chmod`ed before the rename, so the bytes are never briefly world-readable.
 */
export function writeFileAtomicSync(targetPath: string, bytes: Buffer): void {
  const directory = path.dirname(targetPath);
  ensureOwnerOnlyDirectory(directory);

  const tempPath = path.join(
    directory,
    `${path.basename(targetPath)}.${process.pid}.${Date.now().toString(36)}.tmp`,
  );

  let fd: number | undefined;
  try {
    // wx: fail if the temp path somehow already exists (never reuse a stranger's temp).
    fd = fs.openSync(tempPath, "wx", OWNER_ONLY_FILE_MODE);
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (!isWindows) {
      fs.chmodSync(tempPath, OWNER_ONLY_FILE_MODE);
    }
    // Atomic replace: readers see either the old file or the new file, never a torn write.
    fs.renameSync(tempPath, targetPath);
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
