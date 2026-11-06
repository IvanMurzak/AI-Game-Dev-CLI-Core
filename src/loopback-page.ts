/**
 * The page the loopback redirect listener shows in the user's browser once the authorization server
 * sends it back. Self-contained by design: inline CSS and SVG only — no script, no fonts, no remote
 * assets — so it renders instantly under `default-src 'none'` and has nothing to load or leak. The
 * outcome comes from the redirect's own `error` parameter; its text is never echoed into the page
 * (fixed copy only, nothing attacker-controlled reaches the HTML).
 */

/** Which page to show: the browser leg finished, the user declined, or the server reported an error. */
export type LoopbackPageOutcome = "success" | "denied" | "error";

/** The Content-Security-Policy the page is served with: inline styles, nothing else. */
export const LOOPBACK_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

const LOGO =
  '<svg class="logo" viewBox="160 170 704 650" aria-hidden="true"><defs>' +
  '<linearGradient id="l" gradientUnits="userSpaceOnUse" x1="512" y1="190" x2="512" y2="785"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#8395AD"/></linearGradient>' +
  '<linearGradient id="r" gradientUnits="userSpaceOnUse" x1="512" y1="190" x2="512" y2="785"><stop offset="0" stop-color="#E1E8F1"/><stop offset="1" stop-color="#455974"/></linearGradient>' +
  '<linearGradient id="b" gradientUnits="userSpaceOnUse" x1="512" y1="190" x2="512" y2="785"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#AABBD0"/></linearGradient></defs>' +
  '<path d="M512 194 512 504 366 785H185Z" fill="url(#l)"/><path d="M512 194 839 785H658L512 504Z" fill="url(#r)"/><path d="M512 194V294L223 767 185 785Z" fill="url(#b)"/></svg>';

const PAGES: Record<LoopbackPageOutcome, { readonly title: string; readonly heading: string; readonly text: string; readonly icon: string }> = {
  success: {
    title: "Signed in — AI Game Dev",
    heading: "You’re signed in",
    text: "Head back to the app or terminal where you started. You can close this tab.",
    icon: '<path d="m7 12.5 3.3 3.3L17.5 8.5"/>',
  },
  denied: {
    title: "Sign-in cancelled — AI Game Dev",
    heading: "Sign-in cancelled",
    text: "The request was declined, so nothing was shared. You can close this tab and start again whenever you’re ready.",
    icon: '<path d="M8 8l8 8M16 8l-8 8"/>',
  },
  error: {
    title: "Sign-in failed — AI Game Dev",
    heading: "Sign-in didn’t finish",
    text: "Something went wrong on the way back. Close this tab and start the sign-in again from the app or terminal.",
    icon: '<path d="M12 7.5v5.5M12 16.5h.01"/>',
  },
};

const STYLES =
  ":root{color-scheme:dark}*{box-sizing:border-box}" +
  "html,body{margin:0;height:100%}" +
  "body{display:grid;place-items:center;padding:24px;background:#05090d;color:#fafffd;" +
  "font:16px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;" +
  "background-image:radial-gradient(ellipse 45% 60% at 20% 20%,rgba(255,0,42,.16),transparent 70%)," +
  "radial-gradient(ellipse 45% 60% at 80% 80%,rgba(59,155,255,.14),transparent 70%)," +
  "radial-gradient(circle at 1px 1px,rgba(168,194,210,.07) 1px,transparent 0);background-size:auto,auto,28px 28px}" +
  ".card{position:relative;width:min(420px,100%);padding:40px 32px 32px;text-align:center;border-radius:22px;" +
  "border:1px solid rgba(111,168,208,.16);background:linear-gradient(180deg,rgba(13,26,37,.92),rgba(6,11,17,.94));" +
  "box-shadow:0 40px 80px -40px #000;animation:in .5s cubic-bezier(.2,.8,.2,1) both}" +
  ".card:before{content:'';position:absolute;top:0;left:32px;right:32px;height:2px;background:linear-gradient(90deg,#ff2448,#3b9bff);opacity:.8}" +
  ".brand{display:inline-flex;align-items:center;gap:10px;margin-bottom:28px;color:#a8c2d2;font-size:14px;font-weight:600;letter-spacing:.02em}" +
  ".logo{width:22px;height:22px}" +
  ".badge{display:grid;place-items:center;width:72px;height:72px;margin:0 auto 22px;border-radius:50%;" +
  "border:1px solid var(--c-border);background:radial-gradient(circle,var(--c-fill),transparent 75%);color:var(--c);" +
  "box-shadow:0 0 48px -8px var(--c-glow);animation:pop .5s .15s cubic-bezier(.2,1.4,.4,1) both}" +
  ".badge svg{width:34px;height:34px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}" +
  ".success{--c:#6ee7b7;--c-border:rgba(52,211,153,.4);--c-fill:rgba(52,211,153,.2);--c-glow:rgba(52,211,153,.5)}" +
  ".denied{--c:#a8c2d2;--c-border:rgba(168,194,210,.3);--c-fill:rgba(168,194,210,.1);--c-glow:transparent}" +
  ".error{--c:#fca5a5;--c-border:rgba(248,113,113,.4);--c-fill:rgba(239,68,68,.16);--c-glow:rgba(239,68,68,.35)}" +
  "h1{margin:0 0 8px;font-size:26px;line-height:1.25;font-weight:800;letter-spacing:-.02em}" +
  "p{margin:0;color:#8aa6b8;font-size:15px}" +
  "@keyframes in{from{opacity:0;transform:translateY(8px)}}" +
  "@keyframes pop{from{opacity:0;transform:scale(.6)}}" +
  "@media (prefers-reduced-motion:reduce){.card,.badge{animation:none}}";

/**
 * Map the redirect to the page outcome: `access_denied` = the user said no, any other error or a
 * redirect without a code = failed. (The code's `state` and exchange are checked later, by the flow.)
 */
export function loopbackPageOutcome(error: string | undefined, code: string | undefined): LoopbackPageOutcome {
  if (error === "access_denied") return "denied";
  return error || !code ? "error" : "success";
}

function render(outcome: LoopbackPageOutcome): string {
  const page = PAGES[outcome];
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${page.title}</title><style>${STYLES}</style></head><body>` +
    `<main class="card ${outcome}" role="status">` +
    `<div class="brand">${LOGO}AI Game Dev</div>` +
    `<div class="badge"><svg viewBox="0 0 24 24" aria-hidden="true">${page.icon}</svg></div>` +
    `<h1>${page.heading}</h1><p>${page.text}</p>` +
    "</main></body></html>"
  );
}

/** The three documents, built once: the listener only ever serves one of them. */
export const LOOPBACK_PAGES: Readonly<Record<LoopbackPageOutcome, string>> = {
  success: render("success"),
  denied: render("denied"),
  error: render("error"),
};
