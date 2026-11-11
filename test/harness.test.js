"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const { Harness } = require("../lib/harness");
const { ProviderError, AttentionError, classify } = require("../lib/harness/errors");
const google = require("../lib/harness/google");
const openai = require("../lib/harness/openai");
const anthropic = require("../lib/harness/anthropic");
const bedrock = require("../lib/harness/bedrock");
const http = require("../lib/harness/http");
const legacy = require("../lib/presets/legacy");
const { renderItemPrompt } = require("../lib/template");
const { ApiLog, makeRedactor } = require("../lib/apilog");
const { tmpDir, LEGACY_DIR } = require("./helpers");

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

test("error classification", () => {
  assert.strictEqual(classify(new ProviderError("x", { status: 429 })), "rate");
  assert.strictEqual(classify(new ProviderError("x", { status: 529 })), "overloaded");
  assert.strictEqual(classify(new ProviderError("x", { status: 401 })), "auth");
  assert.strictEqual(classify(new ProviderError("prompt is too long: 300000 tokens > 200000", { status: 400 })), "too_large");
  assert.strictEqual(classify({ name: "ThrottlingException", message: "Rate exceeded" }), "rate");
  assert.strictEqual(classify({ message: "Could not load the default credentials" }), "auth");
  assert.strictEqual(classify({ message: "fetch failed" }), "network");
});

function fakeProvider(script) {
  let i = 0;
  return { generate: async () => { const s = script[Math.min(i++, script.length - 1)]; if (s instanceof Error) throw s; return { text: s, usage: { inputTokens: 1, outputTokens: 1 } }; } };
}

test("executor: transient errors retry, persistent errors raise attention, parse limit accepts flagged", async () => {
  const delays = [];
  const opts = (provider, policy) => ({ provider, sleep: async (ms) => { delays.push(ms); }, random: () => 0, policy });
  // transient then success
  let h = new Harness("target", { concurrency: 2 }, { type: "mock" }, opts(fakeProvider([new ProviderError("503", { status: 503 }), new ProviderError("429", { status: 429 }), "{\"b\":[]}"])));
  let r = await h.call({ parts: [] }, {});
  assert.strictEqual(r.text, "{\"b\":[]}");
  assert.deepStrictEqual(delays.slice(0, 2), [2000, 6000]); // original curves: non-rate 2^0*2000, rate 2^1*3000
  // persistent auth → attention after 3
  h = new Harness("target", {}, { type: "mock" }, opts(fakeProvider([new ProviderError("401", { status: 401 })]), { persistentErrorPolicy: "attention", persistentErrorLimit: 3 }));
  await assert.rejects(h.call({ parts: [] }, {}), (e) => e instanceof AttentionError && e.kind === "auth");
  // legacy policy: keeps retrying (stop the test after 12 attempts)
  let n = 0;
  h = new Harness("target", {}, { type: "mock" }, { provider: { generate: async () => { if (++n < 12) throw new ProviderError("401", { status: 401 }); return { text: "ok" }; } }, sleep: async () => {}, policy: { persistentErrorPolicy: "retry" } });
  r = await h.call({ parts: [] }, {});
  assert.strictEqual(n, 12);
  // validator never satisfied → accepted & flagged after the limit
  h = new Harness("target", {}, { type: "mock" }, { provider: fakeProvider(["{\"x\":1}"]), sleep: async () => {}, policy: { parseRetryLimit: 4 } });
  r = await h.call({ parts: [] }, { validate: () => "No b array" });
  assert.strictEqual(r.invalid, "No b array");
  // generator curve
  const gd = [];
  h = new Harness("generator", {}, { type: "mock" }, { provider: fakeProvider([new ProviderError("500", { status: 500 }), "<PROMPT>x</PROMPT>"]), sleep: async (ms) => gd.push(ms), random: () => 0 });
  await h.call({ parts: [{ text: "meta" }] }, {});
  assert.deepStrictEqual(gd, [5000]);
});

