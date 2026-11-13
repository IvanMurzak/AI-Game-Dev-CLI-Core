import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { godotAdapter, unityAdapter, unrealAdapter } from "../src/engine-adapter.js";
import { readProcessCommandLine } from "../src/process.js";
import { canonicalPath, commandLineFileArgs, commandLineFlagValues, samePath } from "../src/project-path.js";

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

describe("EditorLaunchSpec.opensProject", () => {
  it("Unity: -projectPath names exactly this project, never a sibling sharing its prefix", () => {
    const opens = unityAdapter.editor!.opensProject!;
    expect(opens("/u/Unity -batchmode -projectPath /p/Proj -logFile -", "/p/Proj")).toBe(true);
    expect(opens("/u/Unity -batchmode -projectPath /p/Proj copy -logFile -", "/p/Proj")).toBe(false);
    expect(opens("/u/Unity -batchmode -projectPath /p/Proj -logFile -", "/p/Proj copy")).toBe(false);
    expect(opens("/u/Unity -batchmode -projectPath /p/Proj copy", "/p/Proj copy")).toBe(true);
    expect(opens("/u/Unity -batchmode", "/p/Proj")).toBe(false);
  });

  it("Godot: --path; Unreal: the .uproject's folder", () => {
    expect(godotAdapter.editor!.opensProject!("godot --headless --editor --path /p/G", "/p/G")).toBe(true);
    expect(godotAdapter.editor!.opensProject!("godot --headless --editor --path /p/G2", "/p/G")).toBe(false);
    const unreal = unrealAdapter.editor!.opensProject!;
    expect(unreal("/ue/UnrealEditor /p/My Game/G.uproject -RenderOffscreen", "/p/My Game")).toBe(true);
    expect(unreal("/ue/UnrealEditor /p/My Game copy/G.uproject -RenderOffscreen", "/p/My Game")).toBe(false);
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
