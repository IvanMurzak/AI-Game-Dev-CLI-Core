import * as fs from "node:fs";
import { inspect } from "node:util";

import { isErrno } from "./atomic-file.js";
import type { EditorSessionErrorReason } from "./editor-session.js";
import { errorMessage } from "./network-error.js";

/**
 * The command-line contract shared by `unity-mcp-cli`, `unreal-mcp-cli` and `godot-cli`, so a
 * script or an agent reads every engine CLI the same way:
 *
 *  - one exit-code table ({@link ExitCode}, {@link EXIT_CODES});
 *  - `--format text|json|ndjson` ({@link parseFormat});
 *  - one result envelope `{success, command, data, errors[{code,message,httpStatus?}], warnings}`, written
 *    synchronously to stdout at most once per process, with an exit safety net that still writes one
 *    when a machine-format command exits without it ({@link CommandOutput});
 *  - commander parse errors as usage errors, exit 2 ({@link classifyCliError});
 *  - one mapping of a failed tool call (no answer, or the MCP server's HTTP status) to an exit code
 *    and an envelope error code ({@link classifyToolFailure}, {@link TOOL_FAILURE_CODES});
 *  - the `commands --format json` manifest ({@link buildCommandManifest}).
 *
 * Library-safe: importing this module has no side effects, and nothing here exits the process
 * except {@link exitAfterFlush}, which a caller invokes explicitly. The commander types are
 * structural, so the package keeps zero runtime dependencies.
 */

// ── exit codes ──────────────────────────────────────────────────────────────────────────────────

