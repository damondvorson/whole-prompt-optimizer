// harness/index.js — one executor for both harnesses (candidate/target and generator).
// Concurrency, retry/backoff and logging follow the original engine (callLiteInference 287–359,
// callGeminiPro 362–420): the semaphore is released before the response is validated; transient
// failures retry forever with the original backoff curves. Additions: persistent errors (auth, bad
// request, …) can raise an AttentionError after N attempts instead of retrying silently forever, and
// a response that never satisfies the validator can be accepted (flagged) after N attempts.
"use strict";

const { AttentionError, ParseRetry, TRANSIENT, classify, legacyRateOrAuth } = require("./errors");

class Semaphore {
  constructor(max) { this.max = max; this.count = 0; this.queue = []; }
  acquire() { return this.count < this.max ? (this.count++, Promise.resolve()) : new Promise((r) => this.queue.push(r)); }
  release() { this.queue.length > 0 ? this.queue.shift()() : this.count--; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const PROVIDERS = {
  gemini: () => require("./google"),
  vertex: () => require("./google"),
  openai: () => require("./openai"),
  azure_openai: () => require("./openai"),
  openai_compatible: () => require("./openai"),
  anthropic: () => require("./anthropic"),
  aws: () => require("./bedrock"),
  bedrock_key: () => require("./bedrock"),
  custom_http: () => require("./http"),
  mock: () => require("./mock"),
};

function createProvider(connection, cfg) {
  if (!connection) throw new Error("No connection selected");
  const mod = PROVIDERS[connection.type];
  if (!mod) throw new Error(`Connection type ${connection.type} cannot run a model`);
  return mod().create(connection, cfg || {});
}

class Harness {
  // role: "target" | "generator"; cfg: harness config; connection: full connection (with secrets)
  // opts: { apiLog, onEvent(evt), stepRef: () => step, policy: {persistentErrorPolicy, persistentErrorLimit, parseRetryLimit} }
  constructor(role, cfg, connection, opts = {}) {
    this.role = role;
    this.cfg = cfg;
    this.connection = connection;
    this.provider = opts.provider || createProvider(connection, cfg);
    this.sem = new Semaphore(cfg.concurrency || (role === "target" ? 300 : 100));
    this.apiLog = opts.apiLog || null;
    this.onEvent = opts.onEvent || (() => {});
    this.stepRef = opts.stepRef || (() => null);
    this.policy = Object.assign({ persistentErrorPolicy: "attention", persistentErrorLimit: 8, parseRetryLimit: 8 }, opts.policy || {});
    this.sleep = opts.sleep || sleep;
    this.random = opts.random || Math.random;
    this.stats = { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, lastError: null };
  }

  delayFor(err, attempt) {
    const rateOrAuth = legacyRateOrAuth(err) || ["rate", "auth", "quota"].includes(classify(err));
    let d;
    if (this.role === "target") {
      d = rateOrAuth
        ? Math.min(60000, (2 ** Math.min(attempt, 6)) * 3000 + this.random() * 2000)
        : Math.min(30000, (2 ** Math.min(attempt, 5)) * 2000 + this.random() * 1000);
    } else {
      d = rateOrAuth
        ? Math.min(120000, (2 ** Math.min(attempt, 6)) * 10000 + this.random() * 5000)
        : Math.min(60000, (2 ** Math.min(attempt, 5)) * 5000 + this.random() * 2000);
    }
    if (err && err.retryAfterMs && err.retryAfterMs > d) d = Math.min(err.retryAfterMs, 300000);
    return d;
  }

  // req: {system, parts, schema, nativeSchema, temperature, maxOutputTokens, stream, placement}
  // meta: {kind, itemId, imagePath, validate(text) → null | "reason" (retry), schemaName}
  async call(req, meta = {}) {
    const kind = meta.kind || (this.role === "target" ? "TARGET_INFERENCE" : "GENERATOR");
    let persistentAttempts = 0;
    let parseAttempts = 0;
    for (let attempt = 0; ; attempt++) {
      await this.sem.acquire();
      let released = false;
      const t0 = Date.now();
      let res = null;
      try {
        res = await this.provider.generate(Object.assign({}, this.requestDefaults(), req));
        this.sem.release();
        released = true;
        const latencyMs = Date.now() - t0;
        this.stats.calls++;
        if (res.usage) {
          this.stats.inputTokens += res.usage.inputTokens || 0;
          this.stats.outputTokens += res.usage.outputTokens || 0;
          this.stats.reasoningTokens += res.usage.reasoningTokens || 0;
        }
        this.log({ kind, attempt, latencyMs, meta, req, res });
        if (meta.validate) {
          const reason = meta.validate(res.text || "", res);
          if (reason) throw new ParseRetry(reason);
        }
        return Object.assign({}, res, { attempt, latencyMs });
      } catch (err) {
        if (!released) this.sem.release();
        const latencyMs = Date.now() - t0;
        const k = classify(err);
        if (!(err instanceof ParseRetry)) {
          this.stats.errors++;
          this.stats.lastError = { kind: k, message: String(err.message || err).slice(0, 300), at: new Date().toISOString() };
          this.log({ kind, attempt, latencyMs, meta, req, error: err, errorKind: k });
        }
        if (err instanceof AttentionError) throw err;
        if (err instanceof ParseRetry) {
          parseAttempts++;
          const limit = this.policy.parseRetryLimit;
          if (limit && parseAttempts >= limit) {
            this.onEvent({ type: "warning", role: this.role, kind: "schema", message: `${meta.itemId || kind}: ${err.message} after ${parseAttempts} attempts — scored as an empty prediction` });
            return Object.assign({}, res, { attempt, latencyMs, invalid: err.message });
          }
        } else if (!TRANSIENT.has(k)) {
          persistentAttempts++;
          if (this.policy.persistentErrorPolicy === "attention" && persistentAttempts >= (this.policy.persistentErrorLimit || 8)) {
            throw new AttentionError(k, String(err.message || err).slice(0, 500), this.role);
          }
        }
        const delay = this.delayFor(err, attempt);
        if (attempt % 5 === 0 || attempt < 2) {
          this.onEvent({ type: "retry", role: this.role, kind: k, attempt: attempt + 1, delayMs: delay, message: String(err.message || err).slice(0, 160) });
        }
        await this.sleep(delay);
      }
    }
  }

  requestDefaults() {
    const c = this.cfg;
    return {
      model: c.model,
      temperature: c.temperature,
      maxOutputTokens: c.maxOutputTokens || null,
      placement: c.placement || "system",
      headers: c.headers || {},
      timeoutMs: c.timeoutMs || 0,
      extra: c.extra || {},
      stream: this.role === "generator" ? c.stream !== false : false,
      schemaMode: c.schemaMode || "auto",
    };
  }

  log({ kind, attempt, latencyMs, meta, req, res, error, errorKind }) {
    if (!this.apiLog) return;
    const parts = (req.parts || []).map((p) => (p.text !== undefined ? { text: p.text.length > 2000 ? p.text.slice(0, 2000) + "…" : p.text } : { mime: p.mime, path: p.path || null, bytes: p.bytes ? p.bytes.length : 0, base64LengthChars: p.bytes ? Math.ceil(p.bytes.length / 3) * 4 : 0 }));
    const rec = {
      ts: new Date().toISOString(), step: this.stepRef(), type: kind, role: this.role, attempt, latencyMs,
      itemId: meta.itemId || null, imagePath: meta.imagePath || null,
      request: {
        provider: this.connection && this.connection.type, model: this.cfg.model, system: req.system,
        parts, schema: meta.schemaName || (req.nativeSchema ? "native" : req.schema ? "json" : null),
        temperature: req.temperature !== undefined ? req.temperature : this.cfg.temperature, maxOutputTokens: req.maxOutputTokens || this.cfg.maxOutputTokens || null,
      },
    };
    if (res) {
      rec.response = { text: res.text, finish: res.finish, usage: res.usage, structured: res.structured, model: res.model };
      rec.responseLen = (res.text || "").length;
      rec.responsePreview = (res.text || "").slice(0, 200);
      if (meta.parsedPreview) { try { rec.parsed = meta.parsedPreview(res.text); } catch {} }
    }
    if (error) rec.error = { kind: errorKind, message: String(error.message || error).slice(0, 2000), status: error.status || (error.$metadata && error.$metadata.httpStatusCode) || null, name: error.name };
    this.apiLog.write(rec);
  }
}

module.exports = { Harness, Semaphore, createProvider, PROVIDERS, sleep };
