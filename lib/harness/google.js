// google.js — Gemini API (API key) and Vertex AI (ADC / service account / express key) via @google/genai.
// With the legacy preset the request object is the one the original engine sent:
//   {model, contents:[{role:"user", parts:[{inlineData:{data, mimeType}}]}],
//    config:{systemInstruction, temperature:0, responseMimeType:"application/json", responseSchema}}
// and the generator call is {model, contents:[{role:"user", parts:[{text}]}], config:{temperature, maxOutputTokens}}.
"use strict";

const { ProviderError, kindFromStatus } = require("./errors");

const STATIC_MODELS = [
  "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro",
  "gemini-3-flash-preview", "gemini-3-pro-preview", "gemini-3.1-pro-preview",
];

function clientOptions(conn, headers, timeoutMs) {
  const f = conn.fields || {};
  const httpOptions = {};
  if (headers && Object.keys(headers).length) httpOptions.headers = Object.assign({}, headers);
  if (timeoutMs) httpOptions.timeout = timeoutMs;
  const withHttp = (o) => (Object.keys(httpOptions).length ? Object.assign(o, { httpOptions }) : o);
  if (conn.type === "gemini") return withHttp({ apiKey: f.apiKey });
  let sa = null;
  if (f.serviceAccountJson) sa = JSON.parse(f.serviceAccountJson);
  if (f.apiKey && !sa && !f.project) return withHttp({ vertexai: true, apiKey: f.apiKey });
  const o = { vertexai: true, project: f.project || (sa && sa.project_id), location: f.location || "global" };
  if (!o.project) throw new ProviderError("Vertex AI needs a project ID (set it on the connection)", { kind: "auth" });
  if (sa) o.googleAuthOptions = { credentials: sa };
  return withHttp(o);
}

function toError(err) {
  if (err instanceof ProviderError) return err;
  const status = err && (err.status || err.code);
  const msg = (err && err.message) || String(err);
  const kind = typeof status === "number" ? kindFromStatus(status, msg) : undefined;
  const e = new ProviderError(msg, { status: typeof status === "number" ? status : undefined, kind });
  e.cause = err;
  return e;
}

function create(conn, cfg) {
  const { GoogleGenAI } = require("@google/genai");
  const clients = new Map();
  const client = (headers, timeoutMs) => {
    const key = JSON.stringify([headers || {}, timeoutMs || 0]);
    if (!clients.has(key)) clients.set(key, new GoogleGenAI(clientOptions(conn, headers, timeoutMs)));
    return clients.get(key);
  };

  function buildRequest(req) {
    const parts = [];
    if (req.placement === "user" && req.system) parts.push({ text: req.system });
    for (const p of req.parts || []) {
      if (p.text !== undefined) parts.push({ text: p.text });
      else parts.push({ inlineData: { data: p.bytes.toString("base64"), mimeType: p.mime } });
    }
    const config = {};
    if (req.system && req.placement !== "user") config.systemInstruction = req.system;
    if (req.temperature !== null && req.temperature !== undefined) config.temperature = req.temperature;
    if (req.maxOutputTokens) config.maxOutputTokens = req.maxOutputTokens;
    if (req.nativeSchema && req.schemaMode !== "json") {
      config.responseMimeType = "application/json";
      config.responseSchema = req.nativeSchema;
    } else if (req.schema) {
      config.responseMimeType = "application/json";
      config.responseJsonSchema = req.schema;
    }
    if (req.extra && typeof req.extra === "object") Object.assign(config, req.extra);
    return { model: req.model, contents: [{ role: "user", parts }], config };
  }

  return {
    name: conn.type,
    buildRequest,
    async generate(req) {
      const request = buildRequest(req);
      let response;
      try {
        response = await client(req.headers, req.timeoutMs).models.generateContent(request);
      } catch (err) { throw toError(err); }
      let text = "";
      try { text = response.text || ""; } catch {}
      const um = response.usageMetadata || {};
      const cand = response.candidates && response.candidates[0];
      return {
        text,
        finish: cand && cand.finishReason ? String(cand.finishReason).toLowerCase() : null,
        usage: { inputTokens: um.promptTokenCount || 0, outputTokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0), reasoningTokens: um.thoughtsTokenCount || 0 },
        structured: request.config.responseMimeType ? "native" : "prompt",
        model: response.modelVersion || req.model,
      };
    },
    async listModels() {
      const out = [];
      try {
        const pager = await client({}, 0).models.list(conn.type === "vertex" ? { config: { queryBase: true, pageSize: 100 } } : { config: { pageSize: 100 } });
        for await (const m of pager) {
          const id = String(m.name || "").replace(/^.*models\//, "");
          if (!id) continue;
          if (m.supportedActions && !m.supportedActions.includes("generateContent")) continue;
          if (!/gemini|gemma/i.test(id)) continue;
          out.push({ id, displayName: m.displayName || id, inputTokenLimit: m.inputTokenLimit || null, outputTokenLimit: m.outputTokenLimit || null, source: "api" });
          if (out.length > 300) break;
        }
      } catch (err) {
        if (!out.length) return STATIC_MODELS.map((id) => ({ id, displayName: id, source: "static", note: `live list failed: ${String(err.message || err).slice(0, 120)}` }));
      }
      return out.length ? out : STATIC_MODELS.map((id) => ({ id, displayName: id, source: "static" }));
    },
    capabilities(model) {
      return {
        images: true, video: true, audio: true, pdf: true, text: true,
        jsonSchema: "native", schemaDialect: "gemini", system: true, temperature: "any",
        maxInlineBytes: conn.type === "vertex" ? 500 * 1024 * 1024 : 100 * 1024 * 1024,
        maxOutputTokens: /pro|flash/i.test(model || "") ? 65536 : null,
      };
    },
  };
}

module.exports = { create, clientOptions, STATIC_MODELS };
