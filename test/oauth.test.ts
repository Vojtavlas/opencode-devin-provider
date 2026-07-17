import { describe, it, expect } from "bun:test";
import { generatePKCE, buildDevinAuthUrl, getTokenExpiry } from "../src/oauth.js";

describe("PKCE", () => {
  it("generates a verifier and challenge pair", async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier.length).toBeGreaterThan(0);
    expect(challenge.length).toBeGreaterThan(0);
    expect(verifier).not.toBe(challenge);
  });

  it("generates unique values each call", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("buildDevinAuthUrl", () => {
  it("builds a URL with PKCE parameters", () => {
    const url = buildDevinAuthUrl("state123", "http://127.0.0.1:59653/callback", "challenge456");
    expect(url).toContain("https://app.devin.ai/auth/cli/continue");
    expect(url).toContain("state=state123");
    expect(url).toContain("code_challenge=challenge456");
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("prompt=select_account");
  });
});

describe("getTokenExpiry", () => {
  it("returns a future timestamp for non-JWT tokens", () => {
    const expiry = getTokenExpiry("not-a-jwt");
    expect(expiry).toBeGreaterThan(Date.now());
  });

  it("reads exp from a JWT", () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url");
    const token = `header.${payload}.signature`;
    const expiry = getTokenExpiry(token);
    // exp is 2000000000 seconds = 2000000000000 ms, minus 5 minutes
    expect(expiry).toBe(2000000000000 - 5 * 60 * 1000);
  });
});
