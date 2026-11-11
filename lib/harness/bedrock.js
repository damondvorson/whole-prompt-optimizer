// bedrock.js — AWS Bedrock Converse / ConverseStream (any Bedrock model: Claude, Nova, Llama, Mistral…).
// Auth: AWS default chain / profile / static keys, or a Bedrock API key (bearer token).
// Structured output: outputConfig.textFormat json_schema (schema as a JSON string); models without it
// fall back to prompt-only + local parsing.
"use strict";

const { ProviderError, kindFromStatus } = require("./errors");
const { normalizeSchema, schemaInstruction } = require("../schema");
const { awsCredentials } = require("../storage/s3");

function clientConfig(conn) {
  const f = conn.fields || {};
  const base = { region: f.region || "us-east-1", maxAttempts: 1 };
  if (conn.type === "bedrock_key") return Object.assign(base, { token: { token: f.apiKey }, authSchemePreference: ["httpBearerAuth"] });
  const creds = awsCredentials(conn);
  return creds ? Object.assign(base, { credentials: creds }) : base;
}

function toError(err) {
  if (err instanceof ProviderError) return err;
  const status = err && err.$metadata && err.$metadata.httpStatusCode;
  const name = (err && err.name) || "";
  let kind = status ? kindFromStatus(status, err.message) : undefined;
  if (/Throttling|TooManyRequests|ServiceQuotaExceeded/.test(name)) kind = "rate";
  else if (/ServiceUnavailable|ModelNotReady/.test(name)) kind = "overloaded";
  else if (/ModelTimeout/.test(name)) kind = "timeout";
  else if (/AccessDenied|UnrecognizedClient|ExpiredToken|InvalidSignature|CredentialsProviderError/.test(name)) kind = "auth";
  else if (/ResourceNotFound/.test(name)) kind = "not_found";
  else if (/Validation/.test(name)) kind = /too long|too many tokens|context/i.test(err.message || "") ? "too_large" : "invalid";
  const e = new ProviderError(`${name}: ${(err && err.message) || err}`, { status, kind });
  e.cause = err;
  return e;
}

const IMG_FORMATS = { "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp" };
const VID_FORMATS = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv" };

