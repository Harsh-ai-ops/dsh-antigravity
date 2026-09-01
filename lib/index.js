import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { startGateway, loadStore, saveStore, pickKey, markRateLimit, getValidAccessToken } from "./engine.js";
import {
  createAuthorizationRequest,
  startOAuthCallbackServer,
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchUserQuota,
  openUrlInBrowser,
} from "./oauth.js";

export const name = "dsh-antigravity";

const SETTINGS_FILE = path.join(os.homedir(), ".dsh/settings.yaml");
const CREDENTIALS_FILE = path.join(os.homedir(), ".dsh/.credentials.yaml");
const KEYS_FILE = path.join(os.homedir(), ".dsh/antigravity-keys.json");

const PROVIDER_BLOCK = `    antigravity:
      displayName: Antigravity (Google)
      apiKeyEnv: ANTIGRAVITY_LOCAL_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      models:
        - id: gemini-3.7-flash
          name: Gemini 3.7 Flash
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3.7-flash-high
          name: Gemini 3.7 Flash (High Thinking)
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3.7-flash-medium
          name: Gemini 3.7 Flash (Medium Thinking)
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3.7-flash-low
          name: Gemini 3.7 Flash (Low Thinking)
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3.6-flash-high
          name: Gemini 3.6 Flash (High Thinking)
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3.6-flash-medium
          name: Gemini 3.6 Flash (Medium Thinking)
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3.6-flash-low
          name: Gemini 3.6 Flash (Low Thinking)
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-pro-agent
          name: Gemini Pro Agent
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3.1-pro-low
          name: Gemini 3.1 Pro (Low Thinking)
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: gemini-3-flash-agent
          name: Gemini 3 Flash Agent
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]
        - id: claude-sonnet-4-6
          name: Claude Sonnet 4.6 (Antigravity)
          contextWindow: 200000
          maxTokens: 32000
          input: [text, image]
        - id: claude-opus-4-6-thinking
          name: Claude Opus 4.6 Thinking (Antigravity)
          contextWindow: 200000
          maxTokens: 32000
          input: [text, image]
        - id: gpt-oss-120b-medium
          name: GPT-OSS 120B (Antigravity)
          contextWindow: 131072
          maxTokens: 32768
          input: [text, image]
`;

