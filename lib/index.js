import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startGateway } from "./engine.js";
import { authorizeAntigravity, startLocalCallbackServer, exchangeAntigravity, loadKeys, saveKeys, addKey, openUrlInBrowser } from "./oauth.js";

export const name = "dsh-antigravity";

const SETTINGS_FILE = path.join(os.homedir(), ".dsh/settings.yaml");
const CREDENTIALS_FILE = path.join(os.homedir(), ".dsh/.credentials.yaml");

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

/**
 * If no Antigravity accounts are stored yet, automatically trigger browser login on startup.
 */
function autoTriggerFirstTimeLogin() {
  const existingKeys = loadKeys();
  if (existingKeys.length > 0) return;

  console.log("\n==================================================================");
  console.log(" [dsh-antigravity] No Google Antigravity account found.");
  console.log(" Automatically launching browser for Google sign-in...");
  console.log("==================================================================\n");

  const name = "primary";
  const auth = authorizeAntigravity("");

  let stopServer = null;
  stopServer = startLocalCallbackServer(async (code, state) => {
    try {
      const res = await exchangeAntigravity(code, state ?? auth.state);
      if (res.type === "success") {
        addKey(name, res.refresh, res.email, res.projectId);
        console.log("\n==================================================================");
        console.log(` [dsh-antigravity] Successfully logged in as ${res.email}!`);
        console.log(" Gemini 3.7 & Claude Antigravity models are now active in DSH.");
        console.log("==================================================================\n");
      } else {
        console.error(`[dsh-antigravity] Login failed: ${res.error}`);
      }
    } catch (err) {
      console.error(`[dsh-antigravity] Login error: ${err.message}`);
    } finally {
      if (stopServer) stopServer();
    }
  }, 51121);

  // Auto open the consent screen in user's default browser
  openUrlInBrowser(auth.url);

  // Timeout callback server after 10 minutes if user ignores
  setTimeout(() => {
    if (stopServer) {
      try { stopServer(); } catch {}
    }
  }, 600000);
}

export function apply(ctx, config) {
  const port = Number(config?.port || 8787);

  // 1. Auto-configure DSH settings on startup
  ensureProviderConfigured();

  // 2. Start translation engine (HTTP server on localhost:8787)
  const server = startGateway(port);
  ctx.effect(() => {
    return () => {
      try { server.close(); } catch {}
    };
  }, "dsh-antigravity: gateway server");

  // 3. Automatic zero-prompt first-time login
  autoTriggerFirstTimeLogin();

  // 4. Register tool for agents & users to add more accounts later or check status
  ctx.inject(["tools"], (hostCtx) => {
    const tools = hostCtx.get("tools");
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
        const keys = loadKeys();
        const name = account_name || `account-${keys.length + 1}`;
        const auth = authorizeAntigravity("");
        
        let resolvePromise, rejectPromise;
        const p = new Promise((res, rej) => {
          resolvePromise = res;
          rejectPromise = rej;
        });

        const stopServer = startLocalCallbackServer(async (code, state) => {
          try {
            const res = await exchangeAntigravity(code, state ?? auth.state);
            if (res.type !== "success") {
              rejectPromise(new Error("OAuth exchange failed: " + res.error));
              return;
            }
            addKey(name, res.refresh, res.email, res.projectId);
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
      description: "Check currently connected Google Antigravity accounts and status.",
      parameters: { type: "object", properties: {} },
      async execute() {
        const keys = loadKeys();
        return {
          connected_accounts: keys.map((k) => ({
            name: k.name,
            email: k.email,
            projectId: k.projectId,
          })),
          total: keys.length,
          gateway_url: `http://127.0.0.1:${port}/v1`,
        };
      },
    });
  });
}
