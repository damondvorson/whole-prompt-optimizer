// http.js — custom HTTP harness: point the optimiser at your own pipeline.
// Contract mode (default): POST <url> {model, system, parts, response_schema, temperature, max_output_tokens}
//   parts: [{type:"text", text} | {type:"file", mime, name, data_b64}]  →  {text} | {json} | {output}
// Template mode: your own JSON body with {{system}}, {{parts}}, {{text}}, {{image_b64}}, {{image_mime}},
//   {{schema}}, {{temperature}}, {{max_output_tokens}}, {{model}}; the answer is read from responsePath.
"use strict";

const path = require("path");
const { ProviderError, kindFromStatus, retryAfterFrom } = require("./errors");
const { renderJsonTemplate, getPath } = require("../template");

function create(conn, cfg) {
  const f = conn.fields || {};
  let extraHeaders = {};
  try { extraHeaders = f.headers ? JSON.parse(f.headers) : {}; } catch {}
  const tpl = cfg.requestTemplate || null; // {body, responsePath, method}

  function buildBody(req) {
    const parts = (req.parts || []).map((p) => (p.text !== undefined
      ? { type: "text", text: p.text }
      : { type: "file", mime: p.mime, name: p.path ? path.basename(p.path) : "input", data_b64: p.bytes.toString("base64") }));
    if (!tpl || !tpl.body) {
      return { model: req.model || null, system: req.system || "", parts, response_schema: req.schema || null, temperature: req.temperature ?? null, max_output_tokens: req.maxOutputTokens || null };
    }
    const firstFile = parts.find((p) => p.type === "file");
    const tokens = {
      model: req.model || null, system: req.system || "", parts,
      text: parts.filter((p) => p.type === "text").map((p) => p.text).join("\n\n"),
      image_b64: firstFile ? firstFile.data_b64 : "", image_mime: firstFile ? firstFile.mime : "",
      schema: req.schema || null, temperature: req.temperature ?? null, max_output_tokens: req.maxOutputTokens || null,
    };
    return renderJsonTemplate(typeof tpl.body === "string" ? JSON.parse(tpl.body) : tpl.body, tokens);
  }

  return {
    name: "custom_http",
    buildBody,
    async generate(req) {
      const body = buildBody(req);
      const ctrl = new AbortController();
      const timer = req.timeoutMs ? setTimeout(() => ctrl.abort(), req.timeoutMs) : null;
      let res;
      try {
        res = await fetch(f.url, {
          method: (tpl && tpl.method) || "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, f.token ? { Authorization: `Bearer ${f.token}` } : {}, extraHeaders, req.headers || {}),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw new ProviderError(err.name === "AbortError" ? "request timed out" : `network error: ${err.message}`, { kind: err.name === "AbortError" ? "timeout" : "network" });
      } finally { if (timer) clearTimeout(timer); }
      const raw = await res.text();
      if (!res.ok) {
        let msg = raw;
        let retryable;
        try { const j = JSON.parse(raw); msg = (j.error && (j.error.message || j.error.type)) || raw; retryable = j.error && j.error.retryable; } catch {}
        const kind = retryable === true ? "server" : kindFromStatus(res.status, msg);
        throw new ProviderError(`HTTP ${res.status}: ${String(msg).slice(0, 800)}`, { status: res.status, kind, retryAfterMs: retryAfterFrom(res.headers) });
      }
      let j = null;
      try { j = JSON.parse(raw); } catch { return { text: raw, finish: null, usage: {}, structured: "prompt" }; }
      let out;
      if (tpl && tpl.responsePath) out = getPath(j, tpl.responsePath);
      else out = j.json !== undefined && j.json !== null ? j.json : j.text !== undefined ? j.text : j.output !== undefined ? j.output : j;
      const text = typeof out === "string" ? out : JSON.stringify(out);
      const u = (j && j.usage) || {};
      return { text, finish: (j && j.finish) || null, usage: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 }, structured: "native", model: (j && j.model) || req.model };
    },
    async listModels() {
      try {
        const base = String(f.url).replace(/\/generate\/?$/, "");
        const res = await fetch(`${base}/models`, { headers: Object.assign({}, f.token ? { Authorization: `Bearer ${f.token}` } : {}, extraHeaders) });
        if (!res.ok) return [];
        const j = await res.json();
        return (j.models || []).map((m) => ({ id: m.id, displayName: m.id, inputTokenLimit: m.context_tokens || null, source: "api" }));
      } catch { return []; }
    },
    capabilities() {
      return { images: true, video: true, audio: true, pdf: true, text: true, jsonSchema: "native", schemaDialect: "loose", system: true, temperature: "any" };
    },
  };
}

module.exports = { create };