function create(conn, cfg) {
  const rt = require("@aws-sdk/client-bedrock-runtime");
  let client = null;
  const getClient = () => (client || (client = new rt.BedrockRuntimeClient(clientConfig(conn))));
  const noSchema = new Set();

  function buildInput(req, nativeSchema) {
    let system = req.system || "";
    if (req.schema && !nativeSchema) system = [system, schemaInstruction(req.schema)].filter(Boolean).join("\n\n");
    const content = [];
    if (req.placement === "user" && system) content.push({ text: system });
    let hasDoc = false;
    for (const p of req.parts || []) {
      if (p.text !== undefined) content.push({ text: p.text });
      else if (IMG_FORMATS[p.mime]) content.push({ image: { format: IMG_FORMATS[p.mime], source: { bytes: p.bytes } } });
      else if (p.mime === "application/pdf") { content.push({ document: { format: "pdf", name: "document", source: { bytes: p.bytes } } }); hasDoc = true; }
      else if (VID_FORMATS[p.mime]) content.push({ video: { format: VID_FORMATS[p.mime], source: { bytes: p.bytes } } });
      else throw new ProviderError(`Bedrock cannot take ${p.mime} input`, { kind: "invalid" });
    }
    if (hasDoc && !content.some((c) => c.text !== undefined)) content.push({ text: "Analyze the attached document." });
    if (content.length === 0) content.push({ text: "(no input)" });
    const input = { modelId: req.model, messages: [{ role: "user", content }], inferenceConfig: {} };
    if (system && req.placement !== "user") input.system = [{ text: system }];
    if (req.maxOutputTokens) input.inferenceConfig.maxTokens = req.maxOutputTokens;
    if (req.temperature !== null && req.temperature !== undefined && !(req.extra && req.extra.omitTemperature)) input.inferenceConfig.temperature = req.temperature;
    if (req.schema && nativeSchema) {
      input.outputConfig = { textFormat: { type: "json_schema", structure: { jsonSchema: { schema: JSON.stringify(normalizeSchema(req.schema, "bedrock")), name: "output" } } } };
    }
    const extra = Object.assign({}, req.extra || {});
    delete extra.omitTemperature;
    Object.assign(input, extra);
    return input;
  }

  async function send(req, nativeSchema) {
    const input = buildInput(req, nativeSchema);
    const ctrl = req.timeoutMs ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), req.timeoutMs) : null;
    try {
      if (req.stream) {
        const res = await getClient().send(new rt.ConverseStreamCommand(input), ctrl ? { abortSignal: ctrl.signal } : {});
        let text = "", usage = {}, stop = null;
        for await (const ev of res.stream) {
          if (ev.contentBlockDelta && ev.contentBlockDelta.delta && typeof ev.contentBlockDelta.delta.text === "string") text += ev.contentBlockDelta.delta.text;
          if (ev.messageStop) stop = ev.messageStop.stopReason;
          if (ev.metadata && ev.metadata.usage) usage = ev.metadata.usage;
        }
        return { text, usage, stop };
      }
      const out = await getClient().send(new rt.ConverseCommand(input), ctrl ? { abortSignal: ctrl.signal } : {});
      const blocks = (out.output && out.output.message && out.output.message.content) || [];
      return { text: blocks.filter((b) => typeof b.text === "string").map((b) => b.text).join(""), usage: out.usage || {}, stop: out.stopReason };
    } finally { if (timer) clearTimeout(timer); }
  }

  return {
    name: conn.type,
    buildInput,
    async generate(req) {
      let native = !!req.schema && !noSchema.has(req.model);
      for (let guard = 0; guard < 3; guard++) {
        try {
          const r = await send(req, native);
          return {
            text: r.text, finish: r.stop ? String(r.stop) : null,
            usage: { inputTokens: r.usage.inputTokens || 0, outputTokens: r.usage.outputTokens || 0 },
            structured: req.schema ? (native ? "native" : "prompt") : "prompt", model: req.model,
          };
        } catch (err) {
          const e = toError(err);
          if (native && e.kind === "invalid" && /outputConfig|textFormat|json_schema|structured|schema/i.test(e.message)) { noSchema.add(req.model); native = false; continue; }
          if (e.kind === "invalid" && /temperature/i.test(e.message) && !(req.extra && req.extra.omitTemperature)) { req = Object.assign({}, req, { extra: Object.assign({}, req.extra, { omitTemperature: true }) }); continue; }
          throw e;
        }
      }
      throw new ProviderError("could not find a request shape this model accepts", { kind: "invalid" });
    },
    async listModels() {
      const bk = require("@aws-sdk/client-bedrock");
      const f = conn.fields || {};
      const ctl = new bk.BedrockClient(Object.assign({ region: f.region || "us-east-1" }, conn.type === "bedrock_key" ? { token: { token: f.apiKey }, authSchemePreference: ["httpBearerAuth"] } : awsCredentials(conn) ? { credentials: awsCredentials(conn) } : {}));
      const out = [];
      try {
        const prof = await ctl.send(new bk.ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED", maxResults: 1000 }));
        for (const p of prof.inferenceProfileSummaries || []) out.push({ id: p.inferenceProfileId, displayName: `${p.inferenceProfileName} (profile)`, source: "api" });
      } catch {}
      try {
        const fm = await ctl.send(new bk.ListFoundationModelsCommand({ byOutputModality: "TEXT" }));
        for (const m of fm.modelSummaries || []) {
          if (m.inferenceTypesSupported && !m.inferenceTypesSupported.includes("ON_DEMAND")) continue;
          out.push({ id: m.modelId, displayName: `${m.providerName} ${m.modelName}`, inputModalities: m.inputModalities, source: "api" });
        }
      } catch (err) { if (!out.length) throw toError(err); }
      return out;
    },
    capabilities(model) {
      const m = String(model || "");
      return {
        images: true, video: /nova/i.test(m), audio: false, pdf: true, text: true,
        jsonSchema: "native", schemaDialect: "bedrock", system: true,
        temperature: /anthropic\.claude-(opus-4-[78]|opus-5|sonnet-5|fable)/i.test(m) ? "omit" : "any",
      };
    },
  };
}

module.exports = { create, clientConfig };
