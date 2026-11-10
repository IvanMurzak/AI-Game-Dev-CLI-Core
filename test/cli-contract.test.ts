import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CommandOutput,
  EXIT_CODES,
  ExitCode,
  UsageError,
  activeCommandOutput,
  buildCommandManifest,
  classifyCliError,
  commandNameFromArgv,
  exitCodeToken,
  formatFromArgv,
  isMachineFormat,
  parseFormat,
  renderEnvelope,
  resetEnvelopeStateForTests,
  type ManifestCommandSource,
} from "../src/cli-contract.js";

const originalExitCode = process.exitCode;
beforeEach(() => resetEnvelopeStateForTests());
afterEach(() => {
  process.exitCode = originalExitCode;
});

function capture(format: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const out = new CommandOutput("run-tool", format, { stdout: (t) => stdout.push(t), stderr: (t) => stderr.push(t) });
  return { out, stdout, stderr };
}

describe("exit codes", () => {
  it("are the table every engine CLI shares", () => {
    expect(ExitCode).toEqual({ Success: 0, Error: 1, Usage: 2, CommandFailed: 6, Unreachable: 7, TestsFailed: 8, Timeout: 14, Busy: 17, AwaitingInput: 18 });
    expect(EXIT_CODES.map((e) => e.code)).toEqual([0, 1, 2, 6, 7, 8, 14, 17, 18]);
    for (const e of EXIT_CODES) {
      expect(ExitCode[e.name]).toBe(e.code);
      expect(e.description.length).toBeGreaterThan(5);
    }
  });

  it("map to UPPER_SNAKE envelope tokens", () => {
    expect(exitCodeToken(ExitCode.CommandFailed)).toBe("COMMAND_FAILED");
    expect(exitCodeToken(ExitCode.AwaitingInput)).toBe("AWAITING_INPUT");
    expect(exitCodeToken(ExitCode.Busy)).toBe("BUSY");
    expect(exitCodeToken(99)).toBe("ERROR");
  });
});

describe("formats", () => {
  it("parseFormat trims, lower-cases, defaults to text, and accepts extra formats", () => {
    expect(parseFormat(undefined)).toBe("text");
    expect(parseFormat(" JSON ")).toBe("json");
    expect(parseFormat("github", ["github"])).toBe("github");
  });

  it("parseFormat throws a UsageError (exit 2) for anything else", () => {
    expect(() => parseFormat("yaml")).toThrow(UsageError);
    expect(() => parseFormat("yaml")).toThrow('--format must be one of: text, json, ndjson (got: "yaml")');
    try {
      parseFormat("xml");
    } catch (err) {
      expect((err as UsageError).exitCode).toBe(2);
    }
  });

  it("formatFromArgv reads both spellings, normalizes, and stops at --", () => {
    expect(formatFromArgv(["status", "--format", "json"])).toBe("json");
    expect(formatFromArgv(["status", "--format=NDJSON"])).toBe("ndjson");
    expect(formatFromArgv(["status"])).toBeUndefined();
    expect(formatFromArgv(["exec", "--", "--format", "json"])).toBeUndefined();
    expect(isMachineFormat("json")).toBe(true);
    expect(isMachineFormat("github")).toBe(false);
    expect(isMachineFormat(undefined)).toBe(false);
  });

  it("commandNameFromArgv finds the first known command before --", () => {
    const names = ["status", "open"];
    expect(commandNameFromArgv(["--format", "json", "status", "--bogus"], names)).toBe("status");
    expect(commandNameFromArgv(["-v", "open", "status"], names)).toBe("open");
    expect(commandNameFromArgv(["nope", "--", "status"], names)).toBeUndefined();
  });
});

