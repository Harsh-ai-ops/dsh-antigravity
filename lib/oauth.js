import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";

// Google Cloud Code / Antigravity OAuth public client constants
const charArrToString = (codes) => String.fromCharCode(...codes);

export const ANTIGRAVITY_CLIENT_ID = charArrToString([
  49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110,
  50, 104, 50, 49, 108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103,
  52, 48, 51, 101, 112, 46, 97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115,
  101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109,
]);

export const ANTIGRAVITY_CLIENT_SECRET = charArrToString([
  71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109,
  76, 66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102,
]);

export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

export function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function encodeState(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeState(state) {
  try {
    const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return {
      verifier: typeof parsed.verifier === "string" ? parsed.verifier : "",
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
    };
  } catch (err) {
    throw new Error(`Failed to decode OAuth state: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function openUrlInBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {}
}

export function createAuthorizationRequest(projectId = "") {
  const pkce = generatePKCE();
  const state = encodeState({ verifier: pkce.verifier, projectId: projectId || "" });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state,
    projectId,
  };
}

export async function exchangeCodeForTokens(code, stateStr) {
  let verifier = "";
  let projectId = "";
  if (stateStr) {
    try {
      const decoded = decodeState(stateStr);
      verifier = decoded.verifier;
      projectId = decoded.projectId;
    } catch {}
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
      "User-Agent": "google-api-nodejs-client/9.15.1",
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      ...(verifier ? { code_verifier: verifier } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!tokenRes.ok) {
    throw new Error(`OAuth token exchange failed (${tokenRes.status}): ${await tokenRes.text()}`);
  }

  const payload = await tokenRes.json();
  if (!payload.refresh_token) {
    throw new Error("Google OAuth did not return a refresh_token (was prompt=consent used?)");
  }

  let email = "antigravity-user";
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: {
        Authorization: `Bearer ${payload.access_token}`,
        "User-Agent": "google-api-nodejs-client/9.15.1",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      if (userData.email) email = userData.email;
    }
  } catch {}

  const effectiveProject = projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;
  const storedRefreshKey = `${payload.refresh_token}|${effectiveProject}`;
  const expiresAt = Date.now() + Math.max(0, (payload.expires_in || 3600) - 300) * 1000;

  return {
    refreshToken: storedRefreshKey,
    accessToken: payload.access_token,
    expiresAt,
    email,
    projectId: effectiveProject,
  };
}

export async function refreshAccessToken(refreshTokenKey) {
  const [actualToken, projectPart] = refreshTokenKey.split("|");
  const projectId = projectPart || ANTIGRAVITY_DEFAULT_PROJECT_ID;
  if (!actualToken) return null;

  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "*/*",
        "User-Agent": "google-api-nodejs-client/9.15.1",
      },
      body: new URLSearchParams({
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
        refresh_token: actualToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      return null;
    }

    const payload = await res.json();
    const expiresAt = Date.now() + Math.max(0, (payload.expires_in || 3600) - 300) * 1000;
    return {
      accessToken: payload.access_token,
      expiresAt,
      projectId,
    };
  } catch {
    return null;
  }
}

export function startOAuthCallbackServer(onSuccess, port = 51121) {
  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://localhost:${port}`);
      if (reqUrl.pathname === "/oauth-callback") {
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h2>Authentication Failed</h2><p>${error}</p>`);
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <html>
              <body style="font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 90vh; background: #0f172a; color: #f8fafc;">
                <div style="background: #1e293b; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.5);">
                  <h2 style="color: #38bdf8; margin-top: 0;">Authentication Successful!</h2>
                  <p style="color: #94a3b8;">Google Antigravity is now connected to your DeepSeek Harness.</p>
                  <p style="font-size: 0.875rem; color: #64748b;">You can close this tab and return to DSH.</p>
                </div>
              </body>
            </html>
          `);
          server.close();
          onSuccess(code, state || undefined);
          return;
        }
      }
      res.writeHead(404);
      res.end("Not Found");
    } catch {
      res.writeHead(500);
      res.end("Server Error");
    }
  });

  server.listen(port, "127.0.0.1");

  return () => {
    try {
      server.close();
    } catch {}
  };
}
