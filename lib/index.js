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

/** Hard dependency: the tool registry — the plugin waits for it on boot. */
const inject = ["tools"];

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
// Shared key-store helpers
// ---------------------------------------------------------------------------

/**
 * One-time upgrade path: if the user already linked Antigravity accounts with
 * superoc/opencode, migrate them into the plugin's own store so rotation keeps
 * working seamlessly. Keys are deduped by refresh token; emails are backfilled
 * lazily by fetchAccountStatus later. Runs at most once (only when the plugin
 * store has no antigravity keys but the superoc store does).
 */
function migrateSuperocStoreOnce() {
  try {
    const store = loadStore(KEYS_FILE);
    const existing = (store.keys || []).filter((k) => k.provider === "antigravity");
    if (existing.length > 0) return; // plugin store already populated

    const superocPath = path.join(os.homedir(), ".config/opencode/superoc-keys.json");
    if (!fs.existsSync(superocPath)) return;
    const s = JSON.parse(fs.readFileSync(superocPath, "utf8"));
    const legacy = (s.keys || []).filter((k) => k.provider === "antigravity");
    if (!legacy.length) return;

    console.log(`[dsh-antigravity] Migrating ${legacy.length} account(s) from the superoc store...`);
    store.keys = store.keys || [];
    for (const k of legacy) {
      if (store.keys.some((e) => e.key === k.key)) continue; // dedupe
      // also dedupe by email against keys already migrated in this pass
      const emailNorm = (k.email || "").trim().toLowerCase();
      if (emailNorm && store.keys.some((e) => (e.email || "").trim().toLowerCase() === emailNorm)) continue;
      store.keys.push({
        id: crypto.randomUUID(),
        name: k.email ? k.email.split("@")[0] : (k.name || `account-${store.keys.length + 1}`),
        provider: "antigravity",
        key: k.key,
        email: k.email || "",
        projectId: k.projectId || "rising-fact-p41fc",
      });
    }
    saveStore(KEYS_FILE, store);
    console.log(`[dsh-antigravity] Migration done — ${store.keys.length} account(s) now in rotation.`);
  } catch (err) {
    console.warn("[dsh-antigravity] superoc migration skipped:", err.message);
  }
}

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

  // Google mints a NEW refresh token on every consent, even for the same
  // account — so the refresh token can never identify a duplicate. Dedup by
  // email: re-linking an existing account refreshes its token in place
  // (keeps rotation order, no phantom count growth).
  const emailNorm = (email || "").trim().toLowerCase();
  const existing = store.keys.find(
    (k) => k.provider === "antigravity" && (k.email || "").trim().toLowerCase() === emailNorm && emailNorm,
  );
  if (existing) {
    existing.key = refreshToken;
    existing.projectId = projectId || existing.projectId;
    if (email) existing.email = email;
    saveStore(KEYS_FILE, store);
    return { added: false, name: existing.name };
  }

  store.keys.push({
    id: crypto.randomUUID(),
    name,
    provider: "antigravity",
    key: refreshToken,
    email,
    projectId,
  });
  saveStore(KEYS_FILE, store);
  return { added: true, name };
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
    if (!auth?.accessToken) return { email: keyEntry.email || null, quota: null };
    const buckets = await fetchUserQuota(auth.accessToken);
    let email = keyEntry.email || null;
    // Legacy stores (e.g. superoc) have no email — look it up once and persist.
    if (!email) {
      try {
        const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
          headers: { Authorization: `Bearer ${auth.accessToken}` },
          signal: AbortSignal.timeout(8000),
        });
        if (userRes.ok) email = (await userRes.json()).email || null;
      } catch {}
      if (email) {
        try {
          const store = loadStore(KEYS_FILE);
          const entry = (store.keys || []).find((k) => k.key === keyEntry.key);
          if (entry) {
            entry.email = email;
            saveStore(KEYS_FILE, store);
          }
        } catch {}
      }
    }
    return { email, quota: summarizeQuota(buckets) };
  } catch {
    return { email: keyEntry.email || null, quota: null };
  }
}

/** Build the status payload shared by the /status HTTP endpoint and tools. */
async function buildStatusPayload() {
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
}

// ---------------------------------------------------------------------------
// Gateway status endpoint — served by the plugin's own HTTP server (port from
// config), read directly by the UI badge. No host RPC: bundle plugins don't
// have the dynamic-plugin `harness.handle` builtin.
// ---------------------------------------------------------------------------