describe("CommandOutput", () => {
  it("json: one pretty envelope, success follows the exit code, warnings collected", () => {
    const { out, stdout, stderr } = capture("json");
    out.progress("Starting...");
    out.warn("careful");
    out.finish(ExitCode.Success, { value: 1 });
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('\n  "success": true');
    expect(JSON.parse(stdout[0]!)).toEqual({ success: true, command: "run-tool", data: { value: 1 }, errors: [], warnings: ["careful"] });
    expect(process.exitCode).toBe(0);
  });

  it("ndjson: progress events on stderr, the envelope as one line with the recorded errors", () => {
    const { out, stdout, stderr } = capture("ndjson");
    out.progress("Starting...");
    out.record("BUSY", "Server busy");
    out.finish(ExitCode.Busy);
    expect(stderr.map((l) => JSON.parse(l))).toEqual([{ type: "progress", command: "run-tool", message: "Starting..." }]);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]!.trimEnd()).not.toContain("\n");
    expect(JSON.parse(stdout[0]!)).toEqual({ success: false, command: "run-tool", data: null, errors: [{ code: "BUSY", message: "Server busy" }], warnings: [] });
    expect(process.exitCode).toBe(17);
  });

  it("text: no envelope, warnings on stderr", () => {
    const { out, stdout, stderr } = capture("text");
    out.warn("careful");
    out.progress("not shown");
    expect(out.emit(ExitCode.CommandFailed, { x: 1 })).toBe(false);
    out.finish(ExitCode.CommandFailed, { x: 1 });
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["WARN: careful\n"]);
    expect(out.machine).toBe(false);
    expect(process.exitCode).toBe(6);
  });

  it("a subclass replaces the text-mode warning", () => {
    const shown: string[] = [];
    class Styled extends CommandOutput {
      protected override printWarning(message: string): void {
        shown.push(`styled ${message}`);
      }
    }
    new Styled("x", "text", { stderr: () => undefined }).warn("w");
    expect(shown).toEqual(["styled w"]);
  });

  it("is the active output of the process once constructed", () => {
    const { out } = capture("text");
    expect(activeCommandOutput()).toBe(out);
  });

  it("renderEnvelope: json is pretty, ndjson one line", () => {
    const env = { success: true, command: "x", data: { a: 1 }, errors: [], warnings: [] };
    expect(renderEnvelope(env, "json")).toBe(JSON.stringify(env, null, 2) + "\n");
    expect(renderEnvelope(env, "ndjson")).toBe(JSON.stringify(env) + "\n");
  });
});

describe("classifyCliError", () => {
  const commanderError = (code: string, exitCode: number, message: string) => Object.assign(new Error(message), { code, exitCode });

  it("commander parse errors are usage errors without the error: prefix", () => {
    expect(classifyCliError(commanderError("commander.unknownOption", 1, "error: unknown option '--bogus'"))).toEqual({
      exitCode: 2,
      code: "USAGE",
      message: "unknown option '--bogus'",
      informational: false,
      printed: true,
    });
  });

  it("--help and --version are informational (exit 0)", () => {
    expect(classifyCliError(commanderError("commander.helpDisplayed", 0, "(outputHelp)"))).toMatchObject({ exitCode: 0, informational: true });
    expect(classifyCliError(commanderError("commander.version", 0, "1.0.0"))).toMatchObject({ exitCode: 0, informational: true });
  });

  it("a UsageError is exit 2, anything else exit 1", () => {
    expect(classifyCliError(new UsageError("--timeout must be a whole number"))).toEqual({
      exitCode: 2,
      code: "USAGE",
      message: "--timeout must be a whole number",
      informational: false,
      printed: false,
    });
    expect(classifyCliError(new Error("boom"))).toMatchObject({ exitCode: 1, code: "ERROR", message: "boom" });
    expect(classifyCliError("plain")).toMatchObject({ exitCode: 1, code: "ERROR", message: "plain" });
  });
});

describe("buildCommandManifest", () => {
  const option = (flags: string, description: string, extra: Partial<{ defaultValue: unknown; argChoices: string[]; hidden: boolean }> = {}) => ({
    flags,
    description,
    ...extra,
  });
  const command = (name: string, extra: Partial<ManifestCommandSource> & { _hidden?: boolean } = {}): ManifestCommandSource => ({
    name: () => name,
    description: () => `${name} description`,
    options: [],
    registeredArguments: [],
    commands: [],
    ...extra,
  });

  it("reads the tree: arguments, defaults, choices; hidden commands and options left out", () => {
    const root = command("demo-cli", {
      options: [option("-V, --version", "output the version number"), option("-v, --verbose", "Verbose"), option("--secret", "s", { hidden: true })],
      commands: [
        command("status", {
          registeredArguments: [{ name: () => "path", required: false, variadic: false, description: "Project path" }],
          options: [option("--format <format>", "Output format", { defaultValue: "text", argChoices: ["text", "json", "ndjson"] }), option("--internal", "i", { hidden: true })],
        }),
        command("secret", { _hidden: true }),
        command("commands"),
      ],
    });
    const manifest = buildCommandManifest(root, "1.2.3");
    expect(manifest.name).toBe("demo-cli");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.globalOptions.map((o) => o.flags)).toEqual(["-V, --version", "-v, --verbose", "-h, --help"]);
    expect(manifest.commands.map((c) => c.name)).toEqual(["status", "commands"]);
    expect(manifest.commands[0]).toEqual({
      name: "status",
      description: "status description",
      arguments: [{ name: "path", required: false, variadic: false, description: "Project path" }],
      options: [{ flags: "--format <format>", description: "Output format", default: "text", choices: ["text", "json", "ndjson"] }],
    });
    expect(manifest.exitCodes).toBe(EXIT_CODES);
  });
});
