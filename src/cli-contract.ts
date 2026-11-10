import * as fs from "node:fs";

import { isErrno } from "./atomic-file.js";
import { errorMessage } from "./network-error.js";

/**
 * The command-line contract shared by `unity-mcp-cli`, `unreal-mcp-cli` and `godot-cli`, so a
 * script or an agent reads every engine CLI the same way:
 *
 *  - one exit-code table ({@link ExitCode}, {@link EXIT_CODES});
 *  - `--format text|json|ndjson` ({@link parseFormat});
 *  - one result envelope `{success, command, data, errors[{code,message}], warnings}`, written
 *    synchronously to stdout at most once per process, with an exit safety net that still writes one
 *    when a machine-format command exits without it ({@link CommandOutput});
 *  - commander parse errors as usage errors, exit 2 ({@link classifyCliError});
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
  { code: ExitCode.Error, name: "Error", description: "Unclassified error." },
  {
    code: ExitCode.Usage,
    name: "Usage",
    description: "Usage error: an unknown command, a bad flag or argument; nothing ran. Fix the command line, do not retry it unchanged.",
  },
  {
    code: ExitCode.CommandFailed,
    name: "CommandFailed",
    description: "The command ran and failed (tool error, compilation or script errors, a test run without a verdict).",
  },
  {
    code: ExitCode.Unreachable,
    name: "Unreachable",
    description: "The editor or MCP server could not be started or reached. Retry once the environment is fixed.",
  },
  { code: ExitCode.TestsFailed, name: "TestsFailed", description: "The tests ran and at least one failed." },
  { code: ExitCode.Timeout, name: "Timeout", description: "The command timed out before a result." },
  { code: ExitCode.Busy, name: "Busy", description: "The editor or server is busy (HTTP 503) and did not run the call; retry later." },
  { code: ExitCode.AwaitingInput, name: "AwaitingInput", description: "A modal dialog blocks the editor; a human must answer it." },
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
 * up to a `--`; lets the entry point answer a failure no command handled with an envelope.
 */
export function formatFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") break;
    const value = arg === "--format" ? argv[i + 1] : arg.startsWith("--format=") ? arg.slice("--format=".length) : undefined;
    if (value !== undefined) return value.trim().toLowerCase();
  }
  return undefined;
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
 * `process.exit` right after it could cut the JSON short.
 */
export function writeEnvelope(envelope: Envelope, format: MachineFormat): boolean {
  if (stdoutEnvelopeWritten) return false;
  stdoutEnvelopeWritten = true;
  writeAllSync(1, renderEnvelope(envelope, format));
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

  /** Record an error for the envelope without printing it. */
  record(code: C, message: string): void {
    this.errors.push({ code, message });
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
  const message = errorMessage(err) || String(err);
  return { exitCode: ExitCode.Error, code: "ERROR", message, informational: false, printed: false };
}

/**
 * When `argv` asks for json / ndjson and no envelope went out yet, write a failure envelope naming
 * the command found on `argv` (else the program). Returns whether one was written.
 */
export function writeFailureEnvelope(
  program: CliProgramLike,
  failure: { code: string; message: string },
  argv: readonly string[] = process.argv.slice(2),
): boolean {
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
  };
}
