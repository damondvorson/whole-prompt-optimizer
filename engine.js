#!/usr/bin/env node
// engine.js — optimisation worker for one project:  node engine.js <projectId>
// Started by server.js with child_process.fork; receives credentials over IPC ("init").
// The loop is the original wpo_video_engine.js main() (1091–1408), generalised:
//   baseline → [meta-prompt → one generator call → candidates → evaluate all on train →
//   strict-> acceptance → justification for the winner → save] forever (or until a stop condition).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const store = require("./lib/store");
const method = require("./lib/method");
const scoring = require("./lib/scoring");
const { extractJSON } = require("./lib/parse");
const { renderItemPrompt, placeholdersIn } = require("./lib/template");
const { justificationSchemas, schemaHasProperty } = require("./lib/schema");
const { Harness } = require("./lib/harness");
const { AttentionError } = require("./lib/harness/errors");
const { MediaPipeline } = require("./lib/media");
const { ApiLog, makeRedactor } = require("./lib/apilog");

const DEFAULT_TOGGLES = {
  matchBestBy: "prompt", dedupeCandidates: false, maxCandidates: 0, historyWindow: 0,
  justificationPerItem: false, absentFieldScore: 100, mergeIdenticalInputs: false,
  placeholderGuard: "warn", parseRetryLimit: 8, persistentErrorPolicy: "attention", persistentErrorLimit: 8,
};

