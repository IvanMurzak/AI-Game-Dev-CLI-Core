import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInstallTarget, probeProjectMarkers, unityAdapter, unrealAdapter, godotAdapter, brutalAdapter } from "../src/index.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clicore-install-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("install-plugin — marker probe", () => {
  it("finds a Unity project by Packages/manifest.json", () => {
    fs.mkdirSync(path.join(tmp, "Packages"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "Packages", "manifest.json"), "{}");
    const probe = probeProjectMarkers(tmp, unityAdapter.markers);
    expect(probe.found).toBe(true);
  });

  it("finds an Unreal project by any *.uproject", () => {
    fs.writeFileSync(path.join(tmp, "MyGame.uproject"), "{}");
    expect(probeProjectMarkers(tmp, unrealAdapter.markers).found).toBe(true);
  });

  it("finds a Godot project by project.godot", () => {
    fs.writeFileSync(path.join(tmp, "project.godot"), "");
    expect(probeProjectMarkers(tmp, godotAdapter.markers).found).toBe(true);
  });

  it("finds a Brutal project by a root *.csproj referencing Ahwoo.BRUTAL.*", () => {
    fs.writeFileSync(
      path.join(tmp, "MyGame.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Ahwoo.BRUTAL.Core" Version="1.0.0" />\n  </ItemGroup>\n</Project>\n`,
    );
    const probe = probeProjectMarkers(tmp, brutalAdapter.markers);
    expect(probe.found).toBe(true);
    expect(probe.matched).toEqual({ kind: "csproj-ref", packagePrefix: "Ahwoo.BRUTAL." });
  });

  it("brutal marker tolerates single quotes, whitespace and prefix case", () => {
    fs.writeFileSync(path.join(tmp, "Game.csproj"), `<PackageReference Include = ' ahwoo.brutal.Engine' Version='2.0.0'/>`);
    expect(probeProjectMarkers(tmp, brutalAdapter.markers).found).toBe(true);
  });

  it("brutal marker ignores a Godot C# csproj without a BRUTAL reference", () => {
    fs.writeFileSync(
      path.join(tmp, "MyGodotGame.csproj"),
      `<Project Sdk="Godot.NET.Sdk/4.3.0">\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n  </ItemGroup>\n</Project>\n`,
    );
    fs.writeFileSync(path.join(tmp, "project.godot"), "");
    const probe = probeProjectMarkers(tmp, brutalAdapter.markers);
    expect(probe.found).toBe(false);
    expect(probe.checked.some((c) => c.includes("*.csproj") && c.includes("Ahwoo.BRUTAL."))).toBe(true);
  });

  it("brutal marker ignores a BRUTAL csproj nested below the root (non-recursive)", () => {
    fs.mkdirSync(path.join(tmp, "src", "Game"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src", "Game", "Game.csproj"), `<PackageReference Include="Ahwoo.BRUTAL.Core" />`);
    expect(probeProjectMarkers(tmp, brutalAdapter.markers).found).toBe(false);
  });

  it("misses when no marker is present, listing what was checked", () => {
    const probe = probeProjectMarkers(tmp, unrealAdapter.markers);
    expect(probe.found).toBe(false);
    expect(probe.checked.some((c) => c.includes(".uproject"))).toBe(true);
  });
});

describe("install-plugin — T5 resolution ladder (B1 fix)", () => {
  it("resolves from cwd when no path is given (closes B1)", () => {
    fs.mkdirSync(path.join(tmp, "Packages"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "Packages", "manifest.json"), "{}");
    const res = resolveInstallTarget({ adapter: unityAdapter, cwd: tmp });
    expect(res.kind).toBe("success");
    if (res.kind === "success") {
      expect(res.source).toBe("cwd");
      // Compare PHYSICAL paths: on macOS os.tmpdir() is a symlink (/var → /private/var), and the
      // ladder resolves the given cwd without canonicalizing symlinks — same directory either way.
      expect(fs.realpathSync(res.projectRoot)).toBe(fs.realpathSync(tmp));
    }
  });

  it("prefers a positional path, then --path, over cwd", () => {
    fs.writeFileSync(path.join(tmp, "A.uproject"), "{}");
    const viaPositional = resolveInstallTarget({ adapter: unrealAdapter, positional: tmp, cwd: "/nowhere" });
    expect(viaPositional.kind === "success" && viaPositional.source).toBe("positional");
    const viaFlag = resolveInstallTarget({ adapter: unrealAdapter, path: tmp, cwd: "/nowhere" });
    expect(viaFlag.kind === "success" && viaFlag.source).toBe("path");
  });

  it("fails with a clear error listing exactly what was checked when the marker is missing", () => {
    const res = resolveInstallTarget({ adapter: unrealAdapter, cwd: tmp });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") {
      expect(res.error.message).toContain("Not a valid unreal project");
      expect(res.error.message).toContain(".uproject");
      expect(res.error.message).toContain("--path");
    }
  });

  it("fails when the resolved path does not exist", () => {
    const res = resolveInstallTarget({ adapter: unityAdapter, positional: path.join(tmp, "missing") });
    expect(res.kind).toBe("failure");
    if (res.kind === "failure") expect(res.error.message).toContain("does not exist");
  });

  it("requireMarker:false downgrades a marker miss to a warning (rarer not-yet-init flow)", () => {
    const res = resolveInstallTarget({ adapter: unrealAdapter, cwd: tmp, requireMarker: false });
    expect(res.kind).toBe("success");
    if (res.kind === "success") expect(res.warning).toContain("Not a valid unreal project");
  });
});