/** The process exit codes; what each one means is in {@link EXIT_CODES}. */
export const ExitCode = {
  Success: 0,
  Error: 1,
  Usage: 2,
  CommandFailed: 6,
  Unreachable: 7,
  TestsFailed: 8,
  Timeout: 14,
  Busy: 17,
  AwaitingInput: 18,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCodeValue = (typeof ExitCode)[ExitCodeName];

export interface ExitCodeInfo {
  code: ExitCodeValue;
  /** The {@link ExitCode} key, e.g. `CommandFailed`. */
  name: ExitCodeName;
  description: string;
}

/** One line per exit code, in code order: the `exitCodes` of the `commands` manifest. */
export const EXIT_CODES: readonly ExitCodeInfo[] = [
  { code: ExitCode.Success, name: "Success", description: "The command succeeded." },
  { code: ExitCode.Error, name: "Error", description: "Unclassified error (ERROR)." },
  {
    code: ExitCode.Usage,
    name: "Usage",
    description:
      "Usage error: an unknown command, a bad flag or argument, tool arguments the server rejected (USAGE, HTTP 400 and other 4xx), an unknown tool or no project at the path (NOT_FOUND, HTTP 404); nothing ran. Fix the command line, do not retry it unchanged.",
  },
  {
    code: ExitCode.CommandFailed,
    name: "CommandFailed",
    description:
      "The command ran and failed: the tool reported an error (TOOL_FAILED, HTTP 409/422/500), compilation or script errors (COMPILATION_FAILED), a test run without a verdict; or the server refused the credentials (NOT_AUTHENTICATED, HTTP 401/403).",
  },
  {
    code: ExitCode.Unreachable,
    name: "Unreachable",
    description:
      "The editor or MCP server could not be started or reached, or no engine plugin is connected to the server (UNREACHABLE, HTTP 502). Retry once the environment is fixed.",
  },
  { code: ExitCode.TestsFailed, name: "TestsFailed", description: "The tests ran and at least one failed." },
  { code: ExitCode.Timeout, name: "Timeout", description: "The command timed out before a result (TIMEOUT, HTTP 408/504)." },
  {
    code: ExitCode.Busy,
    name: "Busy",
    description: "The editor or server is busy and did not run the call (BUSY, HTTP 503/429; or another CLI call holds the editor); retry later.",
  },
  { code: ExitCode.AwaitingInput, name: "AwaitingInput", description: "A modal dialog blocks the editor; a human must answer it (AWAITING_INPUT)." },
];

/** The envelope error token of an exit code (`CommandFailed` → `COMMAND_FAILED`); `ERROR` for an unknown code. */
export function exitCodeToken(code: number): string {
  const name = EXIT_CODES.find((e) => e.code === code)?.name ?? "Error";
  return name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
}

/** A bad flag or argument: the CLI exits with {@link ExitCode.Usage}. */
export class UsageError extends Error {
  readonly exitCode = ExitCode.Usage;

  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

// ── output formats ──────────────────────────────────────────────────────────────────────────────

export const OUTPUT_FORMATS = ["text", "json", "ndjson"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
/** The formats that reserve stdout for the envelope. */
export type MachineFormat = Exclude<OutputFormat, "text">;

/** Help text of the `--format` option. */
export const FORMAT_OPTION_DESCRIPTION =
  "Output format: text, json (one result envelope on stdout) or ndjson (progress lines on stderr, the envelope as one line on stdout)";

export function isMachineFormat(format: string | undefined): format is MachineFormat {
  return format === "json" || format === "ndjson";
}

/**
 * The value of a `--format` flag (trimmed, lower-cased; absent = `text`). `extra` lists
 * command-specific formats (e.g. `github`). Throws a {@link UsageError} for anything else.
 */
export function parseFormat<F extends string = never>(raw: string | undefined, extra: readonly F[] = []): OutputFormat | F {
  const value = (raw ?? "text").trim().toLowerCase();
  const allowed: readonly string[] = [...OUTPUT_FORMATS, ...extra];
  if (!allowed.includes(value)) {
    throw new UsageError(`--format must be one of: ${allowed.join(", ")} (got: "${raw}")`);
  }
  return value as OutputFormat | F;
}

/**
 * The `--format` named on a raw argv (`--format json` / `--format=json`, trimmed and lower-cased),
 * up to a `--`; the last one wins, as in commander. Lets the entry point answer a failure no
 * command handled with an envelope.
 */
export function formatFromArgv(argv: readonly string[]): string | undefined {
  let format: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    const value = arg === "--format" ? argv[i + 1] : arg.startsWith("--format=") ? arg.slice("--format=".length) : undefined;
    if (value !== undefined) format = value.trim().toLowerCase();
  }
  return format;
}

/** The first argument before a `--` that names one of `commandNames`. */
export function commandNameFromArgv(argv: readonly string[], commandNames: readonly string[]): string | undefined {
  for (const arg of argv) {
    if (arg === "--") break;
    if (commandNames.includes(arg)) return arg;
  }
  return undefined;
}

// ── the envelope ────────────────────────────────────────────────────────────────────────────────

export interface EnvelopeError<C extends string = string> {
  /** A stable UPPER_SNAKE token a script can match (never a translated message). */
  code: C;
  message: string;
  /** The HTTP status the MCP server answered with, when the failure is an HTTP answer. */
  httpStatus?: number;
}

export interface Envelope<T = unknown, C extends string = string> {
  success: boolean;
  command: string;
  data: T;
  errors: EnvelopeError<C>[];
  warnings: string[];
}

/** The envelope as `format` prints it: json pretty-printed, ndjson one line; with the trailing newline. */
export function renderEnvelope(envelope: Envelope, format: MachineFormat): string {
  return (format === "json" ? JSON.stringify(envelope, null, 2) : JSON.stringify(envelope)) + "\n";
}

let stdoutEnvelopeWritten = false;

/**
 * Write the envelope to stdout synchronously, at most once per process (a later call is a no-op and
 * returns false). Synchronous because `process.stdout.write` to a pipe is asynchronous on macOS: a
 * `process.exit` right after it could cut the JSON short. A Windows console gets it through
 * `process.stdout.write`, which converts UTF-8 for the console (raw bytes would print non-ASCII
 * text in the console's code page); that write is synchronous.
 */
export function writeEnvelope(envelope: Envelope, format: MachineFormat): boolean {
  if (stdoutEnvelopeWritten) return false;
  stdoutEnvelopeWritten = true;
  const text = renderEnvelope(envelope, format);
  if (process.platform === "win32" && process.stdout.isTTY) process.stdout.write(text);
  else writeAllSync(1, text);
  return true;
}

function writeAllSync(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf-8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(fd, buffer, offset);
    } catch (err) {
      if (!isErrno(err, "EAGAIN")) throw err;
      Atomics.wait(pauseCell, 0, 0, 1); // a non-blocking pipe is full: let the reader drain it
    }
  }
}

const pauseCell = new Int32Array(new SharedArrayBuffer(4));

