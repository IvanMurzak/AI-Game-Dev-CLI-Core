// A stand-in engine CLI for `test/cli-contract.subprocess.test.ts`: one scenario of the shared
// command-line contract per run, against the built package (dist/).
//
// Usage: node contract-runner.mjs <scenario> <format>

import { CommandOutput, ExitCode, exitAfterFlush, CommandExit } from "../../dist/index.js";

const [scenario, format] = process.argv.slice(2);
const out = new CommandOutput("demo", format);

switch (scenario) {
  // A shared validator exits on its own: the safety net still leaves one envelope on stdout.
  case "exit-without-envelope":
    console.log("a log line that must not reach stdout");
    process.exit(ExitCode.CommandFailed);
    break;
  // The command emits, then exits at once: exactly one envelope, never cut short.
  case "emit-then-exit": {
    out.warn("w");
    out.emit(ExitCode.Success, { big: "x".repeat(1_000_000) });
    out.emit(ExitCode.Success, { second: true });
    process.exit(ExitCode.Success);
    break;
  }
  // The recorded errors ride the safety-net envelope.
  case "recorded-then-exit":
    out.record("NOT_AUTHENTICATED", "sign in");
    process.exit(ExitCode.CommandFailed);
    break;
  case "exit-after-flush":
    try {
      out.record("TIMEOUT", "too slow");
      out.emit(ExitCode.Timeout);
      exitAfterFlush(ExitCode.Timeout);
    } catch (err) {
      if (!(err instanceof CommandExit)) throw err;
    }
    break;
  default:
    throw new Error(`unknown scenario ${scenario}`);
}
