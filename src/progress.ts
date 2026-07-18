/**
 * The progress-callback seam shared by the cli-core library operations (setup-mcp, install-plugin,
 * enroll, server-download). A library function never writes to stdout; it emits structured
 * {@link ProgressEvent}s so the consuming CLI renders them however it likes (spinner, chalk, JSON).
 * A callback that throws must NEVER abort the underlying operation — {@link emitProgress} swallows it.
 */

/**
 * A single progress event. `phase` is a coarse, operation-specific stage tag and `message` is a
 * human-readable line; individual operations attach extra typed fields (e.g. `filePath`, `url`).
 */
export interface ProgressEvent {
  /** Coarse stage of the operation (e.g. `start`, `manifest-patched`, `done`). */
  phase: string;
  /** Human-readable one-line description of what just happened. */
  message: string;
  /** Operation-specific structured fields (path/url/version/…). */
  [key: string]: unknown;
}

/** A consumer-supplied progress sink. */
export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Forward a single progress event to `onProgress`, swallowing any exception it throws. A broken
 * handler must never break the library operation that emitted the event.
 */
export function emitProgress(onProgress: ProgressCallback | undefined, event: ProgressEvent): void {
  if (!onProgress) return;
  try {
    onProgress(event);
  } catch {
    /* intentionally ignored — a progress sink must not abort the operation */
  }
}