/** @internal Reset the once-per-process envelope state — for this package's own tests only. */
export function resetEnvelopeStateForTests(): void {
  stdoutEnvelopeWritten = false;
  active = undefined;
}

// ── one command run ─────────────────────────────────────────────────────────────────────────────

export interface CommandOutputOptions {
  /**
   * Where the envelope goes. Default: stdout, synchronously, once per process
   * ({@link writeEnvelope}), with the exit safety net. A custom writer (tests) gets neither.
   */
  stdout?: (text: string) => void;
  /** Where progress lines and text-mode warnings go. Default: stderr. */
  stderr?: (text: string) => void;
}

/** The output of the command being run (the last one constructed), for the exit safety net. */
let active: CommandOutput<string> | undefined;
let safetyNetArmed = false;

/** The output of the command being run in this process, if one was constructed. */
export function activeCommandOutput(): CommandOutput<string> | undefined {
  return active;
}

function onProcessExit(code: number): void {
  const output = active;
  if (!output?.machine || !output.writesProcessStdout || stdoutEnvelopeWritten) return;
  // A path that exited without an envelope (a shared validator, an unexpected error): stdout still gets one.
  if (output.errors.length === 0 && code !== ExitCode.Success) {
    output.record(exitCodeToken(code), "The command failed before it produced a result; see stderr for details.");
  }
  output.emit(code);
}

/**
 * Collects one command run's errors and warnings and prints its envelope in json / ndjson; in text
 * the command prints its own result. In a machine format with the default writer, `console.log` and
 * `console.info` go to stderr for the rest of the process (constructing one is the CLI's choice of
 * format), so stdout carries the envelope and nothing else.
 *
 * It never exits the process: {@link finish} sets `process.exitCode`; a CLI that wants to stop at
 * once calls `process.exit` or {@link exitAfterFlush} itself. Engine CLIs subclass it to add their
 * text-mode printing.
 */
export class CommandOutput<C extends string = string> {
  readonly warnings: string[] = [];
  readonly errors: EnvelopeError<C>[] = [];
  private readonly _stdout: ((text: string) => void) | undefined;
  private readonly _stderr: (text: string) => void;

  constructor(
    readonly command: string,
    readonly format: string = "text",
    options: CommandOutputOptions = {},
  ) {
    this._stdout = options.stdout;
    this._stderr = options.stderr ?? ((text) => void process.stderr.write(text));
    active = this as CommandOutput<string>;
    if (this.machine && this.writesProcessStdout) {
      if (!safetyNetArmed) {
        safetyNetArmed = true;
        process.on("exit", onProcessExit);
      }
      console.log = console.error;
      console.info = console.error;
      console.debug = console.error;
      console.dir = (item: unknown, options?: object) => console.error(inspect(item, options));
    }
  }

  /** json / ndjson: stdout is reserved for the envelope. */
  get machine(): boolean {
    return isMachineFormat(this.format);
  }

  /** True when the envelope goes to the process stdout (no custom writer). */
  get writesProcessStdout(): boolean {
    return this._stdout === undefined;
  }

  /** A progress line: a `{"type":"progress"}` event on stderr in ndjson; nothing in json or text. */
  progress(message: string): void {
    if (this.format === "ndjson") this.writeStderr(JSON.stringify({ type: "progress", command: this.command, message }) + "\n");
  }

  /** A warning: in the envelope (machine formats), printed by {@link printWarning} in text. */
  warn(message: string): void {
    this.warnings.push(message);
    if (!this.machine) this.printWarning(message);
  }

  /** Record an error for the envelope without printing it; `httpStatus`: the server's answer, when there was one. */
  record(code: C, message: string, httpStatus?: number): void {
    this.errors.push(httpStatus === undefined ? { code, message } : { code, message, httpStatus });
  }

  /**
   * Print the envelope (machine formats only; `success` = `exitCode` 0) with the recorded errors and
   * warnings. Returns whether it was written (the default writer writes once per process).
   */
  emit(exitCode: number, data: unknown = null): boolean {
    if (!isMachineFormat(this.format)) return false;
    const envelope: Envelope<unknown, C> = {
      success: exitCode === ExitCode.Success,
      command: this.command,
      data,
      errors: this.errors,
      warnings: this.warnings,
    };
    if (this._stdout === undefined) return writeEnvelope(envelope, this.format);
    this._stdout(renderEnvelope(envelope, this.format));
    return true;
  }

