<div align="center">

<img src="docs/assets/hero.svg" alt="AI Game Dev CLI Core — one TypeScript core behind every engine CLI" width="100%"/>

<br/>

[![npm](https://img.shields.io/npm/v/@baizor/gamedev-cli-core?style=flat-square&color=8b5cf6&label=npm)](https://www.npmjs.com/package/@baizor/gamedev-cli-core)
[![CI](https://img.shields.io/github/actions/workflow/status/IvanMurzak/AI-Game-Dev-CLI-Core/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/IvanMurzak/AI-Game-Dev-CLI-Core/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.14-22d3ee?style=flat-square)
![Dependencies](https://img.shields.io/badge/runtime%20deps-0-34d399?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-a5b4fc?style=flat-square)](LICENSE)

</div>

**`@baizor/gamedev-cli-core`** is the shared engine of the AI Game Dev command-line tools. It handles
sign-in, credentials, project identity, AI-agent setup, editor sessions and the CLI's output
contract. Each engine CLI is a thin adapter on top of it, so all of them behave the same way.

<p align="center">
  <img src="docs/assets/architecture.svg" alt="The engine CLIs and the App call cli-core; cli-core talks to ai-game.dev, the local MCP server, the engine editor and AI agent configs" width="100%"/>
</p>

## What it does

| | Module | What it gives every CLI |
|---|---|---|
| 🔑 | **Sign-in** | OAuth 2.1 device-code login for terminals and browser login (PKCE) for the desktop app |
| 🗝️ | **Credentials** | One store at `~/.ai-game-dev/`, encrypted on Windows (DPAPI) and `0600` on macOS/Linux. Tokens refresh safely when several processes run at once |
| 📌 | **Project identity** | A stable pin and port for each project, byte-for-byte the same as the C# plugin's |
| 🧩 | **AI agent setup** | `setup-mcp` writes ready MCP configs for Claude Code, Cursor, Codex, Copilot, Gemini and more |
| 🎮 | **Editor sessions** | Reuse a running editor or start one headless; close only the editors the CLI started |
| 📦 | **Server download** | Downloads the MCP server and checks its SHA-256 before running it |
| 📤 | **CLI contract** | Shared exit codes, `--format text\|json\|ndjson`, and one JSON result envelope |
| 🔄 | **Update check** | Tells the user when a newer CLI version is on npm |
| 🧱 | **`EngineAdapter`** | The only place where Unity, Unreal and Godot differ |

## See it in action

Every engine CLI gets the same commands and the same behaviour from this package:

<p align="center">
  <img src="docs/assets/terminal.svg" alt="A terminal session: sign in, configure Claude Code, list tools as a JSON envelope" width="100%"/>
</p>

## Install

```bash
npm install @baizor/gamedev-cli-core
```

Requires Node.js **22.14** or newer. ESM only, with TypeScript declarations included.

## Usage

**Identify a project.** The same path always gives the same pin and port, in TypeScript and in C#.

```ts
import { derivePinV2, derivePortV2 } from "@baizor/gamedev-cli-core";

const pin = derivePinV2("/work/my-game");   // routes MCP traffic to this project
const port = derivePortV2("/work/my-game"); // local server port, 20000–29999
```

**Connect an AI agent.** One call writes the agent's MCP config, pinned to the project.

```ts
import { setupMcp, unityAdapter } from "@baizor/gamedev-cli-core";

const result = await setupMcp({
  adapter: unityAdapter,       // or unrealAdapter / godotAdapter
  agentId: "claude-code",
  projectPath: "/work/my-game",
});
if (result.kind === "success") console.log(`Configured: ${result.configPath}`);
```

**Get an access token.** The provider refreshes it when needed, under a lock shared by all processes.

```ts
import {
  HttpTokenRefresher,
  MachineCredentialProvider,
  MachineCredentialStore,
  unityAdapter,
} from "@baizor/gamedev-cli-core";

const credentials = new MachineCredentialProvider(
  new MachineCredentialStore(), // ~/.ai-game-dev/credentials.json
  new HttpTokenRefresher({ defaultServerBaseUrl: "https://ai-game.dev" }),
  { defaultClientId: unityAdapter.clientId },
);
const token = await credentials.getAccessToken(); // throws LoginRequiredError when signed out
```

**Answer like every other CLI.** One result envelope and one set of exit codes.

```ts
import { CommandOutput, ExitCode, parseFormat } from "@baizor/gamedev-cli-core";

const output = new CommandOutput("tools", parseFormat("json"));
output.finish(ExitCode.Success, { tools: ["scene-list"] });
// stdout: { "success": true, "command": "tools", "data": { "tools": ["scene-list"] }, "errors": [], "warnings": [] }
```

## Exit codes

Scripts and AI agents can rely on these in every engine CLI:

| Exit | Meaning | Error codes |
|:---:|---|---|
| `0` | Success | |
| `1` | Unexpected error | `ERROR` |
| `2` | Bad command line, unknown tool or project | `USAGE`, `NOT_FOUND` |
| `6` | The command ran and failed, or sign-in was refused | `TOOL_FAILED`, `COMPILATION_FAILED`, `NOT_AUTHENTICATED` |
| `7` | The server or the engine plugin cannot be reached | `UNREACHABLE` |
| `8` | Tests failed | |
| `14` | Timed out | `TIMEOUT` |
| `17` | Busy: try again later, nothing ran | `BUSY` |
| `18` | A modal dialog blocks the editor: a human must answer it | |

The full table, with HTTP statuses, is `TOOL_FAILURE_CODES` and `EXIT_CODES` in
[`src/cli-contract.ts`](src/cli-contract.ts).

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run build       # dist/: ESM + .d.ts
npm test            # vitest
```

Releases are published to npm from the `release.yml` workflow with Trusted Publishing (OIDC).
Changes are listed in the [changelog](CHANGELOG.md).

## License

[MIT](LICENSE) © Ivan Murzak
