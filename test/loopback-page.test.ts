import { describe, expect, it } from "vitest";
import { createLoopbackListener } from "../src/oauth-authcode-flow.js";
import { LOOPBACK_PAGES, loopbackPageOutcome } from "../src/loopback-page.js";

describe("loopback page", () => {
  it("maps the redirect error to an outcome", () => {
    expect(loopbackPageOutcome(undefined, "abc")).toBe("success");
    expect(loopbackPageOutcome("access_denied", undefined)).toBe("denied");
    expect(loopbackPageOutcome("server_error", undefined)).toBe("error");
    expect(loopbackPageOutcome(undefined, undefined)).toBe("error");
  });

  it("is self-contained: no script and no remote asset", () => {
    for (const html of Object.values(LOOPBACK_PAGES)) {
      expect(html).not.toMatch(/<script|<link|https?:\/\/(?!www\.w3\.org)/i);
    }
  });

  it("serves the outcome page under a strict CSP, never echoing the error text", async () => {
    const listener = await createLoopbackListener({ host: "127.0.0.1", path: "/callback", timeoutMs: 2000 });
    try {
      const wait = listener.waitForRedirect();
      const res = await fetch(
        `${listener.redirectUri}?error=access_denied&error_description=${encodeURIComponent("<b>evil</b>")}`,
      );
      const html = await res.text();
      expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
      expect(html).toContain("Sign-in cancelled");
      expect(html).not.toContain("evil");
      await expect(wait).resolves.toMatchObject({ error: "access_denied" });
    } finally {
      listener.close();
    }
  });

  it("shows the success page for a code redirect", async () => {
    const listener = await createLoopbackListener({ host: "127.0.0.1", path: "/callback", timeoutMs: 2000 });
    try {
      const res = await fetch(`${listener.redirectUri}?code=abc&state=xyz`);
      expect(await res.text()).toContain("You’re signed in");
    } finally {
      listener.close();
    }
  });
});
