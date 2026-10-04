/**
 * Render a thrown value as text WITH its `cause` chain.
 *
 * Why this exists: Node's `fetch` (undici) reports every transport failure as the same opaque
 * `TypeError: fetch failed`, and puts the only useful information — the errno and the address it
 * tried — on `err.cause`. Reading `err.message` alone threw that away, so a desktop sign-in that
 * failed for twenty events across two machines reached telemetry as
 * `Could not reach the client registration endpoint: fetch failed` and nothing else: a DNS
 * failure, a refused connection, an intercepting TLS proxy and a happy-eyeballs abort all read
 * identically. With the chain, the same failure reads e.g.
 *
 *     fetch failed (cause: AggregateError ETIMEDOUT [connect ETIMEDOUT 51.81.222.213:443;
 *     connect ECONNREFUSED ::1:443])
 *
 * which names the mechanism (`AggregateError` = Node tried several addresses), the errno, and
 * which address family was reached.
 *
 * SECURITY: transport errors carry errnos, syscalls and the SERVER's address — not request bodies,
 * headers or tokens — so the chain is safe to put in a user-visible / telemetry message. Do not
 * route an error that can quote a request or response body through this helper.
 */

/** `err.message` for an Error, `String(err)` for anything else. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `String(value)` that cannot throw: a null-prototype object or a throwing `toString` would
 * otherwise escape from the catch blocks this module is called from (which promise "never throws").
 */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** How many `cause` links to follow — undici nests at most two; the cap guards a cycle. */
const MAX_CAUSE_DEPTH = 4;

/** Ceiling on the rendered cause text, so one pathological chain cannot flood a message. */
const MAX_CAUSE_LENGTH = 500;

/** One link of the chain: `Name CODE: message [inner; inner]`, without repeating the code. */
function describeLink(value: unknown): string {
  if (!(value instanceof Error)) {
    // A non-Error cause (e.g. a plain `{ code, message }` object) would render as
    // `[object Object]`; surface its message/code when it has them.
    if (typeof value === "object" && value !== null) {
      const { code, message } = value as { code?: unknown; message?: unknown };
      const parts = [code, message].filter((part): part is string => typeof part === "string" && part !== "");
      if (parts.length > 0) {
        return parts.join(": ");
      }
    }
    return safeString(value);
  }
  const code = (value as { code?: unknown }).code;
  let text = value.name || "Error";
  if (typeof code === "string" && code && !value.message.includes(code)) {
    text += ` ${code}`;
  }
  if (value.message) {
    text += `: ${value.message}`;
  }
  // Node's happy-eyeballs connect rejects with an AggregateError whose OWN message is empty: the
  // per-address attempts are the whole story, so they are listed rather than dropped.
  const inner = (value as { errors?: unknown }).errors;
  if (Array.isArray(inner) && inner.length > 0) {
    text += ` [${inner.map((e) => (e instanceof Error ? e.message || e.name : safeString(e))).join("; ")}]`;
  }
  return text;
}

/**
 * `err.message` plus ` (cause: …)` for every link of its `cause` chain, or just the message when
 * there is no cause. Never throws.
 */
export function describeErrorWithCause(err: unknown): string {
  try {
    return describeErrorWithCauseUnsafe(err);
  } catch {
    return err instanceof Error ? err.message : safeString(err);
  }
}

function describeErrorWithCauseUnsafe(err: unknown): string {
  const message = err instanceof Error ? err.message : safeString(err);
  const links: string[] = [];
  const seen = new Set<unknown>([err]);
  let current: unknown = err instanceof Error ? err.cause : undefined;
  while (current != null && links.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
    seen.add(current);
    links.push(describeLink(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  if (links.length === 0) {
    return message;
  }
  let cause = links.join(" <- ");
  if (cause.length > MAX_CAUSE_LENGTH) {
    cause = `${cause.slice(0, MAX_CAUSE_LENGTH - 1)}…`;
  }
  return `${message} (cause: ${cause})`;
}

/**
 * Errnos / undici codes that mean "the server could not be reached at all" rather than "the server
 * answered and refused". Matched against {@link describeErrorWithCause}'s output, so a code that
 * only appears on the cause (where undici puts it) still classifies.
 */
const UNREACHABLE_PATTERN =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i;

/**
 * The user-facing message for a transport failure in an OAuth flow (auth-code and device): prefixed
 * `Cannot reach the authorization server:` when it is an unreachable-server failure, else
 * `Authentication failed:` — always WITH the cause chain.
 */
export function describeAuthNetworkError(err: unknown): string {
  const message = describeErrorWithCause(err);
  if (UNREACHABLE_PATTERN.test(message)) {
    return `Cannot reach the authorization server: ${message}`;
  }
  return `Authentication failed: ${message}`;
}