function ensureProviderConfigured() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const settings = fs.readFileSync(SETTINGS_FILE, "utf8");
    if (!settings.includes("antigravity:")) {
      let updated = settings;
      if (updated.includes("providers:\n")) {
        updated = updated.replace("providers:\n", "providers:\n" + PROVIDER_BLOCK);
      } else if (updated.includes("llm-pi-ai:\n")) {
        updated = updated.replace("llm-pi-ai:\n", "llm-pi-ai:\n  providers:\n" + PROVIDER_BLOCK);
      }
      fs.writeFileSync(SETTINGS_FILE, updated, "utf8");
    }

    if (fs.existsSync(CREDENTIALS_FILE)) {
      const creds = fs.readFileSync(CREDENTIALS_FILE, "utf8");
      if (!creds.includes("ANTIGRAVITY_LOCAL_KEY")) {
        const updatedCreds = creds.replace("refs:\n", "refs:\n  ANTIGRAVITY_LOCAL_KEY: local-antigravity\n");
        fs.writeFileSync(CREDENTIALS_FILE, updatedCreds, "utf8");
      }
    }
  } catch (err) {
    console.warn("[dsh-antigravity] Failed to auto-configure settings:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Shared key-store helpers (fallback: reuse a superoc store if present)
// ---------------------------------------------------------------------------

function antigravityKeyEntries() {
  const store = loadStore(KEYS_FILE);
  const keys = (store.keys || []).filter((k) => k.provider === "antigravity");
  if (keys.length) return keys;

  // Fall back to the superoc store (same shape) so existing users keep working.
  const superocPath = path.join(os.homedir(), ".config/opencode/superoc-keys.json");
  if (fs.existsSync(superocPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(superocPath, "utf8"));
      return (s.keys || []).filter((k) => k.provider === "antigravity");
    } catch {}
  }
  return [];
}

function addKey(name, refreshToken, email, projectId) {
  const store = loadStore(KEYS_FILE);
  store.keys = store.keys || [];
  store.keys.push({
    id: crypto.randomUUID(),
    name,
    provider: "antigravity",
    key: refreshToken,
    email,
    projectId,
  });
  saveStore(KEYS_FILE, store);
}

/** Summarize quota buckets for the headline model families the plugin exposes. */
function summarizeQuota(buckets) {
  if (!Array.isArray(buckets)) return null;
  const wanted = [
    "gemini-3.7-flash-high",
    "gemini-3.7-flash-tiered",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ];
  const out = {};
  for (const b of buckets) {
    if (!wanted.includes(b.modelId)) continue;
    const remainingPct = Math.round((b.remainingFraction ?? 1) * 100);
    out[b.modelId] = {
      used_percent: 100 - remainingPct,
      remaining_percent: remainingPct,
      resets_at: b.resetTime || null,
    };
  }
  return Object.keys(out).length ? out : null;
}

/** Refresh access token for one key entry and fetch its live quota. */
async function fetchAccountStatus(keyEntry) {
  try {
    const auth = await refreshAccessToken(keyEntry.key);
    if (!auth?.accessToken) return { email: keyEntry.email, quota: null };
    const buckets = await fetchUserQuota(auth.accessToken);
    return { email: keyEntry.email, quota: summarizeQuota(buckets) };
  } catch {
    return { email: keyEntry.email, quota: null };
  }
}

// ---------------------------------------------------------------------------
// Gateway status endpoint — polled by the UI badge and available to anyone
// ---------------------------------------------------------------------------

function attachStatusEndpoint(server, port) {
  if (!server) return;
  server.on("request", async (req, res) => {
    const url = (req.url || "").split("?")[0];
    if (url !== "/status" && url !== "/v1/status") return;
    // Only answer if the gateway's own handler hasn't already responded.
    if (res.writableEnded || res.headersSent) return;

    const keys = antigravityKeyEntries();
    if (!keys.length) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: false, accounts: [] }));
      return;
    }

    const accounts = [];
    for (const k of keys) {
      const st = await fetchAccountStatus(k);
      accounts.push({ name: k.name, email: st.email, quota: st.quota });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      connected: true,
      active_account: accounts[0]?.email,
      total_accounts: accounts.length,
      accounts,
    }));
  });
}

// ---------------------------------------------------------------------------
// Automatic first-run OAuth (no chat command required)
// ---------------------------------------------------------------------------

function autoTriggerFirstTimeLogin() {
  if (antigravityKeyEntries().length > 0) return;

  console.log("\n==================================================================");
  console.log(" [dsh-antigravity] No Google Antigravity account found.");
  console.log(" Automatically launching browser for Google sign-in...");
  console.log("==================================================================\n");

  let linked = 0;
  const stopServer = startOAuthCallbackServer(async (code, state) => {
    try {
      const res = await exchangeCodeForTokens(code, state);
      linked += 1;
      addKey(`account-${linked}`, res.refreshToken, res.email, res.projectId);
      console.log(`\n[dsh-antigravity] Linked account ${linked}: ${res.email}`);
      return antigravityKeyEntries().length;
    } catch (err) {
      console.error(`[dsh-antigravity] Login error: ${err.message}`);
      return null;
    }
  }, 51121);

  const auth = createAuthorizationRequest("");
  openUrlInBrowser(auth.url);

  // Keep the server alive 10 minutes so the user can chain multiple accounts.
  setTimeout(() => {
    try { stopServer(); } catch {}
  }, 600000);
}