test("gemini legacy request = the original engine's request", () => {
  const p = google.create({ type: "vertex", fields: { project: "p", location: "global" } }, {});
  const native = { type: "OBJECT", properties: { b: { type: "ARRAY", description: "Array of integer indices whose value is equal to 1", items: { type: "INTEGER" }, minItems: 0, maxItems: 8 } }, required: ["b"] };
  const req = p.buildRequest({ model: "gemini-2.5-flash-lite", system: "SYS", parts: [{ bytes: PNG, mime: "image/png" }], nativeSchema: native, schema: { type: "object" }, temperature: 0, placement: "system" });
  assert.deepStrictEqual(req, {
    model: "gemini-2.5-flash-lite",
    contents: [{ role: "user", parts: [{ inlineData: { data: PNG.toString("base64"), mimeType: "image/png" } }] }],
    config: { systemInstruction: "SYS", temperature: 0, responseMimeType: "application/json", responseSchema: native },
  });
  const gen = p.buildRequest({ model: "gemini-3.1-pro-preview", system: null, parts: [{ text: "META" }], temperature: 1.0, maxOutputTokens: 65536 });
  assert.deepStrictEqual(gen, { model: "gemini-3.1-pro-preview", contents: [{ role: "user", parts: [{ text: "META" }] }], config: { temperature: 1.0, maxOutputTokens: 65536 } });
  assert.deepStrictEqual(google.clientOptions({ type: "vertex", fields: { project: "p", location: "global" } }, {}, 0), { vertexai: true, project: "p", location: "global" });
  assert.deepStrictEqual(google.clientOptions({ type: "vertex", fields: { project: "p", location: "global" } }, legacy.FLEX_HEADERS, 0).httpOptions, { headers: legacy.FLEX_HEADERS });
});

// V3: compare against real logged requests from the original health run (read-only), when present.
const ORIG_LOG = process.env.WPO_LEGACY_API_LOG || path.join(LEGACY_DIR, "wpo_health_api.jsonl");
const ORIG_GRIDS = path.join(LEGACY_DIR, "grids");
test("request equivalence vs the original run's API log (systemInstruction, schema, temperature, image bytes)", { skip: !fs.existsSync(ORIG_LOG) || !fs.existsSync(ORIG_GRIDS) }, async () => {
  const fd = fs.openSync(ORIG_LOG, "r");
  const buf = Buffer.alloc(6 * 1024 * 1024);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const lines = buf.slice(0, n).toString("utf8").split("\n").slice(0, -1);
  const recs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.type === "LITE_INFERENCE" && r.request && !r.error).slice(0, 12);
  assert.ok(recs.length >= 5);
  const p = google.create({ type: "vertex", fields: { project: "p" } }, {});
  const gridsRoot = ORIG_GRIDS;
  for (const r of recs) {
    const imgPath = r.request.contents[0].parts[0].inlineData.imagePath.replace(/^.*\/grids\//, gridsRoot + "/");
    const bytes = await sharp(imgPath).resize(840, 480, { fit: "fill" }).png().toBuffer();
    const metaPath = imgPath.replace(/\.png$/i, ".meta.json");
    let meta = { duration: 8, interval: 1.6 };
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
    // the logged systemInstruction is the prompt AFTER timing injection; rebuild it from the rule.
    const logged = r.request.config;
    const sys = renderItemPrompt(logged.systemInstruction, { rules: [{ find: legacy.LEGACY_TIMING_SENTENCE, replace: "{{timing_line}}" }], placeholders: false }, { timing_line: legacy.legacyTimingLine(meta) });
    const req = p.buildRequest({ model: r.request.model, system: sys, parts: [{ bytes, mime: "image/png" }], nativeSchema: logged.responseSchema, temperature: 0 });
    assert.deepStrictEqual(req.config, logged, r.imageId);
    assert.strictEqual(req.contents[0].parts[0].inlineData.data.length, r.request.contents[0].parts[0].inlineData.base64LengthChars, r.imageId);
  }
});

