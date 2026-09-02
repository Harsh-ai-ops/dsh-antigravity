import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { refreshAccessToken, loadCodeAssist, onboardUser } from "./oauth.js";
import { sanitizeToolParameters } from "./schema.js";

const ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

export const MODEL_ALIASES = {
  "gemini-3.7-flash": "gemini-3.7-flash-tiered",
  "gemini-3.7-flash-high": "gemini-3.7-flash-high",
  "gemini-3.7-flash-low": "gemini-3.7-flash-low",
  "gemini-3.7-flash-medium": "gemini-3.7-flash-medium",
  "gemini-3.7-flash-tiered": "gemini-3.7-flash-tiered",
  "gemini-3.6-flash-high": "gemini-3.6-flash-high",
  "gemini-3.6-flash-low": "gemini-3.6-flash-low",
  "gemini-3.6-flash-medium": "gemini-3.6-flash-medium",
  "gemini-3.6-flash-tiered": "gemini-3.6-flash-tiered",
  "gemini-pro-agent": "gemini-pro-agent",
  "gemini-3.1-pro-low": "gemini-3.1-pro-low",
  "gemini-3-flash-agent": "gemini-3-flash-agent",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium": "gpt-oss-120b-medium",
};

export const BRIDGE_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
]);

export function isBridgeModel(model) {
  return BRIDGE_MODELS.has(model);
}

export function getDefaultKeyStorePath() {
  const dshKeys = path.join(os.homedir(), ".dsh/antigravity-keys.json");
  const superocKeys = path.join(os.homedir(), ".config/opencode/superoc-keys.json");
  if (fs.existsSync(dshKeys)) return dshKeys;
  if (fs.existsSync(superocKeys)) return superocKeys;
  return dshKeys;
}

export function loadStore(storePath) {
  try {
    if (fs.existsSync(storePath)) {
      return JSON.parse(fs.readFileSync(storePath, "utf8"));
    }
  } catch {}
  return { version: 1, keys: [], rateLimits: {}, modelRateLimits: {} };
}

export function saveStore(storePath, store) {
  try {
    const dir = path.dirname(storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n");
  } catch (err) {
    console.error("[dsh-antigravity] Failed to save store:", err);
  }
}

// Round-robin: each request starts from the next account in the pool, so all
// accounts drain evenly instead of account 1 eating 100% of traffic until it
// 429s. Persists in memory for the process lifetime; index resets on restart,
// which only mildly skews fairness — never correctness.
let rotationOffset = 0;

export function pickKey(store, model, advance = false) {
  const now = Date.now();
  const keys = (store.keys || []).filter((k) => k.provider === "antigravity");
  if (!keys.length) return null;
  if (advance) rotationOffset += 1;
  const start = rotationOffset % keys.length;
  const ordered = keys.slice(start).concat(keys.slice(0, start));
  const isUsable = (k) => {
    const keyId = k.id || k.name;
    if ((store.rateLimits?.[keyId] || 0) > now) return false;
    const perModel = store.modelRateLimits?.[keyId];
    if (perModel) {
      // "license" is a sentinel: a 403 SUBSCRIPTION_REQUIRED quarantine that
      // blocks the account for EVERY model, not just one.
      if ((perModel.license || 0) > now) return false;
      if ((perModel[model] || 0) > now) return false;
    }
    return true;
  };
  const usable = ordered.filter(isUsable);
  return usable[0] || keys[0] || null;
}

export function markRateLimit(store, storePath, keyId, model, durationMs = 60000) {
  const until = Date.now() + durationMs;
  if (model) {
    if (!store.modelRateLimits) store.modelRateLimits = {};
    if (!store.modelRateLimits[keyId]) store.modelRateLimits[keyId] = {};
    // never shorten an existing cooldown
    if ((store.modelRateLimits[keyId][model] || 0) < until) {
      store.modelRateLimits[keyId][model] = until;
      saveStore(storePath, store);
    }
  } else {
    if (!store.rateLimits) store.rateLimits = {};
    if ((store.rateLimits[keyId] || 0) < until) {
      store.rateLimits[keyId] = until;
      saveStore(storePath, store);
    }
  }
}

export async function getValidAccessToken(keyEntry, store, storePath) {
  const now = Date.now();
  if (keyEntry.accessToken && keyEntry.expiresAt && keyEntry.expiresAt > now + 60000) {
    return {
      accessToken: keyEntry.accessToken,
      projectId: keyEntry.projectId || "rising-fact-p41fc",
    };
  }

  const rawKey = keyEntry.key || "";
  const parts = rawKey.split("|");
  const refreshToken = parts[0];
  const projectId = parts[1] || keyEntry.projectId || "rising-fact-p41fc";

  const refreshRes = await refreshAccessToken(`${refreshToken}|${projectId}`);
  if (!refreshRes) {
    throw new Error(`Failed to refresh Antigravity token for ${keyEntry.name || keyEntry.id}`);
  }

  keyEntry.accessToken = refreshRes.accessToken;
  keyEntry.expiresAt = refreshRes.expiresAt;
  keyEntry.projectId = refreshRes.projectId;
  saveStore(storePath, store);

  return {
    accessToken: refreshRes.accessToken,
    projectId: refreshRes.projectId,
  };
}

export function openaiToGemini(chatBody) {
  const contents = [];
  const toolCallNameById = new Map();

  for (const m of chatBody.messages || []) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      const parts = [];
      if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "text") parts.push({ text: c.text });
          if (c.type === "image_url" && c.image_url?.url) {
            const u = c.image_url.url;
            const match = u.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
          }
        }
      }
      contents.push({ role: "user", parts });
      continue;
    }

    if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {}
          toolCallNameById.set(tc.id, tc.function.name);
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
      }
      contents.push({ role: "model", parts });
      continue;
    }

    if (m.role === "tool") {
      const name = toolCallNameById.get(m.tool_call_id) || m.name || "tool_result";
      let responseObj = { result: m.content };
      try {
        const parsed = JSON.parse(m.content);
        if (typeof parsed === "object" && parsed !== null) responseObj = parsed;
      } catch {}
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: responseObj } }],
      });
    }
  }

  return { contents };
}

