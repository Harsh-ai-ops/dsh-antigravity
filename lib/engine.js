import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { refreshAntigravityToken } from "./oauth.js";
import { sanitizeSchema } from "./schema.js";

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

export function pickKey(store, model) {
  const now = Date.now();
  const keys = (store.keys || []).filter((k) => k.provider === "antigravity");
  const usable = keys.filter((k) => {
    const keyId = k.id || k.name;
    const globalRl = store.rateLimits?.[keyId] || 0;
    if (globalRl > now) return false;
    const modelRl = store.modelRateLimits?.[keyId]?.[model] || 0;
    if (modelRl > now) return false;
    return true;
  });
  return usable[0] || keys[0] || null;
}

export function markRateLimit(store, storePath, keyId, model) {
  const now = Date.now();
  if (model) {
    if (!store.modelRateLimits) store.modelRateLimits = {};
    if (!store.modelRateLimits[keyId]) store.modelRateLimits[keyId] = {};
    store.modelRateLimits[keyId][model] = now + 60000;
  } else {
    if (!store.rateLimits) store.rateLimits = {};
    store.rateLimits[keyId] = now + 60000;
  }
  saveStore(storePath, store);
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

  const refreshRes = await refreshAntigravityToken(refreshToken, projectId);
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
        const cleaned = sanitizeSchema(raw);
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
