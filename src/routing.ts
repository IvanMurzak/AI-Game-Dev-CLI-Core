/**
 * Project-pin routing-URL helpers (design 06 D14 / defect B4). The routing pin is the `/p/<pin>`
 * path segment appended to a hub URL so an agent session launched in a project folder routes strictly
 * to that project's engine instance. The pin is a ROUTING segment only — never part of the OAuth
 * identity resource (decision M8), and never recorded as a credential's `serverTarget`
 * ({@link EngineAdapter.loginServerTarget} strips it).
 */

const PIN_SEGMENT_RE = /^[0-9a-f]{8}$/i;

/**
 * Add (or replace) the `/p/<pin>` routing segment on a URL, preserving scheme/host/port and any
 * non-pin path. An existing trailing `/p/<8-hex>` is replaced (never stacked). Falls back to string
 * surgery for a non-absolute URL. Never returns a trailing slash.
 */
export function pinUrl(rawUrl: string, pin: string): string {
  try {
    const url = new URL(rawUrl);
    const segments = stripTrailingPin(url.pathname.split("/").filter(Boolean));
    url.pathname = "/" + [...segments, "p", pin].join("/");
    return url.toString().replace(/\/$/, "");
  } catch {
    const base = rawUrl.replace(/\/+$/, "").replace(/\/p\/[0-9a-f]{8}$/i, "");
    return `${base}/p/${pin}`;
  }
}

/** Remove a trailing `/p/<pin>` routing segment from a URL, leaving the underlying hub URL. */
export function stripPinFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.pathname = "/" + stripTrailingPin(url.pathname.split("/").filter(Boolean)).join("/");
    return url.toString().replace(/\/$/, "");
  } catch {
    return rawUrl.replace(/\/+$/, "").replace(/\/p\/[0-9a-f]{8}$/i, "");
  }
}

function stripTrailingPin(segments: string[]): string[] {
  const idx = segments.findIndex((s) => s === "p");
  if (idx >= 0 && idx === segments.length - 2 && PIN_SEGMENT_RE.test(segments[idx + 1]!)) {
    return segments.slice(0, idx);
  }
  return segments;
}
