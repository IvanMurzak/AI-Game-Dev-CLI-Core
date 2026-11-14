"""Regenerate the README images (hero, architecture, terminal) in the shared ai-game.dev style.

Usage: python docs/assets/build-svgs.py

svgkit.py next to this file holds the shared style (copied from the workspace kit; keep it unchanged here).
Every image is a dark panel, fully visible without animation, with no text below 16 px on a 1200 px canvas.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import svgkit as K  # noqa: E402


def out(name):
    return os.path.join(HERE, name)


# ---- hero: the app logo in the middle, the four consumers around it ----------------------------------
def hero_right():
    cx, cy = 970, 190
    parts = []
    for i, (label, px, py) in enumerate([("Unity CLI", 780, 52), ("Unreal CLI", 1020, 52),
                                         ("Godot CLI", 780, 294), ("Desktop App", 1020, 294)]):
        w = 140
        pcx, pcy = px + w / 2, py + (34 if py < cy else 0)
        dx, dy = cx - pcx, cy - pcy
        d = math.hypot(dx, dy)
        ex, ey = cx - dx / d * 86, cy - dy / d * 86
        parts.append(K.wire(f"M{pcx:.0f} {pcy:.0f} L{ex:.0f} {ey:.0f}", color=K.BLUE if i % 2 else K.RED_TEXT,
                            dur=2.4, begin=round(i * 0.6, 2)))
        parts.append(K.pill(px, py, label, mono=False, w=w)[0])
    parts.append(K.mark(cx, cy, 64))
    return "".join(parts)


K.write(out("hero.svg"), K.hero(
    title="AI Game Dev CLI ", accent="Core", accent_fx="flow", eyebrow_text="Zero runtime dependencies",
    subtitle=["One TypeScript core behind every engine CLI:", "Unity, Unreal, Godot and the desktop App."],
    chip_items=["npm i @baizor/gamedev-cli-core", "Node 22.14+"],
    right=hero_right(),
    label="AI Game Dev CLI Core: one TypeScript core behind the Unity, Unreal and Godot CLIs and the desktop App"))


# ---- architecture: consumers -> cli-core modules -> what it talks to ----------------------------------
def architecture():
    b = [K.eyebrow(40, 64, "Consumers"), K.logo(436, 58, 24), (f'<text x="612" y="64" text-anchor="middle" class="m" font-size="16" font-weight="700" '
          f'fill="{K.RED_TEXT}">@baizor/gamedev-cli-core</text>'),
         K.eyebrow(1160, 64, "Talks to", anchor="end")]
    rows = [88, 170, 252, 334]
    hub_y = 246
    left = [("unity-mcp-cli", "Unity engine CLI", True), ("unreal-mcp-cli", "Unreal Engine CLI", True),
            ("godot-cli", "Godot engine CLI", True), ("AI Game Developer App", "desktop: sign-in and setup", False)]
    right = [("ai-game.dev", "OAuth server · MCP relay"), ("Local MCP server", "verified download, own port"),
             ("Game engine editor", "headless or windowed, leased"), ("AI agent configs", "Claude Code, Cursor, Codex, …")]
    for i, ((t, s, mono), y) in enumerate(zip(left, rows)):
        b.append(K.wire(f"M320 {y + 35} C356 {y + 35} 352 {hub_y} 388 {hub_y}", color=K.BLUE, begin=round(i * 0.6, 2)))
        b.append(K.card(40, y, 280, 70, t, sub=s, accent="blue", mono_title=mono))
    for i, ((t, s), y) in enumerate(zip(right, rows)):
        b.append(K.wire(f"M812 {hub_y} C848 {hub_y} 844 {y + 35} 880 {y + 35}", color=K.GREEN, begin=round(i * 0.6, 2)))
        b.append(K.card(880, y, 280, 70, t, sub=s, accent="green"))
    # the core: module chips + the engine adapter
    b.append(f'<rect x="388" y="88" width="424" height="316" rx="14" fill="url(#card)" stroke="{K.RED_TEXT}" stroke-opacity=".45"/>')
    mods = ["OAuth sign-in", "Credentials & refresh", "Project pin & port", "AI agent configs",
            "Editor sessions", "Server download", "Exit codes & JSON", "Update check"]
    for i, m in enumerate(mods):
        b.append(K.pill(402 + (i % 2) * 204, 106 + (i // 2) * 48, m, mono=False, w=192)[0])
    b.append(K.card(402, 304, 396, 84, "EngineAdapter", sub="the only place where the engines differ",
                    accent="red", mono_title=True))
    b.append(f'<text x="600" y="452" text-anchor="middle" class="s" font-size="16" fill="{K.MUTED}">'
             f'Node.js ≥ 22.14 · ESM + type declarations · zero runtime dependencies</text>')
    return K.panel(1200, 490, "".join(b),
                   "Architecture: the engine CLIs and the App call cli-core, which talks to ai-game.dev, "
                   "the local MCP server, the engine editor and AI agent configs")


K.write(out("architecture.svg"), architecture())


# ---- terminal: what an engine CLI built on cli-core does ---------------------------------------------
K.write(out("terminal.svg"), K.terminal(
    title="~/games/my-project — built on @baizor/gamedev-cli-core", hold=7.0,
    label="A terminal session: an engine CLI built on cli-core signs in, configures Claude Code and lists tools as a JSON envelope",
    lines=[
        {"cmd": "unity-mcp-cli login"},
        {"out": [("muted", "  Open "), ("link", "https://ai-game.dev/device"), ("muted", " and enter "), ("str", "KQ7M-2XWD")],
         "note": "deviceLogin()", "pause": 0.6},
        {"out": [("ok", "  ✓ "), ("text", "Signed in · credentials saved to ~/.ai-game-dev")],
         "note": "MachineCredentialStore", "pause": 1.0},
        {"cmd": "unity-mcp-cli setup-mcp claude-code"},
        {"out": [("ok", "  ✓ "), ("text", "Claude Code → "), ("link", "https://ai-game.dev/mcp/p/6c1e9a…")],
         "note": "setupMcp() · derivePinV2()", "pause": 0.6},
        {"cmd": "unity-mcp-cli tools --format json"},
        {"out": [("text", "{ "), ("key", '"success"'), ("text", ": "), ("num", "true"), ("text", ", "),
                 ("key", '"command"'), ("text", ": "), ("str", '"tools"'), ("text", ",")], "note": "CommandOutput", "pause": 0.6},
        {"out": [("text", "  "), ("key", '"data"'), ("text", ": { … }, "), ("key", '"errors"'), ("text", ": [], "),
                 ("key", '"warnings"'), ("text", ": [] }")], "pause": 0.0},
        {"out": [("muted", "  exit code "), ("ok", "0")], "note": "ExitCode.Success", "pause": 0.8},
    ]))