export function buildGeminiBody(chatBody, model, key) {
  const { contents } = openaiToGemini(chatBody);
  const sysText = (chatBody.messages || [])
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n\n");

  const sessionId = crypto.randomUUID();
  const request = {
    contents,
    sessionId,
    labels: { delphi_session_id: sessionId, antigravity_log_source: "extension" },
  };

  if (sysText) {
    request.systemInstruction = { parts: [{ text: sysText }] };
  }

  request.generationConfig = isBridgeModel(model)
    ? { maxOutputTokens: 32000 }
    : { maxOutputTokens: 65536 };

  if (Array.isArray(chatBody.tools) && chatBody.tools.length) {
    const decls = chatBody.tools
      .filter((t) => t?.type === "function" && t.function)
      .map((t) => {
        const f = t.function;
        const raw = f.parameters || { type: "object", properties: {} };
        const cleaned = sanitizeToolParameters(raw);
        return { name: f.name, description: f.description || "", parameters: cleaned };
      });
    if (decls.length) {
      request.tools = [{ functionDeclarations: decls }];
    }
  }

  const rawKey = key.key || "";
  const projectId = rawKey.split("|")[1] || key.projectId || "rising-fact-p41fc";

  return {
    project: projectId,
    model,
    request,
    requestType: "agent",
    userAgent: "antigravity",
    requestId: crypto.randomUUID(),
  };
}

