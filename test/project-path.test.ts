import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { godotAdapter, unityAdapter, unrealAdapter } from "../src/engine-adapter.js";
import { readProcessCommandLine } from "../src/process.js";
import {
  canonicalPath,
  commandLineFileArgs,
  commandLineFlagValues,
  commandLineOpensFolder,
  samePath,
} from "../src/project-path.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-path-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("samePath", () => {
  it("compares absolute paths, case-insensitively on Windows and macOS only", () => {
    expect(samePath("/a/Proj", "/a/Proj/")).toBe(true);
    expect(samePath("/a/Proj", "/a/Proj copy")).toBe(false);
    expect(samePath("/a/PROJ", "/a/proj", "darwin")).toBe(true);
    expect(samePath("/a/PROJ", "/a/proj", "linux")).toBe(false);
  });

  it("resolves symlinks", () => {
    const real = path.join(dir, "real");
    const link = path.join(dir, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, "dir");
    expect(samePath(real, link)).toBe(true);
    expect(canonicalPath(link)).toBe(fs.realpathSync.native(real));
    expect(canonicalPath(path.join(dir, "missing"))).toBe(path.join(dir, "missing"));
  });
});

describe("commandLineFlagValues", () => {
  it("quoted, `=` and unquoted values; an unquoted one may contain spaces (a `ps` line)", () => {
    expect(commandLineFlagValues('Unity.exe -projectPath "C:\\My Proj" -batchmode', "-projectPath")).toEqual(["C:\\My Proj"]);
    expect(commandLineFlagValues("godot --path=/a/b --editor", "--path")).toEqual(["/a/b", "/a/b --editor"]);
    expect(commandLineFlagValues("/x/Unity -batchmode -projectPath /a/My Proj -logFile -", "-projectPath")).toEqual([
      "/a/My Proj",
      "/a/My Proj -logFile",
      "/a/My Proj -logFile -",
    ]);
    expect(commandLineFlagValues("unity -PROJECTPATH /a", "-projectPath")).toEqual(["/a"]);
  });

  it("ignores the flag inside another argument and a flag without a value", () => {
    expect(commandLineFlagValues("unity -projectPathX /a", "-projectPath")).toEqual([]);
    expect(commandLineFlagValues("unity /a-projectPath /b", "-projectPath")).toEqual([]);
    expect(commandLineFlagValues("unity -projectPath", "-projectPath")).toEqual([]);
  });
});

describe("commandLineFileArgs", () => {
  it("finds a quoted or unquoted .uproject argument", () => {
    expect(commandLineFileArgs('"C:\\UE\\UnrealEditor.exe" "C:\\My Game\\G.uproject" -unattended', ".uproject")).toEqual([
      "C:\\My Game\\G.uproject",
    ]);
    expect(commandLineFileArgs("/ue/UnrealEditor /p/My Game/G.uproject -unattended", ".uproject")).toEqual([
      "Game/G.uproject",
      "/p/My Game/G.uproject",
      "/ue/UnrealEditor /p/My Game/G.uproject",
    ]);
    expect(commandLineFileArgs("/ue/UnrealEditor -x=G.uprojectX", ".uproject")).toEqual([]);
  });
});

describe("commandLineOpensFolder", () => {
  it("takes the longest candidate that exists: `/p/Game - old` is not `/p/Game`", () => {
    const game = path.join(dir, "Game");
    const old = path.join(dir, "Game - old");
    fs.mkdirSync(game);
    fs.mkdirSync(old);
    const line = `/u/Unity -batchmode -projectPath ${old} -logFile -`;
    expect(unityAdapter.editor!.opensProject!(line, game)).toBe(false);
    expect(unityAdapter.editor!.opensProject!(line, old)).toBe(true);
  });

  it("never counts a relative candidate (it would resolve against our working directory)", () => {
    const cwd = process.cwd();
    const copy = path.join(dir, "My Game copy");
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, "My Game.uproject"), "{}");
    process.chdir(copy);
    try {
      const line = `/ue/UnrealEditor ${path.join(dir, "My Game", "My Game.uproject")} -RenderOffscreen`;
      expect(unrealAdapter.editor!.opensProject!(line, copy)).not.toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("an ambiguous line none of whose candidates exists does not tell; a single one is taken as it is", () => {
    expect(commandLineOpensFolder(["/gone/a", "/gone/a -x"], "/gone/a")).toBeUndefined();
    expect(commandLineOpensFolder(["/gone/a"], "/gone/a")).toBe(true);
    expect(commandLineOpensFolder([], "/gone/a")).toBe(false);
  });
});

describe("EditorLaunchSpec.opensProject", () => {
  it("Unity: -projectPath names exactly this project, never a sibling sharing its prefix", () => {
    const opens = unityAdapter.editor!.opensProject!;
    const proj = path.join(dir, "Proj");
    const copy = path.join(dir, "Proj copy");
    fs.mkdirSync(proj);
    fs.mkdirSync(copy);
    expect(opens(`/u/Unity -batchmode -projectPath ${proj} -logFile -`, proj)).toBe(true);
    expect(opens(`/u/Unity -batchmode -projectPath ${copy} -logFile -`, proj)).toBe(false);
    expect(opens(`/u/Unity -batchmode -projectPath ${proj} -logFile -`, copy)).toBe(false);
    expect(opens(`/u/Unity -batchmode -projectPath ${copy}`, copy)).toBe(true);
    expect(opens(`"C:\\U\\Unity.exe" -projectPath "${proj}" -batchmode`, proj)).toBe(true);
    expect(opens("/u/Unity -batchmode", proj)).toBe(false);
  });

  it("Godot: --path; Unreal: the .uproject's folder", () => {
    const g = path.join(dir, "G");
    const g2 = path.join(dir, "G2");
    fs.mkdirSync(g);
    fs.mkdirSync(g2);
    expect(godotAdapter.editor!.opensProject!(`godot --headless --editor --path ${g}`, g)).toBe(true);
    expect(godotAdapter.editor!.opensProject!(`godot --headless --editor --path ${g2}`, g)).toBe(false);
    const game = path.join(dir, "My Game");
    const copy = path.join(dir, "My Game copy");
    for (const folder of [game, copy]) {
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "G.uproject"), "{}");
    }
    const unreal = unrealAdapter.editor!.opensProject!;
    expect(unreal(`/ue/UnrealEditor ${path.join(game, "G.uproject")} -RenderOffscreen`, game)).toBe(true);
    expect(unreal(`/ue/UnrealEditor ${path.join(copy, "G.uproject")} -RenderOffscreen`, game)).toBe(false);
    expect(unreal(`/ue/UnrealEditor ${path.join(game, "G.uproject")} -RenderOffscreen`, copy)).toBe(false);
  });
});

describe("readProcessCommandLine", () => {
  it("reads this process's command line; undefined for an invalid pid", async () => {
    const line = await readProcessCommandLine(process.pid);
    expect(line).toBeDefined();
    expect(line!.toLowerCase()).toContain("node");
    expect(await readProcessCommandLine(-1)).toBeUndefined();
  });
});
