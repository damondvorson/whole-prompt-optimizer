// anthropic.js — Claude via the official @anthropic-ai/sdk (Messages API).
//   structured output: output_config.format = {type:"json_schema", schema}
//   images / PDFs: base64 content blocks; system prompt cached (cache_control) since every item in a
//   candidate's evaluation shares it
//   temperature: current models reject non-default sampling params → omitted (shown as provider default)
//   generator calls stream (messages.stream(...).finalMessage()) so 64k-token outputs don't time out
//   refusal fallback (server-side "fallbacks", default form) is on for the generator harness by default
//   and off for the candidate harness, because there it would score a different model's answers.
"use strict";

const { ProviderError, kindFromStatus, retryAfterFrom } = require("./errors");
const { normalizeSchema } = require("../schema");

// Models that still accept a custom temperature (older families); everything newer omits it.
const TEMPERATURE_OK = /claude-(haiku-4-5|sonnet-4-6|opus-4-6|opus-4-5|sonnet-4-5|opus-4-1|opus-4-0|sonnet-4-0|opus-4-2|sonnet-4-2|3)/i;
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;
const STATIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"];

function toError(err) {
  if (err instanceof ProviderError) return err;
  const status = err && err.status;
  let msg = (err && err.message) || String(err);
  const kind = status ? kindFromStatus(status, msg) : /timeout|timed out/i.test(msg) ? "timeout" : /connection|ECONN|fetch failed/i.test(msg) ? "network" : undefined;
  const e = new ProviderError(msg, { status, kind, retryAfterMs: retryAfterFrom(err && err.headers) });
  e.cause = err;
  return e;
}

function create(conn, cfg) {
  const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
  const clients = new Map();
  const client = (timeoutMs) => {
    const key = timeoutMs || 0;
    if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: conn.fields.apiKey, maxRetries: 0, ...(timeoutMs ? { timeout: timeoutMs } : {}) }));
    return clients.get(key);
  };
  const noTemp = new Set();

  function buildParams(req) {
    const content = [];
    if (req.placement === "user" && req.system) content.push({ type: "text", text: req.system });
    const text = [];
    for (const p of req.parts || []) {
      if (p.text !== undefined) { text.push({ type: "text", text: p.text }); continue; }
      const data = p.bytes.toString("base64");
      if (p.mime.startsWith("image/")) content.push({ type: "image", source: { type: "base64", media_type: p.mime, data } });
      else if (p.mime === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
      else throw new ProviderError(`Anthropic cannot take ${p.mime} input — use frame grids for video`, { kind: "invalid" });
    }
    content.push(...text); // documents/images before text
    if (content.length === 0) content.push({ type: "text", text: "(no input)" });
    const params = {
      model: req.model,
      max_tokens: req.maxOutputTokens || (req.stream ? 64000 : 16000),
      messages: [{ role: "user", content }],
    };
    if (req.system && req.placement !== "user") {
      params.system = cfg.promptCaching === false ? req.system : [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }];
    }
    if (req.temperature !== null && req.temperature !== undefined && TEMPERATURE_OK.test(req.model) && !noTemp.has(req.model)) params.temperature = req.temperature;
    const outputConfig = {};
    if (req.schema) outputConfig.format = { type: "json_schema", schema: normalizeSchema(req.schema, "anthropic") };
    const extra = Object.assign({}, req.extra || {});
    if (extra.effort) { outputConfig.effort = extra.effort; delete extra.effort; }
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
    // harness default (generator: on, candidate: off) unless the request's extra params override it
    const wantFallback = extra.refusalFallback !== undefined ? !!extra.refusalFallback : !!cfg.refusalFallback;
    const useFallback = wantFallback && FALLBACK_MODELS.test(req.model);
    delete extra.refusalFallback;
    Object.assign(params, extra);
    if (useFallback) { params.betas = ["server-side-fallback-2026-07-01"]; params.fallbacks = "default"; }
    return { params, beta: useFallback };
  }

  async function send(req) {
    const { params, beta } = buildParams(req);
    const api = beta ? client(req.timeoutMs).beta.messages : client(req.timeoutMs).messages;
    if (req.stream) return api.stream(params).finalMessage();
    return api.create(params);
  }

  return {
    name: "anthropic",
    buildParams,
    async generate(req) {
      let msg;
      for (let guard = 0; ; guard++) {
        try { msg = await send(req); break; } catch (err) {
          const e = toError(err);
          if (e.status === 400 && /temperature/i.test(e.message) && guard === 0 && !noTemp.has(req.model)) { noTemp.add(req.model); continue; }
          throw e;
        }
      }
      if (msg.stop_reason === "refusal") {
        return { text: "", finish: "refusal", usage: { inputTokens: (msg.usage && msg.usage.input_tokens) || 0, outputTokens: (msg.usage && msg.usage.output_tokens) || 0 }, structured: "native", model: msg.model, refusal: msg.stop_details || null };
      }
      const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      const u = msg.usage || {};
      return {
        text,
        finish: msg.stop_reason || null,
        usage: { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0, cachedInputTokens: u.cache_read_input_tokens || 0 },
        structured: req.schema ? "native" : "prompt",
        model: msg.model,
      };
    },
    async listModels() {
      const out = [];
      try {
        for await (const m of client(0).models.list()) {
          out.push({ id: m.id, displayName: m.display_name || m.id, inputTokenLimit: m.max_input_tokens || null, outputTokenLimit: m.max_tokens || null, capabilities: m.capabilities || null, source: "api" });
        }
      } catch (err) { throw toError(err); }
      return out.length ? out : STATIC_MODELS.map((id) => ({ id, displayName: id, source: "static" }));
    },
    capabilities(model) {
      return {
        images: true, video: false, audio: false, pdf: true, text: true,
        jsonSchema: "native", schemaDialect: "anthropic", system: true,
        temperature: TEMPERATURE_OK.test(model || "") ? "any" : "omit",
        refusalFallback: FALLBACK_MODELS.test(model || ""),
      };
    },
  };
}

module.exports = { create, TEMPERATURE_OK, FALLBACK_MODELS, STATIC_MODELS };