test("openai body: strict schema, reasoning model omits temperature, compatible uses max_tokens, ladder on 400", async () => {
  const p = openai.create({ type: "openai", fields: { apiKey: "sk-test-123456" } }, {});
  const schema = { type: "object", properties: { fall: { type: "boolean" }, note: { type: "string" } }, required: ["fall"] };
  let body = p.buildBody({ model: "gpt-4.1-mini", system: "S", parts: [{ text: "hi" }, { bytes: PNG, mime: "image/png" }], schema, temperature: 0, maxOutputTokens: 100 }, "strict");
  assert.strictEqual(body.response_format.type, "json_schema");
  assert.strictEqual(body.response_format.json_schema.strict, true);
  assert.deepStrictEqual(body.response_format.json_schema.schema.required.sort(), ["fall", "note"]);
  assert.deepStrictEqual(body.response_format.json_schema.schema.properties.note.type, ["string", "null"]);
  assert.strictEqual(body.response_format.json_schema.schema.additionalProperties, false);
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.max_completion_tokens, 100);
  assert.ok(body.messages[1].content[1].image_url.url.startsWith("data:image/png;base64,"));
  body = p.buildBody({ model: "gpt-5-mini", system: "S", parts: [{ text: "x" }], temperature: 0 }, "none");
  assert.strictEqual(body.temperature, undefined);
  const c = openai.create({ type: "openai_compatible", fields: { baseURL: "http://localhost:11434/v1" } }, {});
  body = c.buildBody({ model: "llava", system: "S", parts: [{ text: "x" }], maxOutputTokens: 50 }, "none");
  assert.strictEqual(body.max_tokens, 50);
  // ladder: strict rejected → loose accepted
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    seen.push(b.response_format && b.response_format.json_schema ? (b.response_format.json_schema.strict ? "strict" : "loose") : b.response_format ? b.response_format.type : "none");
    if (seen.length === 1) return new Response(JSON.stringify({ error: { message: "Invalid schema for response_format 'output'" } }), { status: 400 });
    return new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "{\"fall\":true}" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
  };
  try {
    const r = await c.generate({ model: "llava", system: "S", parts: [{ text: "x" }], schema });
    assert.deepStrictEqual(seen, ["strict", "loose"]);
    assert.strictEqual(r.text, "{\"fall\":true}");
    assert.strictEqual(r.usage.inputTokens, 5);
    assert.deepStrictEqual(c.learnedState().schema, { llava: "loose" });
  } finally { global.fetch = realFetch; }
});

test("anthropic params: output_config.format, cached system, temperature omitted on current models, fallback opt-in", () => {
  const p = anthropic.create({ type: "anthropic", fields: { apiKey: "sk-ant-test-123456" } }, {});
  const schema = { type: "object", properties: { fall: { type: "boolean" } }, required: ["fall"] };
  let { params, beta } = p.buildParams({ model: "claude-opus-5-5", system: "S", parts: [{ text: "q" }, { bytes: PNG, mime: "image/png" }], schema, temperature: 0 });
  assert.strictEqual(params.temperature, undefined);
  assert.deepStrictEqual(params.output_config.format.type, "json_schema");
  assert.strictEqual(params.output_config.format.schema.additionalProperties, false);
  assert.deepStrictEqual(params.system[0].cache_control, { type: "ephemeral" });
  assert.strictEqual(params.messages[0].content[0].type, "image"); // media before text
  assert.strictEqual(params.messages[0].content[1].type, "text");
  assert.strictEqual(beta, false);
  ({ params } = p.buildParams({ model: "claude-haiku-4-5", system: "S", parts: [{ text: "q" }], temperature: 0 }));
  assert.strictEqual(params.temperature, 0);
  ({ params, beta } = p.buildParams({ model: "claude-opus-5-5", system: null, parts: [{ text: "meta" }], stream: true, extra: { refusalFallback: true, effort: "high" } }));
  assert.strictEqual(beta, true);
  assert.strictEqual(params.fallbacks, "default");
  assert.deepStrictEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.strictEqual(params.output_config.effort, "high");
  assert.strictEqual(params.max_tokens, 64000);
  assert.strictEqual(params.refusalFallback, undefined);
});

