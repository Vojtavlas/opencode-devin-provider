/**
 * PKCE generation for Devin OAuth flow.
 * Uses Web Crypto API for cross-platform compatibility.
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");

  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = Buffer.from(hashBuffer).toString("base64url");

  return { verifier, challenge };
}

const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://api.devin.ai";
const TOKEN_PATH = "/auth/cli/token";
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Exchange a Devin CLI authorization code for a session token.
 */
export async function exchangeDevinCliToken(
  authorizationCode: string,
  codeVerifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(`${DEVIN_API_URL}${TOKEN_PATH}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: authorizationCode,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Devin CLI token exchange failed: ${response.status} ${error}`.trim());
  }

  const data = (await response.json()) as { token?: unknown };
  if (typeof data.token !== "string" || data.token.length === 0) {
    throw new Error("Devin CLI token exchange returned an empty token");
  }
  return data.token;
}

/**
 * Build the Devin OAuth authorization URL.
 */
export function buildDevinAuthUrl(
  state: string,
  redirectUri: string,
  challenge: string,
): string {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    prompt: "select_account",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`;
}

/**
 * Extract token expiry from a JWT, with a conservative fallback.
 */
export function getTokenExpiry(token: string): number {
  try {
    const [, payload] = token.split(".");
    if (payload) {
      const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
      if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
        return decoded.exp * 1000 - 5 * 60 * 1000;
      }
    }
  } catch {
    // Ignore malformed non-JWT tokens and use a conservative long-lived fallback.
  }
  return Date.now() + FALLBACK_EXPIRES_MS;
}

export { DEVIN_WEBAPP_URL, DEVIN_API_URL };