  /** Set `process.exitCode` and {@link emit} the envelope. Never exits the process. */
  finish(exitCode: number, data: unknown = null): void {
    process.exitCode = exitCode;
    this.emit(exitCode, data);
  }

  /** How a text-mode warning is shown (default: `WARN: <message>` on stderr — stdout may be the result). */
  protected printWarning(message: string): void {
    this.writeStderr(`WARN: ${message}\n`);
  }

  protected writeStderr(text: string): void {
    this._stderr(text);
  }
}

/** Thrown by {@link exitAfterFlush} to unwind the caller; the entry point ignores it (the exit is scheduled). */
export class CommandExit extends Error {
  constructor(readonly exitCode: number) {
    super(`exit ${exitCode}`);
    this.name = "CommandExit";
  }
}

/**
 * Exit with `exitCode` once stdout and stderr have flushed (a write to a TTY or a macOS pipe is
 * asynchronous: an immediate `process.exit` can cut a large result short). Throws
 * {@link CommandExit} to unwind the caller in the meantime.
 */
export function exitAfterFlush(exitCode: number): never {
  process.exitCode = exitCode;
  let pending = 2;
  const done = (): void => {
    if (--pending === 0) process.exit(exitCode);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
  throw new CommandExit(exitCode);
}

// ── a tool call that did not succeed ────────────────────────────────────────────────────────────

/** The envelope error codes of a tool call that did not succeed (`run-tool`, `run-system-tool`, `exec`, `rql`, `tools`). */
export type ToolFailureCode =
  | "USAGE"
  | "NOT_FOUND"
  | "NOT_AUTHENTICATED"
  | "TOOL_FAILED"
  | "COMPILATION_FAILED"
  | "UNREACHABLE"
  | "TIMEOUT"
  | "BUSY"
  | "ERROR";

/** The exit code and envelope error code of a failure, with the HTTP status that decided it (when there was one). */
export interface ToolFailureClass {
  exitCode: ExitCodeValue;
  code: ToolFailureCode;
  /** The server's HTTP status: the envelope error's `httpStatus`. */
  httpStatus?: number;
}

/**
 * What {@link classifyToolFailure} reads of an engine CLI's failed tool call (its `RunToolFailure`): why no answer
 * came (`reason`), or the server's HTTP error answer (`reason: "http-error"` with `httpStatus` and `data`).
 */
export interface ToolFailureLike {
  /**
   * `invalid-input` (the CLI rejected the arguments before sending), `not-authenticated` (no usable credentials),
   * `connection-refused` / `connection-reset` / `network-error` (`networkFailureReason` of the thrown error),
   * `timeout` (the CLI's own `--timeout`), `http-error`
   * (the server answered with an error status); anything else (`aborted`, `unknown`) is unclassified.
   */
  reason: string;
  httpStatus?: number;
  /** The response body: the server's `{ "error": "<text>" }`, or its raw text. */
  data?: unknown;
  /** The failure's summary: read for the server's error text when the body has none. */
  message?: string;
}

/** The exit code of each error code: one per code, whatever led to it. */
const EXIT_OF: Readonly<Record<ToolFailureCode, ExitCodeValue>> = {
  USAGE: ExitCode.Usage,
  NOT_FOUND: ExitCode.Usage,
  NOT_AUTHENTICATED: ExitCode.CommandFailed,
  TOOL_FAILED: ExitCode.CommandFailed,
  COMPILATION_FAILED: ExitCode.CommandFailed,
  UNREACHABLE: ExitCode.Unreachable,
  TIMEOUT: ExitCode.Timeout,
  BUSY: ExitCode.Busy,
  ERROR: ExitCode.Error,
};

const toolClass = (code: ToolFailureCode): ToolFailureClass => ({ exitCode: EXIT_OF[code], code });

/**
 * The two cases the HTTP status alone does not tell apart. The server's error kind is not in its answer (only the
 * status and `{ "error": "<text>" }`), so these match the text the servers send; a structured code in the error body
 * would replace them.
 *
 * The MCP server is up but no engine plugin is connected to it (McpPlugin.Server's "No engine plugin is connected",
 * its account mode's "The engine for this project is not connected", the cloud hub's "No game engine is connected for
 * your account", older servers' "No connected clients"): the editor is unreachable, whatever the status (503, 404,
 * 500). Matched at the start of the server's own text only, and never on a 422: a tool's error ("Tool execution failed
 * for ...") may say the same words about something else.
 */
const NO_PLUGIN_CONNECTED = /^\s*(no (engine plugin|game engine) is connected|the engine for this project is not connected|no connected clients)/i;

/** Arguments the server rejected before the tool ran: McpPlugin answers them as 422 with this prefix. */
const INVALID_PARAMS = /^\s*\[invalid_params\]/;

/** The server's own error text of a failed call (`{ "error": "..." }`, or a text body), when it sent one. */
export function serverErrorText(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim() || undefined;
  const error = (data as { error?: unknown } | null | undefined)?.error;
  return typeof error === "string" && error.trim() !== "" ? error : undefined;
}

/**
 * The exit code and error code of an HTTP error answer of the MCP server's direct tool API (`/api/tools`,
 * `/api/system-tools`), by HTTP semantics ({@link TOOL_FAILURE_CODES}). `errorText`: the server's error text.
 */
export function classifyHttpFailure(httpStatus: number, errorText = ""): ToolFailureClass {
  return { ...toolClass(httpFailureCode(httpStatus, errorText)), httpStatus };
}

function httpFailureCode(status: number, errorText: string): ToolFailureCode {
  if (status === 502 || (status !== 422 && NO_PLUGIN_CONNECTED.test(errorText))) return "UNREACHABLE";
  switch (status) {
    case 401:
    case 403:
      return "NOT_AUTHENTICATED";
    case 404:
      return "NOT_FOUND";
    case 408:
    case 504:
      return "TIMEOUT";
    case 429:
    case 503:
      return "BUSY";
    case 409:
      return "TOOL_FAILED";
    case 422:
      return INVALID_PARAMS.test(errorText) ? "USAGE" : "TOOL_FAILED";
  }
  return status >= 400 && status < 500 ? "USAGE" : "TOOL_FAILED";
}

/**
 * The exit code and envelope error code of a failed tool call, the same in every engine CLI: by the HTTP status when
 * the server answered, else by why no answer came. The whole table is {@link TOOL_FAILURE_CODES}.
 */
export function classifyToolFailure(failed: ToolFailureLike): ToolFailureClass {
  switch (failed.reason) {
    case "http-error":
      return failed.httpStatus === undefined
        ? toolClass("TOOL_FAILED")
        : classifyHttpFailure(failed.httpStatus, serverErrorText(failed.data) ?? failed.message);
    case "invalid-input":
      return toolClass("USAGE");
    case "not-authenticated":
      return toolClass("NOT_AUTHENTICATED");
    case "timeout":
      return toolClass("TIMEOUT");
    case "connection-refused":
    case "connection-reset":
    case "network-error":
      return toolClass("UNREACHABLE");
    default:
      return toolClass("ERROR");
  }
}

/** Why a command got no ready editor for its call (nothing was called). */
export interface EditorStartFailureLike {
  /** No project at the path: nothing to start. */
  projectNotFound?: boolean;
  /** A bad option (e.g. a bad `--url`): nothing to start. */
  invalidInput?: boolean;
  /** The project's code did not build, so no editor was started. */
  buildFailed?: boolean;
  /** The editor session's error reason; `lock-busy`: another CLI call held the project's start lock all along. */
  sessionReason?: EditorSessionErrorReason;
}

/** The exit code and error code of a command that got no ready editor ({@link TOOL_FAILURE_CODES}). */
export function classifyEditorStartFailure(failed: EditorStartFailureLike): ToolFailureClass {
  if (failed.projectNotFound) return toolClass("NOT_FOUND");
  if (failed.invalidInput) return toolClass("USAGE");
  if (failed.buildFailed) return toolClass("COMPILATION_FAILED");
  if (failed.sessionReason === "lock-busy") return toolClass("BUSY");
  return toolClass("UNREACHABLE");
}

/** One row of {@link TOOL_FAILURE_CODES}. */
export interface ToolFailureCodeInfo {
  code: ToolFailureCode;
  exitCode: ExitCodeValue;
  /** The HTTP statuses of the server's answer that map here (empty: a failure without an HTTP answer). */
  httpStatus: readonly number[];
  /** The condition, in words. */
  condition: string;
}

/**
 * How a tool call that did not succeed maps to an exit code and an envelope error code (`run-tool`,
 * `run-system-tool`, `exec`, `rql`, `tools`): the `errorCodes` of the `commands` manifest. Keyed on the MCP server's
 * HTTP status when it answered; an engine CLI may add its own codes (e.g. AWAITING_INPUT for a modal dialog).
 */
export const TOOL_FAILURE_CODES: readonly ToolFailureCodeInfo[] = [
  {
    code: "USAGE",
    exitCode: EXIT_OF.USAGE,
    httpStatus: [400],
    condition: "Bad arguments: a bad flag, tool arguments rejected by the CLI before sending or by the server (400, any 4xx not listed here, a 422 whose error starts with [invalid_params]).",
  },
  { code: "NOT_FOUND", exitCode: EXIT_OF.NOT_FOUND, httpStatus: [404], condition: "No tool by that name, or no project at the path." },
  { code: "NOT_AUTHENTICATED", exitCode: EXIT_OF.NOT_AUTHENTICATED, httpStatus: [401, 403], condition: "No usable credentials, or the server refused them." },
  { code: "TOOL_FAILED", exitCode: EXIT_OF.TOOL_FAILED, httpStatus: [409, 422, 500], condition: "The tool ran and reported an error (status \"error\" in its answer; the server's 409, 422, 500 or any other 5xx not listed here)." },
  { code: "COMPILATION_FAILED", exitCode: EXIT_OF.COMPILATION_FAILED, httpStatus: [], condition: "The project's code did not build, so no editor was started." },
  {
    code: "UNREACHABLE",
    exitCode: EXIT_OF.UNREACHABLE,
    httpStatus: [502],
    condition: "The server or editor could not be reached: connection refused or reset, no engine plugin connected to the server (any status), the plugin lost after the call was sent (502).",
  },
  { code: "TIMEOUT", exitCode: EXIT_OF.TIMEOUT, httpStatus: [408, 504], condition: "No answer in time: the CLI's --timeout, or the server's own tool timeout." },
  {
    code: "BUSY",
    exitCode: EXIT_OF.BUSY,
    httpStatus: [429, 503],
    condition: "The editor or server is busy and did not run the call (reloading, compiling, rate-limited, another CLI call holds the editor); retry later.",
  },
  { code: "ERROR", exitCode: EXIT_OF.ERROR, httpStatus: [], condition: "Anything else: the call was aborted, an unexpected error." },
];

/** One row of {@link TOOL_FAILURE_CODES} as a text line (`commands` in text mode): `NOT_FOUND  exit 2, HTTP 404: ...`. */
export function toolFailureCodeLine(row: ToolFailureCodeInfo): string {
  const http = row.httpStatus.length > 0 ? `, HTTP ${row.httpStatus.join("/")}` : "";
  return `${row.code.padEnd(18)} exit ${row.exitCode}${http}: ${row.condition}`;
}

// ── the entry point: errors no command handled ─────────────────────────────────────────────────

/** The parts of a commander `Command` the entry-point helpers read. */
export interface CliProgramLike {
  name(): string;
  readonly commands: readonly { name(): string }[];
}

export interface CliFailure {
  exitCode: ExitCodeValue;
  /** The envelope error token. */
  code: "USAGE" | "ERROR";
  /** The message, without commander's `error: ` prefix. */
  message: string;
  /** `--help` / `--version` (commander exit 0): not a failure; exit 0, print nothing more. */
  informational: boolean;
  /** Commander already printed the message to stderr. */
  printed: boolean;
}

function isCommanderError(err: unknown): err is { code: string; exitCode: number; message: string } {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; exitCode?: unknown };
  return typeof e.code === "string" && e.code.startsWith("commander.") && typeof e.exitCode === "number";
}

