// openai.js — Chat Completions over fetch for OpenAI, Azure OpenAI (v1 endpoint) and any
// OpenAI-compatible server (OpenRouter, Groq, Together, Fireworks, Ollama, vLLM, LM Studio).
// Structured output ladder: json_schema strict → json_schema non-strict → json_object → prompt-only.
// Learned per model (unsupported temperature / max_tokens naming / schema mode) for this process;
// preflight records what it learned in the project config so runs never change behaviour mid-way.
"use strict";

const { ProviderError, kindFromStatus, retryAfterFrom } = require("./errors");
const { normalizeSchema, schemaInstruction } = require("../schema");

const LADDER = ["strict", "loose", "json_object", "prompt"];

function baseUrl(conn) {
  const f = conn.fields || {};
  if (conn.type === "openai") return "https://api.openai.com/v1";
  if (conn.type === "azure_openai") return `${String(f.endpoint || "").replace(/\/+$/, "").replace(/\/openai(\/v1)?$/, "")}/openai/v1`;
  return String(f.baseURL || "").replace(/\/+$/, "");
}

let _azureCred = null;
async function azureToken() {
  if (!_azureCred) {
    const { DefaultAzureCredential } = require("@azure/identity");
    _azureCred = new DefaultAzureCredential();
  }
  const t = await _azureCred.getToken("https://ai.azure.com/.default");
  return t.token;
}

async function authHeaders(conn) {
  const f = conn.fields || {};
  if (conn.type === "azure_openai") return f.apiKey ? { "api-key": f.apiKey } : { Authorization: `Bearer ${await azureToken()}` };
  const h = {};
  if (f.apiKey) h.Authorization = `Bearer ${f.apiKey}`;
  if (conn.type === "openai" && f.organization) h["OpenAI-Organization"] = f.organization;
  return h;
}

function isReasoningModel(model) { return /^(o\d|gpt-5|gpt-6)/i.test(String(model || "")); }

