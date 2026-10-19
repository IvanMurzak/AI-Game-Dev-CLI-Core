import { describeErrorWithCause } from "./network-error.js";

/** The MCP server's ping endpoint (a system tool, the same for every engine). */
export const MCP_PING_PATH = "/api/system-tools/ping";

export type McpProbeResult =
  | { ok: true; baseUrl: string; data: unknown }
  /** `status`: the HTTP status when the server answered with an error. */
  | { ok: false; reason: string; status?: number };

/** One POST to `<baseUrl>/api/system-tools/ping`. Never throws. */
export async function probeMcpServer(
  baseUrl: string,
  options: { token?: string; timeoutMs: number; signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<McpProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  try {
    const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}${MCP_PING_PATH}`, {
      method: "POST",
      headers,
      body: "{}",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, status: response.status };
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain-text answer */
    }
    return { ok: true, baseUrl, data };
  } catch (err) {
    return { ok: false, reason: describeErrorWithCause(err) };
  }
}

/**
 * The standard readiness probe for an editor session: ping every URL at once and resolve the first
 * that answers (the others are aborted), or undefined when none does. A 401/403 counts as an
 * answer: the server (so the editor) is up, and the tool call will report the auth problem —
 * treating it as "down" would start a second editor or wait out the whole ready timeout. Pass only
 * the project's LOCAL server URLs: a cloud relay answers whether or not this editor runs.
 */
export function mcpReadinessProbe(options: {
  urls: readonly string[];
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): () => Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return async () => {
    const losers = new AbortController();
    try {
      return await Promise.any(
        options.urls.map(async (url) => {
          const result = await probeMcpServer(url, { ...options, timeoutMs, signal: losers.signal });
          if (!result.ok && result.status !== 401 && result.status !== 403) throw new Error(result.reason);
          return url;
        }),
      );
    } catch {
      return undefined; // none answered (or no URLs)
    } finally {
      losers.abort();
    }
  };
}