// ---------------------------------------------------------------------------
// apply() — plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const port = Number(config?.port || 8787);

  ensureProviderConfigured();

  const server = startGateway(port);
  attachStatusEndpoint(server, port);
  ctx.effect(() => {
    return () => {
      try { server.close(); } catch {}
    };
  }, "dsh-antigravity: gateway server");

  autoTriggerFirstTimeLogin();

  // Host-side RPC so the Client UI badge can fetch live status.
  ctx.effect(() => {
    harness.handle("antigravity/status", async () => {
      const keys = antigravityKeyEntries();
      if (!keys.length) return { connected: false, accounts: [] };
      const accounts = [];
      for (const k of keys) {
        const st = await fetchAccountStatus(k);
        accounts.push({ name: k.name, email: st.email, quota: st.quota });
      }
      return {
        connected: true,
        active_account: accounts[0]?.email,
        total_accounts: accounts.length,
        accounts,
      };
    });
    harness.handle("antigravity/login", async () => {
      // Manual add-another-account flow (browser popup), used by the badge button.
      const auth = createAuthorizationRequest("");
      openUrlInBrowser(auth.url);
      let stopServer = null;
      stopServer = startOAuthCallbackServer(async (code, state) => {
        const res = await exchangeCodeForTokens(code, state);
        addKey(`account-${antigravityKeyEntries().length + 1}`, res.refreshToken, res.email, res.projectId);
        return antigravityKeyEntries().length;
      }, 51121);
      setTimeout(() => { try { stopServer(); } catch {} }, 300000);
      return { started: true };
    });
  }, "dsh-antigravity: host RPC");

  // Register agent-visible tools (add account / check status).
  ctx.effect(() => {
    const tools = ctx.get("tools");
    if (!tools || typeof tools.register !== "function") return;

    tools.register({
      name: "antigravity_login",
      description: "Add an additional Google Antigravity account (OAuth) for quota pooling and multi-account rotation in DSH.",
      parameters: {
        type: "object",
        properties: {
          account_name: {
            type: "string",
            description: "A label for this account (e.g. 'work-account'). Defaults to 'account-N'.",
          },
        },
      },
      async execute({ account_name }) {
        const name = account_name || `account-${antigravityKeyEntries().length + 1}`;
        const auth = createAuthorizationRequest("");

        let resolvePromise, rejectPromise;
        const p = new Promise((res, rej) => { resolvePromise = res; rejectPromise = rej; });

        const stopServer = startOAuthCallbackServer(async (code, state) => {
          try {
            const res = await exchangeCodeForTokens(code, state ?? auth.state);
            addKey(name, res.refreshToken, res.email, res.projectId);
            resolvePromise({
              status: "success",
              account: name,
              email: res.email,
              projectId: res.projectId,
              message: `Account "${name}" (${res.email}) added successfully!`,
            });
          } catch (err) {
            rejectPromise(err);
          }
        }, 51121);

        openUrlInBrowser(auth.url);

        const timer = setTimeout(() => {
          stopServer();
          rejectPromise(new Error("Login timed out. No OAuth response received within 5 minutes."));
        }, 300000);

        try {
          return await p;
        } finally {
          clearTimeout(timer);
          stopServer();
        }
      },
    });

    tools.register({
      name: "antigravity_status",
      description: "Check connected Google Antigravity accounts and the percentage of quota used/remaining per model family.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const keys = antigravityKeyEntries();
        if (keys.length === 0) {
          return { status: "not_connected", message: "No Antigravity accounts connected yet.", accounts: [] };
        }
        const accounts = [];
        for (const k of keys) {
          const st = await fetchAccountStatus(k);
          accounts.push({ name: k.name, email: st.email, projectId: k.projectId, quota: st.quota });
        }
        return {
          total_accounts: keys.length,
          active_account: accounts[0]?.email,
          gateway_url: `http://127.0.0.1:${port}/v1`,
          accounts,
        };
      },
    });
  }, "dsh-antigravity: tools");
}