function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Engine {
  constructor(projectId, opts = {}) {
    this.id = projectId;
    this.paths = store.runPaths(projectId);
    this.project = store.loadProject(projectId);
    this.send = opts.send || ((msg) => { if (process.send) process.send(msg); });
    this.connections = opts.connections || {};
    this.paused = fs.existsSync(this.paths.pause);
    this.stopRequested = false;
    this.attention = null;
    this.warnings = [];
    this.phase = "init";
    this.progress = null;
    this.testEvalRunning = false;
    this.exclusionsDirty = false;
    this.logStream = null;
  }

  // ─── logging ───
  log(...args) {
    const line = args.join(" ");
    if (!this.logStream) {
      fs.mkdirSync(this.paths.dir, { recursive: true });
      try { if (fs.existsSync(this.paths.log) && fs.statSync(this.paths.log).size > 50 * 1024 * 1024) fs.renameSync(this.paths.log, this.paths.log + ".1"); } catch {}
      this.logStream = fs.createWriteStream(this.paths.log, { flags: "a" });
    }
    this.logStream.write(`${line}\n`);
    if (process.env.WPO_ENGINE_STDOUT) process.stdout.write(`${line}\n`);
  }
  warn(message) {
    this.warnings.push({ at: new Date().toISOString(), message });
    if (this.warnings.length > 50) this.warnings.shift();
    this.log(`  [WARN] ${message}`);
  }

  // ─── setup ───
  setup() {
    const p = this.project;
    this.fields = p.fields;
    this.toggles = Object.assign({}, DEFAULT_TOGGLES, (p.method && p.method.toggles) || {});
    this.targets = Object.assign({}, method.DEFAULT_TARGETS, (p.method && p.method.targets) || {});
    this.candidatesPerStep = (p.method && p.method.candidatesPerStep) || 3;
    this.minCandidateChars = (p.method && p.method.minCandidateChars) != null ? p.method.minCandidateChars : 200;
    this.output = p.output;
    this.mappings = {};
    for (const f of this.fields) this.mappings[f.key] = (p.output.mapping && p.output.mapping[f.key]) || { path: f.key, op: "value" };
    this.hasSummary = p.output.justification && p.output.justification.mode === "main_response";
    this.indexStyle = p.output.style === "index_array";
    this.fallbackOutput = this.indexStyle ? { s: "", b: [] } : {};
    this.just = justificationSchemas(p.output);
    this.basePlaceholders = placeholdersIn(p.prompt.base).filter((n) => p.prompt.placeholders || (p.prompt.rules || []).some((r) => r.find.includes(`{{${n}}}`)));
    // literal rule anchors (e.g. the legacy TIMING sentence): a candidate without them loses the per-item text
    this.ruleAnchors = (p.prompt.rules || []).map((r) => r.find).filter((f) => f && p.prompt.base.includes(f));

    const items = store.readManifest(this.id);
    const excluded = new Set(store.readJSON(path.join(this.paths.dir, "exclusions.json"), []));
    this.excluded = excluded;
    this.allItems = items;
    this.trainSet = items.filter((i) => i.split === "train" && !excluded.has(i.id));
    this.testSet = items.filter((i) => i.split === "test" && !excluded.has(i.id));
    if (this.trainSet.length === 0) throw new Error("The training split is empty");

    const secrets = [...secretValues(this.connections.target), ...secretValues(this.connections.generator)];
    this.redact = makeRedactor(secrets);
    this.apiLog = new ApiLog(this.paths.api, (p.logging && p.logging.apiLog) || "compact", this.redact);
    this.media = new MediaPipeline(this.paths.dir, p.target.media || {});
    const policy = {
      persistentErrorPolicy: this.toggles.persistentErrorPolicy, persistentErrorLimit: this.toggles.persistentErrorLimit,
      parseRetryLimit: this.toggles.parseRetryLimit,
    };
    const onEvent = (e) => {
      if (e.type === "retry") this.log(`  [${e.role} retry ${e.attempt}] ${e.kind}: ${this.redact(e.message)} — waiting ${(e.delayMs / 1000).toFixed(0)}s`);
      if (e.type === "warning") this.warn(this.redact(e.message));
    };
    const targetCfg = Object.assign({}, p.target);
    if (this.connections.target && this.connections.target.type === "mock") {
      const truth = {};
      for (const it of items) truth[it.id] = it.labels;
      targetCfg.__mock = { truth, fields: this.fields, output: this.output };
    }
    this.target = new Harness("target", targetCfg, this.connections.target, { apiLog: this.apiLog, onEvent, stepRef: () => (this.cp ? this.cp.currentStep : null), policy });
    this.generator = new Harness("generator", p.generator, this.connections.generator, { apiLog: this.apiLog, onEvent, stepRef: () => (this.cp ? this.cp.currentStep : null), policy: Object.assign({}, policy, { parseRetryLimit: 0 }) });
  }

  // ─── checkpoint ───
  loadOrCreateCheckpoint() {
    let cp = store.loadCheckpoint(this.id);
    if (cp) {
      this.history = store.truncateHistory(this.id, cp.historyCount || 0);
      this.log(`Loaded checkpoint (step ${cp.currentStep || 0}, ${this.history.length} history entries)`);
    } else {
      cp = {
        version: 5, projectId: this.id, category: this.project.categoryName || "", currentStep: 0, basePrompt: null,
        best: null, staleSteps: 0, historyCount: 0, bestAchievedAtStep: 0, epoch: 0, testEval: null,
        configSha: store.configSha(this.project), datasetSha: this.project.dataset && this.project.dataset.datasetSha,
        spend: { target: { calls: 0, inputTokens: 0, outputTokens: 0 }, generator: { calls: 0, inputTokens: 0, outputTokens: 0 } },
        startedAt: new Date().toISOString(),
      };
      this.history = [];
      store.truncateHistory(this.id, 0);
    }
    const nowSha = store.configSha(this.project);
    if (cp.configSha && cp.configSha !== nowSha && cp.basePrompt) {
      cp.epoch = (cp.epoch || 0) + 1;
      cp.configSha = nowSha;
      this.warn(`Configuration changed since the last run — continuing as epoch ${cp.epoch}`);
    }
    this.cp = cp;
    this.spendBase = JSON.parse(JSON.stringify(cp.spend || {}));
  }

  spendNow() {
    const add = (base, stats) => ({
      calls: ((base && base.calls) || 0) + stats.calls,
      inputTokens: ((base && base.inputTokens) || 0) + stats.inputTokens,
      outputTokens: ((base && base.outputTokens) || 0) + stats.outputTokens,
    });
    const s = { target: add(this.spendBase.target, this.target.stats), generator: add(this.spendBase.generator, this.generator.stats) };
    const pr = this.project.pricing || {};
    const usd = (role) => {
      const r = pr[role];
      if (!r || (!r.inPerM && !r.outPerM)) return null;
      return (s[role].inputTokens / 1e6) * (r.inPerM || 0) + (s[role].outputTokens / 1e6) * (r.outPerM || 0);
    };
    const a = usd("target"), b = usd("generator");
    s.usd = a === null && b === null ? null : (a || 0) + (b || 0);
    return s;
  }

  save() {
    this.cp.spend = this.spendNow();
    this.cp.historyCount = this.history.length;
    this.cp.updatedAt = new Date().toISOString();
    store.saveCheckpoint(this.id, this.cp, { backupsEvery: 10, keepBackups: 20 });
    this.writeSummary();
  }

  state() {
    if (this.attention) return "needs_attention";
    if (this.finished) return this.finished;
    if (this.phase === "init" || this.phase === "preprocess" || this.phase === "smoke") return "initializing";
    return this.paused ? "paused" : "running";
  }

  writeSummary() {
    const cp = this.cp || {};
    const passing = (m) => this.fields.filter((f) => m && m[f.key] && method.fieldPasses(f, m[f.key], this.targets)).length;
    const summary = {
      projectId: this.id, state: this.state(), phase: this.phase, progress: this.progress,
      step: cp.currentStep || 0, stale: cp.staleSteps || 0, epoch: cp.epoch || 0,
      bestAccuracy: cp.best ? cp.best.accuracy : null, bestPerFieldMetrics: cp.best ? cp.best.perFieldMetrics : null,
      bestEntryId: cp.best ? cp.best.entryId : null, bestAchievedAtStep: cp.bestAchievedAtStep || 0,
      baseAccuracy: this.history.length ? this.history[0].accuracy : null,
      fieldsPassing: cp.best ? passing(cp.best.perFieldMetrics) : 0,
      testEval: cp.testEval ? Object.assign({}, cp.testEval, { running: this.testEvalRunning }) : (this.testEvalRunning ? { running: true } : null),
      history: this.history.map((e) => ({ id: e.id, step: e.step, candidateIndex: e.candidateIndex, accuracy: e.accuracy, accepted: !!e.accepted, kind: e.kind, epoch: e.epoch || 0, passing: passing(e.perFieldMetrics), wrong: (e.wrongPredictions || []).length, placeholdersDropped: e.placeholdersDropped || undefined })),
      perFieldHistory: this.history.filter((e) => e.accepted || e.step === 0).map((e) => ({ step: e.step, accuracy: e.accuracy, perFieldMetrics: e.perFieldMetrics })),
      fields: this.fields.map((f) => ({ key: f.key, label: f.label || f.key, type: f.type, index: f.index, classes: f.classes })),
      targets: this.targets, trainCount: this.trainSet ? this.trainSet.length : 0, testCount: this.testSet ? this.testSet.length : 0,
      excluded: this.excluded ? this.excluded.size : 0,
      spend: this.target ? this.spendNow() : cp.spend, pricing: this.project.pricing || null,
      attention: this.attention, warnings: this.warnings.slice(-20),
      lastErrors: { target: this.target && this.target.stats.lastError, generator: this.generator && this.generator.stats.lastError },
      models: { target: this.project.target.model, generator: this.project.generator.model, targetProvider: this.connections.target && this.connections.target.type, generatorProvider: this.connections.generator && this.connections.generator.type },
      startedAt: cp.startedAt, updatedAt: new Date().toISOString(),
    };
    store.writeSummary(this.id, summary);
    this.send({ type: "summary", state: summary.state, step: summary.step });
  }

  setPhase(phase, progress) {
    this.phase = phase;
    this.progress = progress || null;
    if (!this._lastPhaseWrite || Date.now() - this._lastPhaseWrite > 1000 || !progress) {
      this._lastPhaseWrite = Date.now();
      if (this.cp) this.writeSummary();
      else store.writeSummary(this.id, Object.assign(store.readSummary(this.id) || {}, { projectId: this.id, state: this.state(), phase, progress: this.progress, updatedAt: new Date().toISOString() }));
    }
    this.send({ type: "phase", phase, progress });
  }

  // ─── model calls ───
  schemasFor(kind) {
    if (kind === "TARGET_JUSTIFICATION") return { schema: this.just.jsonSchema, nativeSchema: this.output.nativeSchema ? this.just.nativeSchema : null };
    return { schema: this.output.jsonSchema, nativeSchema: this.output.nativeSchema || null };
  }

  // One target call for an item (journal-aware). Returns {text, invalid, error}.
  async targetCall(systemPrompt, parts, item, kind, journal, journalAppend) {
    const key = sha1(`${kind}|${sha1(systemPrompt)}|${item.id}`);
    const hit = journal && journal.get(key);
    if (hit) return { text: hit.text, invalid: hit.invalid, fromJournal: true };
    const { schema, nativeSchema } = this.schemasFor(kind);
    const validate = (text) => {
      const ex = extractJSON(text, this.fallbackOutput);
      if (!ex.parsed) return null; // unparseable → empty prediction, not retried (original behaviour)
      if (kind === "TARGET_JUSTIFICATION") return ex.value && typeof ex.value === "object" && !Array.isArray(ex.value) && Array.isArray(ex.value.b) ? null : (this.indexStyle ? "No b array — likely transient" : null);
      return scoring.outputHasMappedPaths(this.fields.filter((f) => f.key in (item.labels || {})).length ? this.fields.filter((f) => f.key in item.labels) : this.fields, this.mappings, ex.value)
        ? null : (this.indexStyle ? "No b array — likely transient" : "Output is missing mapped fields");
    };
    const res = await this.target.call(
      { system: systemPrompt, parts, schema, nativeSchema, trace: { itemId: item.id } },
      { kind, itemId: item.id, imagePath: parts.find((p) => p.path) ? parts.find((p) => p.path).path : null, validate, schemaName: kind === "TARGET_JUSTIFICATION" ? "justification" : "output" },
    );
    const out = { text: res.text || "", invalid: res.invalid || null };
    if (journalAppend) journalAppend({ k: key, text: out.text, invalid: out.invalid });
    return out;
  }

  // Port of evaluatePrompt (503–581).
  async evaluatePrompt(prompt, itemList, ctx = {}) {
    const counters = scoring.newCounters(this.fields);
    let processed = 0;
    const imageResults = await Promise.all(itemList.map(async (item) => {
      let parts, vars, error = false;
      try { ({ parts, vars } = await this.media.partsFor(item)); } catch (err) {
        this.warn(`${item.id}: cannot read input (${err.message}) — scored as an empty prediction`);
        parts = null; vars = item.vars || {}; error = `input: ${err.message}`;
      }
      const sys = renderItemPrompt(prompt, this.project.prompt, vars);
      let text = "", invalid = null;
      if (parts) ({ text, invalid } = await this.targetCall(sys, parts, item, "TARGET_INFERENCE", ctx.journal, ctx.journalAppend));
      const ex = extractJSON(text, this.fallbackOutput);
      const result = invalid ? this.fallbackOutput : ex.value;
      const { predicted, wrongFields } = scoring.scoreItem(this.fields, this.mappings, item, result && typeof result === "object" ? result : {}, counters);
      const done = ++processed;
      if (done % 100 === 0 || done === itemList.length) {
        this.log(`    Evaluated ${done}/${itemList.length} images`);
        if (ctx.progress) ctx.progress(done, itemList.length);
      }
      const labeledKeys = this.fields.filter((f) => item.labels && f.key in item.labels).map((f) => f.key);
      const r = {
        imageId: item.id, fieldKey: labeledKeys[0] || null, labels: item.labels, predicted, wrongFields,
        summary: (result && typeof result.s === "string" && result.s) || "",
        rawResponse: this.hasSummary ? text : "", rawText: text,
        error: error || (invalid ? `schema: ${invalid}` : (!ex.parsed && text ? "unparseable" : false)),
      };
      if (this.indexStyle) {
        const b = result && Array.isArray(result.b) ? result.b : [];
        r.detectedB = Array.from(new Set(b));
        const f0 = this.fields.find((f) => f.key === labeledKeys[0]);
        if (f0 && labeledKeys.length === 1) {
          r.bIdx = f0.index;
          r.polarity = item.labels[f0.key] ? "pos" : "neg";
          r.expectedB = item.labels[f0.key] ? [f0.index] : [];
          r.labeledB = [f0.index];
        }
      }
      r.item = item;
      return r;
    }));
    const fin = scoring.finalizeMetrics(this.fields, counters, { absentFieldScore: this.toggles.absentFieldScore });
    return { perField: fin.perField, overallAccuracy: fin.overallAccuracy, imageResults };
  }

  // Port of collectWrongPredictions (596–614).
  collectWrongs(imageResults) {
    const wrongs = [];
    for (const ir of imageResults) {
      if (ir.error && ir.error.startsWith && ir.error.startsWith("input:")) continue;
      for (const wf of ir.wrongFields) {
        const w = { imageId: ir.imageId, fieldKey: wf.fieldKey, bIdx: wf.bIdx, expected: wf.expected, actual: wf.actual };
        if (ir.detectedB) w.detectedB = ir.detectedB;
        Object.defineProperty(w, "_ir", { value: ir, enumerable: false });
        wrongs.push(w);
      }
    }
    return wrongs;
  }

  // Port of collectWrongDetails (617–645): the justification pass.
  async collectJustifications(wrongs, prompt, ctx = {}) {
    if (wrongs.length === 0) return [];
    this.log(`  Collecting details for ${wrongs.length} wrong predictions...`);
    if (this.hasSummary) {
      return wrongs.map((w) => Object.assign({}, w, { justification: w._ir.rawResponse || "" })).filter((w) => w.justification);
    }
    const perItem = this.toggles.justificationPerItem;
    const cache = new Map();
    const results = await Promise.all(wrongs.map(async (w) => {
      const ir = w._ir;
      try {
        const key = perItem ? ir.imageId : `${ir.imageId}|${w.fieldKey}`;
        if (!cache.has(key)) {
          cache.set(key, (async () => {
            const { parts, vars } = await this.media.partsFor(ir.item);
            const sys = renderItemPrompt(prompt, this.project.prompt, vars);
            // per (item, field) pairs share the same request; the journal key adds the field so each
            // pair is its own call, exactly like the original (one call per wrong prediction)
            const jItem = perItem ? ir.item : Object.assign({}, ir.item, { id: `${ir.item.id}#${w.fieldKey}` });
            const { text } = await this.targetCall(sys, parts, jItem, "TARGET_JUSTIFICATION", ctx.journal, ctx.journalAppend);
            return text || "";
          })());
        }
        return Object.assign({}, w, { justification: await cache.get(key) });
      } catch (err) {
        if (err instanceof AttentionError) throw err;
        return Object.assign({}, w, { justification: "" });
      }
    }));
    return results.filter((r) => r.justification);
  }

  bestResultsRecord(imageResults) {
    return imageResults.map((ir) => {
      const r = { imageId: ir.imageId, fieldKey: ir.fieldKey, labels: ir.labels, predicted: ir.predicted, summary: ir.summary, wrongFields: ir.wrongFields, error: ir.error };
      if (ir.detectedB) Object.assign(r, { detectedB: ir.detectedB, expectedB: ir.expectedB, labeledB: ir.labeledB, polarity: ir.polarity, bIdx: ir.bIdx });
      return r;
    });
  }

  // ─── initialisation ───
  async initialize() {
    this.setPhase("preprocess", { done: 0, total: this.trainSet.length + this.testSet.length, label: "Preparing inputs" });
    const errs = await this.media.warm([...this.trainSet, ...this.testSet], (d, t) => this.setPhase("preprocess", { done: d, total: t, label: "Preparing inputs" }));
    if (errs.length) this.warn(`${errs.length} items could not be preprocessed (first: ${errs[0].id}: ${errs[0].error})`);
    if (this.project.method && this.project.method.smoke === false) return;
    this.setPhase("smoke", { label: "Checking both models" });
    const item = this.trainSet[0];
    const { parts, vars } = await this.media.partsFor(item);
    const sys = renderItemPrompt(this.cp.best ? this.cp.best.prompt : this.project.prompt.base, this.project.prompt, vars);
    const { schema, nativeSchema } = this.schemasFor("TARGET_INFERENCE");
    await this.target.call({ system: sys, parts, schema, nativeSchema, trace: { itemId: item.id } }, { kind: "SMOKE_TARGET", itemId: item.id, schemaName: "output", imagePath: parts.find((x) => x.path) ? parts.find((x) => x.path).path : null });
    await this.generator.call({ system: null, parts: [{ text: "Reply with the single word OK." }], maxOutputTokens: this.project.generator.smokeMaxTokens || 2048, stream: false }, { kind: "SMOKE_GENERATOR" });
  }

  async waitWhilePaused() {
    if (!this.paused) return;
    this.log("  PAUSED. Saving checkpoint...");
    this.save();
    while (this.paused && !this.stopRequested) await sleep(500);
    if (!this.stopRequested) this.log("  RESUMED.");
    this.writeSummary();
  }

  // Exclusions take effect at a step boundary: drop the items, recompute best metrics from the stored
  // per-item results (no API calls) and drop their wrong predictions from the best entry.
  applyExclusions() {
    if (!this.exclusionsDirty) return;
    this.exclusionsDirty = false;
    const ex = this.excluded;
    this.trainSet = this.trainSet.filter((i) => !ex.has(i.id));
    this.testSet = this.testSet.filter((i) => !ex.has(i.id));
    const best = store.readResults(this.id, "best");
    if (best && this.cp.best) {
      const counters = scoring.newCounters(this.fields);
      const kept = best.itemResults.filter((r) => !ex.has(r.imageId));
      for (const r of kept) {
        const item = { labels: r.labels };
        const out = this.indexStyle ? { b: r.detectedB || [] } : null;
        if (out) scoring.scoreItem(this.fields, this.mappings, item, out, counters);
        else {
          // rebuild an output object from predicted values via the mappings
          const o = {};
          for (const f of this.fields) if (r.predicted && f.key in r.predicted) setPath(o, this.mappings[f.key].path || f.key, r.predicted[f.key]);
          scoring.scoreItem(this.fields, this.mappings, item, o, counters);
        }
      }
      const fin = scoring.finalizeMetrics(this.fields, counters, { absentFieldScore: this.toggles.absentFieldScore });
      this.cp.best.accuracy = fin.overallAccuracy;
      this.cp.best.perFieldMetrics = scoring.compactMetrics(this.fields, fin.perField);
      store.writeResults(this.id, "best", { entryId: best.entryId, itemResults: kept });
      for (const e of this.history) if (e.wrongPredictions) e.wrongPredictions = e.wrongPredictions.filter((w) => !ex.has(w.imageId));
      store.truncateHistory(this.id, 0);
      store.appendHistory(this.id, this.history);
      this.log(`  [EXCLUDE] ${ex.size} items excluded; best accuracy recomputed: ${fin.overallAccuracy.toFixed(1)}%`);
    }
    this.save();
  }

  stopReason() {
    const s = (this.project.method && this.project.method.stop) || {};
    if (s.maxSteps && this.cp.currentStep > s.maxSteps) return `reached ${s.maxSteps} steps`;
    if (s.maxStale && this.cp.staleSteps >= s.maxStale) return `${s.maxStale} steps without improvement`;
    if (s.allPass && this.cp.best && this.fields.every((f) => method.fieldPasses(f, this.cp.best.perFieldMetrics[f.key], this.targets))) return "every field passes";
    if (s.budgetUsd) { const sp = this.spendNow(); if (sp.usd !== null && sp.usd >= s.budgetUsd) return `spend reached $${sp.usd.toFixed(2)}`; }
    if (s.budgetTokens) { const sp = this.spendNow(); if (sp.target.inputTokens + sp.target.outputTokens + sp.generator.inputTokens + sp.generator.outputTokens >= s.budgetTokens) return "token budget reached"; }
    return null;
  }

  // ─── baseline (original 1192–1242) ───
  async baseline() {
    this.log("Phase 1: Evaluating base prompt (baseline)...\n");
    const journal = store.readJournal(this.id, 0);
    const journalAppend = store.journalAppender(this.id, 0);
    const prompt = this.project.prompt.base;
    this.setPhase("baseline", { done: 0, total: this.trainSet.length, label: "Baseline" });
    const ctx = { journal, journalAppend, progress: (d, t) => this.setPhase("baseline", { done: d, total: t, label: "Baseline" }) };
    const baseline = await this.evaluatePrompt(prompt, this.trainSet, ctx);
    const metrics = scoring.compactMetrics(this.fields, baseline.perField);
    this.log(`\n  Baseline accuracy: ${baseline.overallAccuracy.toFixed(1)}%`);
    for (const f of this.fields) this.log(`    ${method.fieldPasses(f, metrics[f.key], this.targets) ? "✓" : "✗"} ${f.key}: ${method.metricText(f, baseline.perField[f.key])}`);
    const wrongs = this.collectWrongs(baseline.imageResults);
    this.log(`\n  ${wrongs.length} total wrong predictions in baseline`);
    this.setPhase("baseline", { label: "Collecting justifications" });
    const wrongsWithJust = await this.collectJustifications(wrongs, prompt, { journal, journalAppend });
    const entry = { id: "0-0", step: 0, candidateIndex: 0, kind: "baseline", prompt, accuracy: baseline.overallAccuracy, perFieldMetrics: metrics, wrongPredictions: wrongsWithJust, accepted: true, epoch: this.cp.epoch || 0, timestamp: new Date().toISOString() };
    store.writeResults(this.id, "best", { entryId: entry.id, itemResults: this.bestResultsRecord(baseline.imageResults) });
    store.appendHistory(this.id, [entry]);
    this.history.push(entry);
    Object.assign(this.cp, { basePrompt: prompt, best: { entryId: entry.id, prompt, accuracy: baseline.overallAccuracy, perFieldMetrics: metrics }, currentStep: 1, bestAchievedAtStep: 0 });
    this.save();
    store.dropJournal(this.id, 0);
  }

  // ─── one optimisation step (original 1259–1407) ───
  async step() {
    const cp = this.cp;
    const step = cp.currentStep;
    this.log(`\n  ── Step ${step} (stale: ${cp.staleSteps}) ──`);
    this.log(`  Current best accuracy: ${cp.best.accuracy.toFixed(1)}%`);
    const wrongsForMeta = method.wrongsForMeta(this.history, { prompt: cp.best.prompt, entryId: cp.best.entryId }, this.toggles.matchBestBy);
    const metaPrompt = method.buildMetaPrompt({
      fields: this.fields, hasSummary: this.hasSummary, bestPrompt: cp.best.prompt, bestAccuracy: cp.best.accuracy,
      bestMetrics: cp.best.perFieldMetrics, wrongs: wrongsForMeta,
      history: method.windowHistory(this.history, step, this.toggles.historyWindow), isFirstStep: step === 1,
      candidatesPerStep: this.candidatesPerStep, targets: this.targets,
      template: (this.project.method && this.project.method.metaTemplate) || null,
    });
    this.log(`  Meta-prompt size: ${(metaPrompt.length / 1024).toFixed(1)}KB`);
    const stepFile = { step, metaPrompt, sizeKB: +(metaPrompt.length / 1024).toFixed(1), timestamp: new Date().toISOString(), epoch: cp.epoch || 0 };
    store.writeStep(this.id, step, stepFile);
    const keep = store.listSteps(this.id);
    for (const s of keep.slice(0, Math.max(0, keep.length - 50))) { try { fs.unlinkSync(path.join(this.paths.steps, `${s}.json`)); } catch {} }

    const journal = store.readJournal(this.id, step);
    const journalAppend = store.journalAppender(this.id, step);
    let genText;
    const gk = sha1(`GEN|${sha1(metaPrompt)}`);
    if (journal.get(gk)) genText = journal.get(gk).text;
    else {
      this.setPhase("generate", { label: `Step ${step}: generating ${this.candidatesPerStep} candidates` });
      this.log(`  Generating ${this.candidatesPerStep} candidate prompts via the generator...`);
      const res = await this.generator.call({ system: null, parts: [{ text: metaPrompt }] }, {
        kind: "GENERATOR",
        validate: (text, r) => (text ? null : (r && r.finish === "refusal" ? null : "No text from generator")),
      });
      genText = res.text || "";
      if (res.finish === "refusal") this.warn(`Step ${step}: the generator refused to answer`);
      journalAppend({ k: gk, text: genText });
    }
    let candidates = method.extractPromptCandidates(genText, { minChars: this.minCandidateChars, dedupe: this.toggles.dedupeCandidates, maxCandidates: this.toggles.maxCandidates });
    this.log(`  Extracted ${candidates.length} valid candidate prompts`);
    const dropped = candidates.map((c) => method.placeholdersDropped(c, this.basePlaceholders)
      .concat(this.ruleAnchors.filter((a) => !c.includes(a)).map((a) => `rule: "${a.slice(0, 48)}${a.length > 48 ? "…" : ""}"`)));
    if ((this.basePlaceholders.length || this.ruleAnchors.length) && dropped.some((d) => d.length)) {
      if (this.toggles.placeholderGuard === "discard") {
        const before = candidates.length;
        candidates = candidates.filter((c, i) => dropped[i].length === 0);
        this.warn(`Step ${step}: discarded ${before - candidates.length} candidates that dropped placeholders`);
      } else if (this.toggles.placeholderGuard === "warn") {
        dropped.forEach((d, i) => { if (d.length) this.warn(`Step ${step}: candidate ${i + 1} dropped ${d.map((n) => (n.startsWith("rule: ") ? `the substitution anchor ${n.slice(6)}` : `{{${n}}}`)).join(", ")} — its per-item text will not be inserted`); });
      }
    }
    store.writeStep(this.id, step, Object.assign(stepFile, { generatorText: genText, candidateCount: candidates.length }));

    if (candidates.length === 0) {
      this.log("  No valid candidates extracted. Incrementing stale counter.");
      cp.staleSteps++;
      cp.currentStep++;
      this.save();
      store.dropJournal(this.id, step);
      return;
    }

    this.log(`\n  Evaluating ${candidates.length} candidates in parallel...`);
    const total = candidates.length * this.trainSet.length;
    const done = new Array(candidates.length).fill(0);
    const candidateResults = await Promise.all(candidates.map(async (candidatePrompt, ci) => {
      const evalResult = await this.evaluatePrompt(candidatePrompt, this.trainSet, {
        journal, journalAppend,
        progress: (d) => { done[ci] = d; this.setPhase("evaluate", { done: done.reduce((a, b) => a + b, 0), total, label: `Step ${step}: evaluating ${candidates.length} candidates` }); },
      });
      const passing = this.fields.filter((f) => method.fieldPasses(f, evalResult.perField[f.key], this.targets)).length;
      this.log(`    Candidate ${ci + 1}: accuracy=${evalResult.overallAccuracy.toFixed(1)}% | ${passing}/${this.fields.length} fields passing`);
      return { candidatePrompt, evalResult, ci };
    }));

    const newEntries = candidateResults.map((cr) => ({
      id: `${step}-${cr.ci}`, step, candidateIndex: cr.ci, kind: "candidate", prompt: cr.candidatePrompt,
      accuracy: cr.evalResult.overallAccuracy, perFieldMetrics: scoring.compactMetrics(this.fields, cr.evalResult.perField),
      wrongPredictions: this.collectWrongs(cr.evalResult.imageResults).map((w) => Object.assign({}, w, { justification: "" })),
      accepted: false, epoch: cp.epoch || 0, timestamp: new Date().toISOString(),
      ...(dropped[cr.ci] && dropped[cr.ci].length ? { placeholdersDropped: dropped[cr.ci] } : {}),
    }));
    const winner = method.pickWinner(candidateResults.map((cr) => cr.evalResult.overallAccuracy), cp.best.accuracy);
    if (winner >= 0) {
      const cr = candidateResults[winner];
      this.setPhase("justify", { label: `Step ${step}: collecting justifications` });
      this.log("  Collecting details for best candidate...");
      const wrongsWithJust = await this.collectJustifications(this.collectWrongs(cr.evalResult.imageResults), cr.candidatePrompt, { journal, journalAppend });
      // original: the justified wrongs go to the LAST entry of this step with the same prompt text
      let target = newEntries[winner];
      if (this.toggles.matchBestBy !== "id") {
        for (let i = newEntries.length - 1; i >= 0; i--) if (newEntries[i].prompt === cr.candidatePrompt) { target = newEntries[i]; break; }
      }
      target.wrongPredictions = wrongsWithJust;
      newEntries[winner].accepted = true;
      this.log(`\n  ✓ ACCEPTED: accuracy ${cp.best.accuracy.toFixed(1)}% → ${cr.evalResult.overallAccuracy.toFixed(1)}%`);
      cp.best = { entryId: newEntries[winner].id, prompt: cr.candidatePrompt, accuracy: cr.evalResult.overallAccuracy, perFieldMetrics: newEntries[winner].perFieldMetrics };
      cp.staleSteps = 0;
      cp.bestAchievedAtStep = step;
      store.writeResults(this.id, "best", { entryId: cp.best.entryId, itemResults: this.bestResultsRecord(cr.evalResult.imageResults) });
      let passing = 0;
      for (const f of this.fields) {
        const ok = method.fieldPasses(f, cr.evalResult.perField[f.key], this.targets);
        if (ok) passing++;
        this.log(`    ${ok ? "✓" : "✗"} ${f.key}: ${method.metricText(f, cr.evalResult.perField[f.key])}`);
      }
      this.log(`  Fields passing: ${passing}/${this.fields.length}`);
    } else {
      this.log(`\n  ✗ REJECTED: no candidate improved over ${cp.best.accuracy.toFixed(1)}%`);
      cp.staleSteps++;
    }
    store.appendHistory(this.id, newEntries);
    this.history.push(...newEntries);
    cp.currentStep++;
    this.save();
    store.dropJournal(this.id, step);
  }

  // ─── on-demand test-set evaluation (stores into the in-memory checkpoint) ───
  async runTestEval() {
    if (this.testEvalRunning || !this.cp || !this.cp.best) return;
    this.testEvalRunning = true;
    this.writeSummary();
    try {
      const prompt = this.cp.best.prompt;
      this.log("\n  [TEST EVAL] Running test-set evaluation...");
      const r = await this.evaluatePrompt(prompt, this.testSet, {});
      this.cp.testEval = {
        timestamp: new Date().toISOString(), entryId: this.cp.best.entryId, step: this.cp.currentStep,
        overallAccuracy: r.overallAccuracy, perField: scoring.compactMetrics(this.fields, r.perField), items: this.testSet.length, resultsName: "test",
      };
      store.writeResults(this.id, "test", { entryId: this.cp.best.entryId, itemResults: this.bestResultsRecord(r.imageResults) });
      this.log(`  [TEST EVAL] Done. Test: ${r.overallAccuracy.toFixed(1)}% | Train: ${this.cp.best.accuracy.toFixed(1)}% (stored)`);
    } catch (err) {
      if (err instanceof AttentionError) this.raiseAttention(err); else this.log(`  [TEST EVAL] Error: ${err.message}`);
    } finally {
      this.testEvalRunning = false;
      this.save();
      this.send({ type: "testEvalDone" });
    }
  }

  raiseAttention(err) {
    this.attention = { kind: err.kind || "error", role: err.role || null, message: this.redact(String(err.message || err)), at: new Date().toISOString() };
    this.log(`  [ATTENTION] ${this.attention.role || ""} ${this.attention.kind}: ${this.attention.message}`);
    this.send({ type: "attention", ...this.attention });
    if (this.cp) this.writeSummary();
  }

  async waitForAttentionCleared() {
    while (this.attention && !this.stopRequested) await sleep(500);
  }

  // ─── main ───
  async run() {
    this.setup();
    this.log(`\n${"=".repeat(60)}`);
    this.log(`  Whole-Prompt Optimizer: ${this.project.name}`);
    this.log(`  ${this.fields.length} fields | train ${this.trainSet.length} / test ${this.testSet.length} items`);
    this.log(`  Candidate: ${this.connections.target.type} ${this.project.target.model} | Generator: ${this.connections.generator.type} ${this.project.generator.model}`);
    this.log(`  ${this.candidatesPerStep} candidates/step | Targets: TPR ${this.targets.tpr}% / TNR ${this.targets.tnr}% / score ${this.targets.score}%`);
    this.log(`${"=".repeat(60)}\n`);
    this.loadOrCreateCheckpoint();
    for (;;) {
      try {
        await this.initialize();
        break;
      } catch (err) {
        if (err instanceof AttentionError) { this.raiseAttention(err); await this.waitForAttentionCleared(); if (this.stopRequested) return this.shutdown("stopped"); continue; }
        throw err;
      }
    }
    this.setPhase(this.cp.basePrompt ? "optimize" : "baseline");
    this.send({ type: "ready" });
    this.writeSummary();

    for (;;) {
      if (this.stopRequested) return this.shutdown("stopped");
      await this.waitWhilePaused();
      if (this.stopRequested) return this.shutdown("stopped");
      this.applyExclusions();
      try {
        if (!this.cp.basePrompt) { await this.baseline(); continue; }
        const reason = this.stopReason();
        if (reason) {
          this.log(`\n  Stopping: ${reason}`);
          const st = (this.project.method && this.project.method.stop) || {};
          if (st.testEvalOnStop && this.testSet.length && !(this.cp.testEval && this.cp.testEval.entryId === this.cp.best.entryId)) await this.runTestEval();
          this.finished = "completed"; this.completedReason = reason; this.save();
          return this.shutdown("completed", reason);
        }
        this.setPhase("optimize");
        await this.step();
      } catch (err) {
        if (err instanceof AttentionError) {
          this.raiseAttention(err);
          await this.waitForAttentionCleared();
          continue; // retry the same step; finished calls come from the journal
        }
        throw err;
      }
    }
  }

  async shutdown(reason, detail) {
    this.finished = reason === "completed" ? "completed" : "stopped";
    this.phase = reason;
    this.progress = null;
    try { await this.apiLog.flush(); } catch {}
    if (this.cp) this.save();
    this.send({ type: "stopped", reason, detail: detail || null });
    if (this.logStream) await new Promise((r) => this.logStream.end(r));
  }

  // ─── IPC ───
  handle(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "pause": this.paused = true; try { fs.writeFileSync(this.paths.pause, "pause"); } catch {} if (this.cp) this.writeSummary(); break;
      case "resume": this.paused = false; try { fs.unlinkSync(this.paths.pause); } catch {} if (this.attention) { this.log("  Resuming after attention"); this.attention = null; } if (this.cp) this.writeSummary(); break;
      case "stop": this.stopRequested = true; this.paused = false; this.attention = null; break;
      case "testEval": this.runTestEval(); break;
      case "exclude": case "include": {
        const ids = Array.isArray(msg.ids) ? msg.ids : [msg.itemId];
        for (const id of ids) { if (msg.type === "exclude") this.excluded.add(id); else this.excluded.delete(id); }
        if (msg.type === "include") {
          const ex = this.excluded;
          this.trainSet = this.allItems.filter((i) => i.split === "train" && !ex.has(i.id));
          this.testSet = this.allItems.filter((i) => i.split === "test" && !ex.has(i.id));
        }
        this.exclusionsDirty = true;
        this.log(`  [${msg.type.toUpperCase()}] ${ids.join(", ")} (applies at the next step boundary)`);
        break;
      }
      default: break;
    }
  }
}