function contentParts(parts, conn) {
  const out = [];
  for (const p of parts || []) {
    if (p.text !== undefined) { out.push({ type: "text", text: p.text }); continue; }
    const b64 = p.bytes.toString("base64");
    if (p.mime.startsWith("image/")) out.push({ type: "image_url", image_url: { url: `data:${p.mime};base64,${b64}` } });
    else if (p.mime === "application/pdf") out.push({ type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${b64}` } });
    else if (p.mime.startsWith("audio/")) out.push({ type: "input_audio", input_audio: { data: b64, format: /mpeg|mp3/.test(p.mime) ? "mp3" : "wav" } });
    else throw new ProviderError(`${conn.type} cannot take ${p.mime} input — use frame grids for video`, { kind: "invalid" });
  }
  return out;
}

function create(conn, cfg) {
  const learned = { schema: new Map(), noTemperature: new Set(), tokensParam: new Map() };
  if (cfg && cfg.learned) {
    for (const [m, v] of Object.entries(cfg.learned.schema || {})) learned.schema.set(m, v);
    for (const m of cfg.learned.noTemperature || []) learned.noTemperature.add(m);
    for (const [m, v] of Object.entries(cfg.learned.tokensParam || {})) learned.tokensParam.set(m, v);
  }
  const dialect = conn.type === "azure_openai" ? "azure-strict" : "openai-strict";

  function buildBody(req, rung) {
    const model = req.model;
    let system = req.system || "";
    const userParts = contentParts(req.parts, conn);
    if (req.schema && rung === "prompt") system = [system, schemaInstruction(req.schema)].filter(Boolean).join("\n\n");
    if (req.schema && rung === "json_object" && !/json/i.test(system)) system = [system, "Respond with a JSON object."].filter(Boolean).join("\n\n");
    const messages = [];
    if (system && req.placement !== "user") messages.push({ role: "system", content: system });
    else if (system) userParts.unshift({ type: "text", text: system });
    const onlyText = userParts.every((p) => p.type === "text");
    messages.push({ role: "user", content: onlyText ? userParts.map((p) => p.text).join("\n\n") : userParts });
    const body = { model, messages };
    const noTemp = learned.noTemperature.has(model) || (conn.type !== "openai_compatible" && isReasoningModel(model) && !(req.extra && req.extra.reasoning_effort === "none"));
    if (req.temperature !== null && req.temperature !== undefined && !noTemp) body.temperature = req.temperature;
    if (req.maxOutputTokens) {
      const param = learned.tokensParam.get(model) || (conn.type === "openai_compatible" ? "max_tokens" : "max_completion_tokens");
      body[param] = req.maxOutputTokens;
    }
    if (req.schema && rung === "strict") body.response_format = { type: "json_schema", json_schema: { name: "output", strict: true, schema: normalizeSchema(req.schema, dialect) } };
    else if (req.schema && rung === "loose") body.response_format = { type: "json_schema", json_schema: { name: "output", strict: false, schema: normalizeSchema(req.schema, "loose") } };
    else if (req.schema && rung === "json_object") body.response_format = { type: "json_object" };
    if (conn.type === "openai_compatible" && /openrouter\.ai/.test(baseUrl(conn)) && req.schema && (rung === "strict" || rung === "loose")) body.provider = { require_parameters: true };
    if (req.stream) { body.stream = true; body.stream_options = { include_usage: true }; }
    if (req.extra && typeof req.extra === "object") Object.assign(body, req.extra);
    return body;
  }

  async function post(body, req) {
    const ctrl = new AbortController();
    const timer = req.timeoutMs ? setTimeout(() => ctrl.abort(), req.timeoutMs) : null;
    let res;
    try {
      res = await fetch(`${baseUrl(conn)}/chat/completions`, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, await authHeaders(conn), req.headers || {}),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (timer) clearTimeout(timer);
      throw new ProviderError(err.name === "AbortError" ? "request timed out" : `network error: ${err.message}`, { kind: err.name === "AbortError" ? "timeout" : "network" });
    }
    if (!res.ok) {
      if (timer) clearTimeout(timer);
      const text = await res.text().catch(() => "");
      let msg = text;
      try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.code)) || text; } catch {}
      throw new ProviderError(`HTTP ${res.status}: ${String(msg).slice(0, 800)}`, { status: res.status, kind: kindFromStatus(res.status, msg), retryAfterMs: retryAfterFrom(res.headers) });
    }
    try {
      if (!body.stream) return await res.json();
      // SSE: accumulate deltas
      let text = "", usage = null, finish = null, model = null;
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            model = j.model || model;
            const ch = j.choices && j.choices[0];
            if (ch && ch.delta && typeof ch.delta.content === "string") text += ch.delta.content;
            if (ch && ch.finish_reason) finish = ch.finish_reason;
            if (j.usage) usage = j.usage;
          } catch {}
        }
      }
      return { model, choices: [{ message: { content: text }, finish_reason: finish }], usage };
    } finally { if (timer) clearTimeout(timer); }
  }

  function parseResponse(j, rung) {
    const ch = (j.choices && j.choices[0]) || {};
    const msg = ch.message || {};
    let text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("") : "";
    if (!text && msg.refusal) text = "";
    const u = j.usage || {};
    return {
      text,
      finish: msg.refusal ? "refusal" : ch.finish_reason || null,
      usage: { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0, reasoningTokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0 },
      structured: rung === "strict" || rung === "loose" ? "native" : rung === "json_object" ? "json_object" : "prompt",
      model: j.model,
    };
  }

  return {
    name: conn.type,
    buildBody,
    async generate(req) {
      const model = req.model;
      let rung = req.schema ? (learned.schema.get(model) || "strict") : "none";
      for (let guard = 0; guard < 8; guard++) {
        const body = buildBody(req, rung);
        try {
          const j = await post(body, req);
          if (req.schema) learned.schema.set(model, rung);
          return parseResponse(j, rung);
        } catch (err) {
          const m = String(err.message || "");
          if (err.status === 400 || err.status === 422) {
            if (/temperature/i.test(m) && body.temperature !== undefined && !learned.noTemperature.has(model)) { learned.noTemperature.add(model); continue; }
            if (/max_tokens|max_completion_tokens/i.test(m)) {
              const cur = body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
              const next = cur === "max_tokens" ? "max_completion_tokens" : "max_tokens";
              if (learned.tokensParam.get(model) !== next) { learned.tokensParam.set(model, next); continue; }
            }
            if (req.schema && /response_format|json_schema|schema|strict|structured/i.test(m) && LADDER.indexOf(rung) < LADDER.length - 1) {
              rung = LADDER[LADDER.indexOf(rung) + 1];
              continue;
            }
          }
          throw err;
        }
      }
      throw new ProviderError("could not find a request shape this model accepts", { kind: "invalid" });
    },
    learnedState() {
      return { schema: Object.fromEntries(learned.schema), noTemperature: [...learned.noTemperature], tokensParam: Object.fromEntries(learned.tokensParam) };
    },
    async listModels() {
      if (conn.type === "azure_openai") {
        const deps = String((conn.fields || {}).deployments || "").split(",").map((s) => s.trim()).filter(Boolean);
        return deps.map((id) => ({ id, displayName: `${id} (deployment)`, source: "connection" }));
      }
      const res = await fetch(`${baseUrl(conn)}/models`, { headers: await authHeaders(conn) });
      if (!res.ok) throw new ProviderError(`HTTP ${res.status} listing models`, { status: res.status, kind: kindFromStatus(res.status, "") });
      const j = await res.json();
      const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
      return list.map((m) => ({ id: m.id || m.name, displayName: m.name || m.id, inputTokenLimit: m.context_length || m.context_window || null, source: "api" }))
        .filter((m) => m.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    },
    capabilities(model) {
      return {
        images: true, video: false, audio: conn.type !== "openai_compatible", pdf: conn.type !== "openai_compatible", text: true,
        jsonSchema: "native", schemaDialect: conn.type === "azure_openai" ? "azure-strict" : conn.type === "openai" ? "openai-strict" : "loose",
        system: true, temperature: isReasoningModel(model) && conn.type !== "openai_compatible" ? "omit" : "any",
      };
    },
  };
}

module.exports = { create, baseUrl };