function attachStatusEndpoint(server) {
  if (!server || typeof server.setStatusHandler !== "function") return () => {};
  server.setStatusHandler(async (req, res) => {
    // CORS so the web-app badge (different origin/port) can read this.
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(await buildStatusPayload()));
  });
  return () => {
    try { server.setStatusHandler(null); } catch {}
  };
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
      const result = addKey(`account-${linked + 1}`, res.refreshToken, res.email, res.projectId);
      if (result.added) linked += 1;
      const total = antigravityKeyEntries().length;
      console.log(`\n[dsh-antigravity] ${result.added ? "Linked" : "Re-linked (token refreshed)"}: ${res.email} — ${total} account(s) in rotation`);
      return total;
    } catch (err) {
      console.error(`[dsh-antigravity] Login error: ${err.message}`);
      return null;
    }
  }, 51121);

  const auth = createAuthorizationRequest("");
  console.log(`[dsh-antigravity] Sign-in URL (open manually if no browser appeared): ${auth.url}`);
  openUrlInBrowser(auth.url);

  // Keep the server alive 10 minutes so the user can chain multiple accounts.
  const timer = setTimeout(() => {
    try { stopServer(); } catch {}
  }, 600000);
  if (typeof timer.unref === "function") timer.unref();
}

// ---------------------------------------------------------------------------
// apply() — plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const port = Number(config?.port || 8787);

  ensureProviderConfigured();
  migrateSuperocStoreOnce();

  // The plugin's hard dependency is the tool registry; the gateway itself is
  // best-effort — a port conflict (a standalone gateway, a second profile)
  // must degrade to a warning, never kill the host boot.
  let server;
  let detachStatus = () => {};
  let loginTimer = null;
  try {
    server = startGateway(port);
  } catch (err) {
    console.warn(`[dsh-antigravity] Gateway did not start on port ${port}: ${err.message}`);
    server = null;
  }

  if (server) {
    // listen() errors arrive as async 'error' events (EADDRINUSE etc.).
    server.on("error", (err) => {
      console.warn(`[dsh-antigravity] Gateway stopped: ${err.message}`);
      try { server.close(); } catch {}
      try { detachStatus(); } catch {}
      server = null;
    });
    detachStatus = attachStatusEndpoint(server);
  }

  ctx.effect(() => {
    return () => {
      detachStatus();
      try { server?.close(); } catch {}
      if (loginTimer) clearTimeout(loginTimer);
    };
  }, "dsh-antigravity: gateway server");

  autoTriggerFirstTimeLogin();

  // Agent-visible tools, shaped for the real ToolRuntime contract:
  //   register(definition) requires output: { schema, render } and an
  //   author-DSL parameters spec (objects need explicit additionalProperties).
  // ------------------------------------------------------------------

  ctx.tools.register({
    name: "antigravity_login",
    description: "Add an additional Google Antigravity account (OAuth) for quota pooling and multi-account rotation in DSH.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        account_name: {
          type: "string",
          description: "A label for this account (e.g. 'work-account'). Defaults to 'account-N'.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          account: { type: "string" },
          email: { type: "string" },
          message: { type: "string" },
        },
        required: ["status", "email", "message"],
      },
      render(_args, value) {
        return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
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
          const result = addKey(name, res.refreshToken, res.email, res.projectId);
          const total = antigravityKeyEntries().length;
          resolvePromise({
            status: "success",
            account: result.name,
            email: res.email,
            message: result.added
              ? `Account "${result.name}" (${res.email}) added — ${total} account(s) in rotation.`
              : `Account (${res.email}) re-linked: token refreshed, no duplicate created — ${total} account(s) in rotation.`,
          });
        } catch (err) {
          rejectPromise(err);
        }
      }, 51121);

      openUrlInBrowser(auth.url);
      // Always surface the URL: if any machine's auto-open fails, the agent
      // (and the user via the tool result) can still complete the flow by
      // pasting it into any browser.
      console.log(`[dsh-antigravity] Login URL for "${name}" (open manually if no browser appeared): ${auth.url}`);

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

  ctx.tools.register({
    name: "antigravity_status",
    description: "Check connected Google Antigravity accounts and the percentage of quota used/remaining per model family.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          message: { type: "string" },
          gateway_url: { type: "string" },
          total_accounts: { type: "integer" },
          active_account: { type: "string" },
          accounts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                email: { type: "string" },
                quota: {
                  type: "object",
                  additionalProperties: true,
                },
              },
            },
          },
        },
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute() {
      const keys = antigravityKeyEntries();
      if (keys.length === 0) {
        return { status: "not_connected", message: "No Antigravity accounts connected yet.", accounts: [] };
      }
      const accounts = [];
      for (const k of keys) {
        const st = await fetchAccountStatus(k);
        accounts.push({ name: k.name, email: st.email, quota: st.quota });
      }
      return {
        total_accounts: keys.length,
        active_account: accounts[0]?.email,
        gateway_url: `http://127.0.0.1:${port}/v1`,
        accounts,
      };
    },
  });
}

export { inject };
export default { name, inject, apply };
