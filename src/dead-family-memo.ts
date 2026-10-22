import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomicSync } from "./atomic-file.js";
import { isClientIdMismatchText } from "./token-refresher.js";

/**
 * Sidecar file name inside the machine store directory — the SAME file MCP-Plugin-dotnet's
 * `PersistedDeadFamilyMemo` reads and writes, so a dead-family verdict reached by any component
 * (an engine plugin, an engine CLI, the App) stops every other one from re-presenting the token.
 */
export const DEAD_FAMILY_MEMO_FILE_NAME = "plugin-dead-family.json";

/** Lowercase hex SHA-256 of the UTF-8 refresh token (the C# `PersistedDeadFamilyMemo.Hash`). */
export function hashRefreshToken(refreshToken: string): string {
  return crypto.createHash("sha256").update(refreshToken, "utf8").digest("hex");
}

/**
 * The on-disk half of the provider's dead-family memo (04 §3 rule 5, "never loop"). The in-memory
 * memo dies with the process, and every CLI invocation is a new process, so without this sidecar
 * each run re-presents a refresh token the server already declared dead. Holds ONLY the SHA-256 of
 * the dead refresh token, the reason and a timestamp — never the token:
 *
 * `{ "version": 1, "refreshTokenSha256": "<hex>", "reason": "...", "declaredDeadAt": "<ISO-8601>" }`
 *
 * Everything is best-effort: an unreadable sidecar is "no memo" (at worst one extra network
 * attempt) and a failed write is swallowed — this class never throws into the refresh path. It
 * never creates the store directory (no store ⇒ no credential to memoize against).
 */
export class PersistedDeadFamilyMemo {
  readonly filePath: string;

  constructor(baseDirectory: string) {
    this.filePath = path.join(baseDirectory, DEAD_FAMILY_MEMO_FILE_NAME);
  }

  /**
   * The recorded reason when the sidecar declares `refreshToken` dead; `undefined` otherwise. A
   * recorded client-id mismatch is never a verdict (rule 7), whoever wrote it.
   */
  match(refreshToken: string): { reason: string } | undefined {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const record = parsed as Record<string, unknown>;
      if (record.refreshTokenSha256 !== hashRefreshToken(refreshToken)) return undefined;
      const reason = typeof record.reason === "string" ? record.reason : "";
      return isClientIdMismatchText(reason) ? undefined : { reason };
    } catch {
      return undefined;
    }
  }

  /** Record `refreshToken` (hashed) as dead. Atomic temp-and-rename, owner-only. */
  write(refreshToken: string, reason: string, atMs: number): void {
    try {
      if (!fs.existsSync(path.dirname(this.filePath))) return;
      const document = {
        version: 1,
        refreshTokenSha256: hashRefreshToken(refreshToken),
        reason,
        declaredDeadAt: new Date(atMs).toISOString(),
      };
      writeFileAtomicSync(this.filePath, Buffer.from(JSON.stringify(document, null, 2), "utf-8"));
    } catch {
      // Best-effort: the next process makes one network attempt and re-learns the verdict.
    }
  }
}
