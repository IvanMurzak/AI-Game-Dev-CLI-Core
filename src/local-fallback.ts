import { MachineCredentialStore, type MachineCredentialStoreState } from "./machine-credentials.js";

/**
 * The sign-in rule for the local-server fallback, shared by the engine CLIs: a Cloud-mode project on
 * a machine that has signed in to ai-game.dev is never switched to a local server. Only a machine
 * that NEVER signed in (store state `missing`) may serve the project from an editor the CLI starts;
 * a sign-in that cannot be used (expired, revoked, unreadable, a busy store) is refused with
 * `NOT_AUTHENTICATED` (exit 6), so the user signs in again instead of silently changing servers.
 */

export type CredentialStatus = MachineCredentialStoreState["status"];

/**
 * `use-cloud`: the cloud has what it needs (a usable token, or an explicit `--url` / `--token`).
 * `fallback`: never signed in; serve the project from its local server.
 * `refuse-signed-in`: signed in, but the sign-in cannot be used; refuse with NOT_AUTHENTICATED.
 */
export type LocalFallbackDecision = "use-cloud" | "fallback" | "refuse-signed-in";

/**
 * The machine store's status; a store that cannot even be opened counts as `unreadable`, never `missing`.
 * It reads (and on Windows decrypts) the store: a caller that already read it passes that status instead.
 */
export function machineCredentialStatus(store?: MachineCredentialStore): CredentialStatus {
  try {
    return (store ?? new MachineCredentialStore()).readState().status;
  } catch {
    return "unreadable";
  }
}

/**
 * Decide whether a Cloud-mode command may fall back to the project's local server.
 * `cloudSignInMissing`: the command needs the cloud's sign-in and has none (no usable token, no
 * explicit `--url` / `--token`). `credentialStatus` is read only then (a function is called lazily).
 */
export function decideLocalFallback(input: {
  cloudSignInMissing: boolean;
  credentialStatus: CredentialStatus | (() => CredentialStatus);
}): LocalFallbackDecision {
  if (!input.cloudSignInMissing) return "use-cloud";
  const status = typeof input.credentialStatus === "function" ? input.credentialStatus() : input.credentialStatus;
  return status === "missing" ? "fallback" : "refuse-signed-in";
}

/** The NOT_AUTHENTICATED message of a `refuse-signed-in` decision; `cli` names the binary (`unity-mcp-cli`). */
export function signedInButUnusableMessage(cli: string): string {
  return (
    "This machine is signed in to ai-game.dev, but the sign-in cannot be used right now " +
    `(expired, revoked, unreadable, or the credential store is busy). Run \`${cli} login\` to sign in again, or retry. ` +
    "The project stays in Cloud mode: the CLI does not switch it to a local server."
  );
}
