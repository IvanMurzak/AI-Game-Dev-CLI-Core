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

/** How many `cause` links to follow — undici nests at most two; the cap guards a cycle. */
const MAX_CAUSE_DEPTH = 4;

/** Ceiling on the rendered cause text, so one pathological chain cannot flood a message. */
const MAX_CAUSE_LENGTH = 500;

/** One link of the chain: `Name CODE: message [inner; inner]`, without repeating the code. */
function describeLink(value: unknown): string {
  if (!(value instanceof Error)) {
    return String(value);
  }
  const code = (value as { code?: unknown }).code;
  const codeText = typeof code === "string" && code.length > 0 ? code : undefined;
  let text = value.name || "Error";
  if (codeText !== undefined && !value.message.includes(codeText)) {
    text += ` ${codeText}`;
  }
  if (value.message) {
    text += `: ${value.message}`;
  }
  // Node's happy-eyeballs connect rejects with an AggregateError whose OWN message is empty: the
  // per-address attempts are the whole story, so they are listed rather than dropped.
  const inner = (value as { errors?: unknown }).errors;
  if (Array.isArray(inner) && inner.length > 0) {
    text += ` [${inner.map((e) => (e instanceof Error ? e.message || e.name : String(e))).join("; ")}]`;
  }
  return text;
}

/**
 * `err.message` plus ` (cause: …)` for every link of its `cause` chain, or just the message when
 * there is no cause. Never throws.
 */
export function describeErrorWithCause(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const links: string[] = [];
  const seen = new Set<unknown>([err]);
  let current: unknown = err instanceof Error ? err.cause : undefined;
  while (current !== undefined && current !== null && links.length < MAX_CAUSE_DEPTH && !seen.has(current)) {
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
export const UNREACHABLE_PATTERN =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i;
