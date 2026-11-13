"""Generate docs/assets/terminal.svg: an animated, looping terminal session (SMIL, no JS).

Usage: python docs/assets/build-terminal.py docs/assets/terminal.svg
"""

import sys
from xml.sax.saxutils import escape

OUT = sys.argv[1]
T = 18.0          # loop length, seconds
CW = 9.1          # approx monospace char width at 15px
X0, Y0, LH = 36, 84, 27
FADE_OUT = 17.2   # everything fades out from here to T

# (kind, text, start, note) kind: cmd = typed, out = appears at once
LINES = [
    ("cmd", "unity-mcp-cli login", 0.6, None),
    ("out", [("dim", "  Open "), ("link", "https://ai-game.dev/device"), ("dim", " and enter "), ("code", "KQ7M-2XWD")], 2.3, "deviceLogin()"),
    ("out", [("ok", "  ✓ "), ("txt", "Signed in · credentials saved to ~/.ai-game-dev")], 3.6, "MachineCredentialStore"),
    ("cmd", "unity-mcp-cli setup-mcp claude-code", 4.8, None),
    ("out", [("ok", "  ✓ "), ("txt", "Claude Code → "), ("link", "https://ai-game.dev/mcp/p/6c1e9a…")], 7.0, "setupMcp() · derivePinV2()"),
    ("cmd", "unity-mcp-cli tools --format json", 8.2, None),
    ("out", [("punc", "{ "), ("key", "\"success\""), ("punc", ": "), ("bool", "true"), ("punc", ", "), ("key", "\"command\""), ("punc", ": "), ("str", "\"tools\""), ("punc", ",")], 10.4, "CommandOutput"),
    ("out", [("punc", "  "), ("key", "\"data\""), ("punc", ": [ … ], "), ("key", "\"errors\""), ("punc", ": [], "), ("key", "\"warnings\""), ("punc", ": [] }")], 10.6, None),
    ("out", [("dim", "  exit code "), ("ok", "0")], 11.6, "ExitCode.Success"),
]

COLORS = {
    "dim": "#94a3b8", "link": "#67e8f9", "code": "#fbbf24", "ok": "#34d399", "txt": "#e2e8f0",
    "punc": "#cbd5e1", "key": "#a5b4fc", "bool": "#f472b6", "str": "#fcd34d",
}


def k(t):
    return round(t / T, 4)


def fade(start):
    """opacity: hidden until start, visible until FADE_OUT, then 0."""
    return (f'<animate attributeName="opacity" dur="{T}s" repeatCount="indefinite" calcMode="linear" '
            f'values="0;0;1;1;0;0" keyTimes="0;{k(start)};{k(start + 0.25)};{k(FADE_OUT)};{k(FADE_OUT + 0.5)};1"/>')


body = []
y = Y0
n_lines = len(LINES)
for kind, content, start, note in LINES:
    if kind == "cmd":
        text = content
        n = len(text) + 2
        body.append(f'<g>{fade(start)}'
                    f'<text x="{X0}" y="{y}" class="m"><tspan fill="#34d399">❯</tspan> <tspan fill="#f8fafc">{escape(text)}</tspan></text>')
        # typing: a cover rect that steps right, one char per 45 ms
        step = 0.045
        vals, times = ["0 0"], ["0"]
        vals.append("0 0"); times.append(str(k(start)))
        for i in range(1, n + 1):
            vals.append(f"{round(i * CW, 1)} 0"); times.append(str(k(start + 0.15 + i * step)))
        vals.append(f"{round((n + 1) * CW + 900, 1)} 0"); times.append(str(k(start + 0.15 + (n + 1) * step)))
        vals.append(f"{round((n + 1) * CW + 900, 1)} 0"); times.append("1")
        body.append(f'<rect x="{X0 - 2}" y="{y - 19}" width="900" height="26" fill="#0b1222" transform="translate(2000 0)">'
                    f'<animateTransform attributeName="transform" type="translate" dur="{T}s" repeatCount="indefinite" '
                    f'calcMode="discrete" values="{";".join(vals)}" keyTimes="{";".join(times)}"/></rect></g>')
    else:
        spans = "".join(f'<tspan fill="{COLORS[c]}">{escape(s)}</tspan>' for c, s in content)
        body.append(f'<g>{fade(start)}<text x="{X0}" y="{y}" class="m">{spans}</text>')
        if note:
            body.append(f'<text x="964" y="{y}" class="m note" text-anchor="end">← {escape(note)}</text>')
        body.append('</g>')
    y += LH

# final prompt with a blinking caret
body.append(f'<g>{fade(12.4)}<text x="{X0}" y="{y}" class="m"><tspan fill="#34d399">❯</tspan></text>'
            f'<rect x="{X0 + 20}" y="{y - 15}" width="9" height="18" fill="#e2e8f0">'
            f'<animate attributeName="opacity" values="1;0" dur="1.1s" calcMode="discrete" repeatCount="indefinite"/></rect></g>')

H = y + 40
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="{H}" viewBox="0 0 1000 {H}" role="img" aria-label="A terminal session: an engine CLI built on cli-core signs in, configures Claude Code and lists tools as a JSON envelope">
  <defs>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e293b"/><stop offset="1" stop-color="#162032"/></linearGradient>
    <clipPath id="frame"><rect width="1000" height="{H}" rx="14"/></clipPath>
  </defs>
  <style>
    .m {{ font-family: "JetBrains Mono", "Cascadia Code", Consolas, Menlo, monospace; font-size: 15px; white-space: pre; }}
    .note {{ fill: #7c87a6; font-size: 12.5px; font-style: italic; }}
    .sans {{ font-family: "Segoe UI", Inter, -apple-system, Helvetica, Arial, sans-serif; }}
  </style>
  <g clip-path="url(#frame)">
    <rect width="1000" height="{H}" fill="#0b1222"/>
    <rect width="1000" height="44" fill="url(#bar)"/>
    <circle cx="26" cy="22" r="6.5" fill="#f87171"/><circle cx="48" cy="22" r="6.5" fill="#fbbf24"/><circle cx="70" cy="22" r="6.5" fill="#34d399"/>
    <text x="500" y="27" text-anchor="middle" class="sans" font-size="13" fill="#94a3b8">~/games/my-project — built on @baizor/gamedev-cli-core</text>
    {"".join(body)}
  </g>
  <rect x=".5" y=".5" width="999" height="{H - 1}" rx="14" fill="none" stroke="#ffffff" stroke-opacity=".1"/>
</svg>
'''
with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(svg)
print("wrote", OUT, H)