/**
 * Classify an error that reached the entry point: a commander parse error (with `exitOverride()`)
 * or a {@link UsageError} is a usage error (exit 2); commander's `--help` / `--version` are
 * informational (exit 0); anything else is an unclassified error (exit 1).
 */
export function classifyCliError(err: unknown): CliFailure {
  if (isCommanderError(err)) {
    const informational = err.exitCode === 0;
    return {
      exitCode: informational ? ExitCode.Success : ExitCode.Usage,
      code: "USAGE",
      message: err.message.replace(/^error:\s*/, ""),
      informational,
      printed: true,
    };
  }
  if (err instanceof UsageError) {
    return { exitCode: ExitCode.Usage, code: "USAGE", message: err.message, informational: false, printed: false };
  }
  const message = describeThrown(err);
  return { exitCode: ExitCode.Error, code: "ERROR", message, informational: false, printed: false };
}

/** The message of anything thrown; never throws itself (e.g. for a null-prototype object). */
function describeThrown(err: unknown): string {
  try {
    return errorMessage(err) || String(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

/**
 * When no envelope went out yet, write a failure envelope: through the running command's output
 * when one runs in json / ndjson (keeping its name and warnings), else when `argv` asks for json /
 * ndjson, naming the command found on `argv` (else the program). Returns whether one was written.
 */
export function writeFailureEnvelope(
  program: CliProgramLike,
  failure: { code: string; message: string; exitCode?: number },
  argv: readonly string[] = process.argv.slice(2),
): boolean {
  if (stdoutEnvelopeWritten) return false;
  if (active?.machine && active.writesProcessStdout) {
    active.record(failure.code, failure.message);
    return active.emit(failure.exitCode ?? ExitCode.Error);
  }
  const format = formatFromArgv(argv);
  if (!isMachineFormat(format)) return false;
  const command = commandNameFromArgv(argv, program.commands.map((c) => c.name())) ?? program.name();
  return writeEnvelope({ success: false, command, data: null, errors: [{ code: failure.code, message: failure.message }], warnings: [] }, format);
}

// ── the `commands` manifest ─────────────────────────────────────────────────────────────────────

/** The parts of a commander `Option` the manifest reads. */
export interface ManifestOptionSource {
  flags: string;
  description: string;
  defaultValue?: unknown;
  argChoices?: string[];
  hidden?: boolean;
}

/** The parts of a commander `Argument` the manifest reads. */
export interface ManifestArgumentSource {
  name(): string;
  required: boolean;
  variadic: boolean;
  description: string;
}

/** The parts of a commander `Command` the manifest reads. */
export interface ManifestCommandSource {
  name(): string;
  description(): string;
  readonly options: readonly ManifestOptionSource[];
  readonly registeredArguments: readonly ManifestArgumentSource[];
  readonly commands: readonly ManifestCommandSource[];
}

export interface ManifestArgument {
  name: string;
  required: boolean;
  variadic: boolean;
  description: string;
}

export interface ManifestOption {
  flags: string;
  description: string;
  default?: unknown;
  choices?: string[];
}

export interface ManifestCommand {
  name: string;
  description: string;
  arguments: ManifestArgument[];
  options: ManifestOption[];
}

export interface CommandManifest {
  name: string;
  version: string;
  /** The root's own options (`--version`, `--verbose`) and `--help`, which every command accepts. */
  globalOptions: ManifestOption[];
  /** The subcommands in registration order (hidden ones left out). */
  commands: ManifestCommand[];
  exitCodes: readonly ExitCodeInfo[];
  /** How a tool call that did not succeed maps to an exit code and an error code ({@link TOOL_FAILURE_CODES}). */
  errorCodes: readonly ToolFailureCodeInfo[];
}

function describeOption(option: ManifestOptionSource): ManifestOption {
  return {
    flags: option.flags,
    description: option.description,
    ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
    ...(option.argChoices ? { choices: [...option.argChoices] } : {}),
  };
}

function visibleOptions(command: ManifestCommandSource): ManifestOption[] {
  return command.options.filter((o) => !o.hidden).map(describeOption);
}

/** The manifest of `root`'s commands, read from the commander tree (so it never drifts from the CLI). */
export function buildCommandManifest(root: ManifestCommandSource, version: string): CommandManifest {
  return {
    name: root.name(),
    version,
    globalOptions: [...visibleOptions(root), { flags: "-h, --help", description: "Display help for the command" }],
    commands: root.commands
      .filter((cmd) => (cmd as { _hidden?: boolean })._hidden !== true)
      .map((cmd) => ({
        name: cmd.name(),
        description: cmd.description(),
        arguments: cmd.registeredArguments.map((a) => ({
          name: a.name(),
          required: a.required,
          variadic: a.variadic,
          description: a.description,
        })),
        options: visibleOptions(cmd),
      })),
    exitCodes: EXIT_CODES,
    errorCodes: TOOL_FAILURE_CODES,
  };
}