test("bedrock input: converse shape, native json_schema as string, document gets a text block", () => {
  const p = bedrock.create({ type: "aws", fields: { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "secret123456" } }, {});
  const schema = { type: "object", properties: { fall: { type: "boolean" } }, required: ["fall"] };
  const input = p.buildInput({ model: "us.amazon.nova-pro-v1:0", system: "S", parts: [{ bytes: PNG, mime: "image/png" }, { bytes: Buffer.from("%PDF"), mime: "application/pdf" }], schema, temperature: 0, maxOutputTokens: 100 }, true);
  assert.deepStrictEqual(input.system, [{ text: "S" }]);
  assert.strictEqual(input.messages[0].content[0].image.format, "png");
  assert.ok(input.messages[0].content.some((c) => c.text));
  assert.strictEqual(typeof input.outputConfig.textFormat.structure.jsonSchema.schema, "string");
  assert.deepStrictEqual(input.inferenceConfig, { maxTokens: 100, temperature: 0 });
  assert.deepStrictEqual(bedrock.clientConfig({ type: "bedrock_key", fields: { apiKey: "k", region: "eu-west-1" } }), { region: "eu-west-1", maxAttempts: 1, token: { token: "k" }, authSchemePreference: ["httpBearerAuth"] });
});

test("custom http: contract body and template mode", () => {
  let p = http.create({ type: "custom_http", fields: { url: "http://x/generate" } }, {});
  let body = p.buildBody({ model: "m", system: "S", parts: [{ text: "t" }, { bytes: PNG, mime: "image/png", path: "/a/b.png" }], schema: { type: "object" }, temperature: 0 });
  assert.deepStrictEqual(Object.keys(body), ["model", "system", "parts", "response_schema", "temperature", "max_output_tokens"]);
  assert.strictEqual(body.parts[1].name, "b.png");
  p = http.create({ type: "custom_http", fields: { url: "http://x" } }, { requestTemplate: { body: { prompt: "{{system}}\n\n{{text}}", image: "{{image_b64}}", opts: { t: "{{temperature}}" } }, responsePath: "result.answer" } });
  body = p.buildBody({ system: "S", parts: [{ text: "t" }, { bytes: PNG, mime: "image/png" }], temperature: 0.5 });
  assert.deepStrictEqual(body, { prompt: "S\n\nt", image: PNG.toString("base64"), opts: { t: 0.5 } });
});

test("api log: compact prompts by hash, redaction, cursor paging", async () => {
  const dir = tmpDir();
  const log = new ApiLog(dir, "compact", makeRedactor(["sk-secret-abcdef"]));
  for (let i = 0; i < 30; i++) log.write({ type: i % 2 ? "A" : "B", i, request: { system: "SYSTEM PROMPT" }, error: i === 3 ? { message: "bad key sk-secret-abcdef" } : undefined });
  await log.flush();
  const tail = ApiLog.read(dir, { limit: 10 });
  assert.strictEqual(tail.records.length, 10);
  assert.strictEqual(tail.records[9].i, 29);
  assert.ok(tail.records[0].request.systemHash);
  const all = ApiLog.read(dir, { cursor: "1:0", limit: 100 });
  assert.strictEqual(all.records.length, 30);
  assert.ok(!JSON.stringify(all.records).includes("sk-secret-abcdef"));
  assert.strictEqual(ApiLog.prompt(dir, tail.records[0].request.systemHash), "SYSTEM PROMPT");
  log.write({ type: "A", i: 30 });
  await log.flush();
  assert.strictEqual(ApiLog.read(dir, { cursor: tail.cursor }).records.length, 1);
  assert.strictEqual(ApiLog.read(dir, { limit: 50, type: "B" }).records.length, 15);
});