function setPath(obj, p, v) {
  const parts = String(p).replace(/^\$\.?/, "").match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {}; cur = cur[parts[i]]; }
  if (parts.length) cur[parts[parts.length - 1]] = v;
}

function secretValues(conn) {
  try { return require("./lib/connections").secretValues(conn); } catch { return []; }
}

// ─── process entry ───
if (require.main === module) {
  const projectId = process.argv[2];
  let engine = null;
  const fail = (err) => {
    const message = err && err.stack ? err.stack : String(err);
    try { if (engine) engine.log(`FATAL: ${message}`); } catch {}
    try {
      const s = store.readSummary(projectId) || {};
      store.writeSummary(projectId, Object.assign(s, { state: "crashed", error: String(err && err.message ? err.message : err), updatedAt: new Date().toISOString() }));
    } catch {}
    if (process.send) process.send({ type: "fatal", message: String(err && err.message ? err.message : err) });
    setTimeout(() => process.exit(1), 100);
  };
  process.on("uncaughtException", (err) => { if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) return; fail(err); });
  process.on("unhandledRejection", (err) => fail(err));
  process.on("message", (msg) => {
    if (msg && msg.type === "init") {
      if (engine) return;
      try {
        engine = new Engine(projectId, { connections: msg.connections });
        engine.run().then(() => setTimeout(() => process.exit(0), 50)).catch(fail);
      } catch (err) { fail(err); }
    } else if (engine) engine.handle(msg);
  });
  process.on("SIGTERM", async () => {
    if (engine) { engine.stopRequested = true; try { await engine.apiLog.flush(); if (engine.cp) engine.save(); } catch {} }
    process.exit(0);
  });
  if (process.send) process.send({ type: "spawned" });
}

module.exports = { Engine, DEFAULT_TOGGLES };