export async function callAntigravity(model, auth, geminiBody) {
  const url = `${ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "User-Agent": "antigravity/hub/2.8.0 (aidev_client; os_type=windows; arch=x64; cl=963137146)",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: "WINDOWS",
      pluginType: "GEMINI",
    }),
  };

  return await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(geminiBody),
    signal: AbortSignal.timeout(180000),
  });
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

export async function geminiStreamToOpenAI(geminiRes, res, model) {
  const id = "chatcmpl-" + crypto.randomUUID();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  sseWrite(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  let toolIdx = 0;
  let buffer = "";
  const reader = geminiRes.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;

          let ev;
          try {
            ev = JSON.parse(payload);
          } catch {
            continue;
          }

          const resp = ev.response || ev;
          const cand = resp.candidates?.[0];
          if (!cand) continue;

          for (const part of cand.content?.parts || []) {
            if (typeof part.text === "string" && part.text) {
              sseWrite(res, {
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
              });
            }
            if (part.functionCall) {
              sseWrite(res, {
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: toolIdx++,
                          id: "call-" + crypto.randomUUID(),
                          type: "function",
                          function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args || {}),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[dsh-antigravity] Stream reading error:", err);
  } finally {
    sseWrite(res, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Gateway HTTP server (OpenAI-compatible front, Antigravity back)
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Aggregate a non-stream upstream (JSON array, JSON object, or SSE body). */
function aggregateUpstream(text) {
  let outText = "";
  const toolCalls = [];
  const consumeChunk = (chunk) => {
    const cand = chunk.response?.candidates?.[0] ?? chunk.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === "string") outText += part.text;
      if (part.functionCall) toolCalls.push(part.functionCall);
    }
  };
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      for (const chunk of JSON.parse(trimmed)) consumeChunk(chunk);
    } catch {}
  } else if (trimmed.startsWith("{")) {
    try { consumeChunk(JSON.parse(trimmed)); } catch {}
  } else {
    for (const line of trimmed.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try { consumeChunk(JSON.parse(payload)); } catch {}
    }
  }
  return { outText, toolCalls };
}

export function startGateway(port = 8787) {
  const storePath = getDefaultKeyStorePath();

  // Optional status hook: set by the plugin before listen (see attachStatusEndpoint).
  // Served inside the main handler so it wins over the 404 fallthrough.
  let statusHandler = null;

  const server = http.createServer((req, res) => {
    const url = (req.url || "").split("?")[0];

    if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
      const models = Object.keys(MODEL_ALIASES).map((id) => ({
        id,
        object: "model",
        owned_by: "antigravity",
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }

    if (req.method === "GET" && (url === "/status" || url === "/v1/status")) {
      if (statusHandler) {
        statusHandler(req, res).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "status failed" } }));
          }
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ connected: false, accounts: [], note: "status not wired" }));
      return;
    }

    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      handleChat(req, res).catch((e) => {
        try {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: e.message } }));
        } catch {}
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  // CORS preflight for the web badge (served cross-origin from the DSH web app port).
  server.on("checkContinue", (req, res) => {
    if ((req.url || "").split("?")[0] === "/status") {
      res.writeContinue();
      server.emit("request", req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  /** Attach the status handler (used by the plugin host entry). */
  server.setStatusHandler = (fn) => { statusHandler = fn; };

  async function handleChat(req, res) {
    const chatBody = JSON.parse(await readBody(req));
    const model = MODEL_ALIASES[chatBody.model] ?? chatBody.model;
    const stream = chatBody.stream === true;

    const store = loadStore(storePath);
    let attempts = (store.keys || []).filter((k) => k.provider === "antigravity").length;
    let lastErr = null;

    let firstPick = true;
    while (attempts-- > 0) {
      // Advance the round-robin on the FIRST pick of each request so
      // consecutive requests land on consecutive accounts; failover picks
      // inside the loop then walk the pool without advancing again.
      const key = pickKey(store, model, firstPick);
      firstPick = false;
      if (!key) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "all antigravity keys rate limited or cooling down" } }));
        return;
      }

      const auth = await getValidAccessToken(key, store, storePath);
      const geminiBody = buildGeminiBody(chatBody, model, key);

      let upstream;
      try {
        upstream = await callAntigravity(model, auth, geminiBody);
      } catch (e) {
        lastErr = e;
        markRateLimit(store, storePath, key.id || key.name, null);
        continue;
      }
      if (upstream.status === 429) {
        markRateLimit(store, storePath, key.id || key.name, model);
        try { await upstream.arrayBuffer(); } catch {}
        continue;
      }
      if (upstream.status === 400 || upstream.status === 404) {
        const errText = await upstream.text();
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(errText);
        return;
      }
      if (upstream.status === 403) {
        // 403 SUBSCRIPTION_REQUIRED = the account is registered but its free
        // Standard-tier license was never activated — the IDE does this via
        // loadCodeAssist + onboardUser on first login. Our OAuth flow now
        // does both at link time; this path self-heals accounts linked
        // before that fix (or where activation hadn't propagated yet):
        // re-register + re-onboard once, retry the request, only quarantine
        // if it STILL 403s.
        const errText = await upstream.text();
        const licenseIssue = /SUBSCRIPTION_REQUIRED|valid license/i.test(errText);
        if (licenseIssue && !key.__registered) {
          key.__registered = true;
          try {
            const regProject = await loadCodeAssist(auth.accessToken);
            const onboarded = await onboardUser(auth.accessToken);
            if (regProject && onboarded) {
              console.log(`[dsh-antigravity] Re-registered + re-onboarded ${key.email || key.id || key.name} (project: ${regProject}) — retrying`);
              if (regProject !== key.projectId) {
                key.projectId = regProject;
                saveStore(storePath, store);
              }
              upstream = await callAntigravity(model, auth, buildGeminiBody(chatBody, model, key));
            }
          } catch {}
        }
        if (upstream.status === 403) {
          const license403 = /SUBSCRIPTION_REQUIRED|valid license/i.test(errText);
          markRateLimit(store, storePath, key.id || key.name, license403 ? "license" : model, license403 ? 3600000 : 60000);
          if (license403) {
            console.warn(`[dsh-antigravity] Account ${key.email || key.id || key.name} still 403 after re-onboarding — quarantined 1h, failing over`);
            continue;
          }
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(errText);
          return;
        }
      }
      if (stream) {
        geminiStreamToOpenAI(upstream, res, model);
        return;
      }

      const text = await upstream.text();
      const { outText, toolCalls } = aggregateUpstream(text);
      const message = { role: "assistant", content: outText || null };
      if (toolCalls.length) {
        message.tool_calls = toolCalls.map((fc) => ({
          id: "call-" + crypto.randomUUID(),
          type: "function",
          function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
        }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-" + crypto.randomUUID(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      );
      return;
    }
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "exhausted: " + (lastErr?.message ?? "all keys rate limited") } }));
  }

  // Surface listen failures to the caller instead of crashing boot with an
  // unhandled 'error' event (the caller attaches its own handler).
  server.on("error", (err) => {
    console.warn(`[dsh-antigravity] Gateway port ${port} unavailable: ${err.message}`);
  });
  server.listen(port, "127.0.0.1");
  return server;
}
