// projects.js — project defaults, config validation, output-schema generation, preflight.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");
const method = require("./method");
const { DEFAULT_TOGGLES } = require("../engine");
const { indexArrayOutput, namedFieldsOutput, schemaHasProperty } = require("./schema");
const { createProvider } = require("./harness");
const { Harness } = require("./harness");
const { MediaPipeline } = require("./media");
const { extractJSON } = require("./parse");
const scoring = require("./scoring");
const { renderItemPrompt, placeholdersIn, templateNames, parseTemplate } = require("./template");
const { ApiLog, makeRedactor } = require("./apilog");
const connectionsLib = require("./connections");

function newProject(name) {
  const id = store.slugify(name);
  return {
    id, name: name || "Untitled optimization", createdAt: new Date().toISOString(), state: "draft",
    dataset: null, fields: [],
    prompt: { base: "", placeholders: true, rules: [] },
    output: null,
    target: {
      connectionId: null, model: "", temperature: 0, maxOutputTokens: null, concurrency: 50, timeoutMs: 120000,
      placement: "system", schemaMode: "auto", headers: {}, extra: {}, promptCaching: true, refusalFallback: false,
      media: { image: { mode: "none", width: 840, height: 480, fit: "fill", format: "png" }, video: { mode: "grid", frames: 4, rows: 2, cols: 2, cellWidth: 840, cellHeight: 480 } },
    },
    generator: { connectionId: null, model: "", temperature: 1.0, maxOutputTokens: 65536, concurrency: 4, timeoutMs: 0, headers: {}, extra: {}, stream: true, refusalFallback: true },
    method: {
      candidatesPerStep: 3, minCandidateChars: 200, targets: { tpr: 80, tnr: 80, score: 80 },
      metaTemplate: null, toggles: Object.assign({}, DEFAULT_TOGGLES), stop: {}, smoke: true,
    },
    pricing: null,
    logging: { apiLog: "compact" },
  };
}

// Default output for the current fields: the original index-array {"b": [...]} when every field is
// binary (that is what the original meta-prompt describes), named fields otherwise.
function defaultOutput(fields, opts = {}) {
  const allBinary = fields.length > 0 && fields.every((f) => f.type === "binary");
  if (opts.style === "named" || (!allBinary && opts.style !== "index_array")) {
    return namedFieldsOutput(fields, { justificationInMain: !!opts.justificationInMain, justificationProperty: opts.justificationProperty || "reasoning" });
  }
  if (!allBinary) throw new Error("The index-array output can only express binary fields");
  return indexArrayOutput(fields, !!opts.justificationInMain);
}

const EDITABLE = ["name", "fields", "prompt", "output", "target", "generator", "method", "pricing", "logging"];
const LOCKED_AFTER_BASELINE = ["fields", "prompt", "output", "target"];

function hasBaseline(id) {
  const cp = store.loadCheckpoint(id);
  return !!(cp && cp.basePrompt);
}

function applyPatch(project, patch) {
  const baseline = hasBaseline(project.id);
  for (const key of Object.keys(patch || {})) {
    if (!EDITABLE.includes(key)) throw new Error(`Cannot edit ${key}`);
    if (baseline && LOCKED_AFTER_BASELINE.includes(key) && JSON.stringify(project[key]) !== JSON.stringify(patch[key])) {
      throw new Error(`The run already has a baseline — ${key} is locked. Fork the project to change it.`);
    }
  }
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "method" && value) {
      if (value.metaTemplate) parseTemplate(value.metaTemplate); // throws on malformed sections
      project.method = Object.assign({}, project.method, value, { toggles: Object.assign({}, project.method.toggles, value.toggles || {}) });
      if (value.metaTemplate === "" || (value.metaTemplate && value.metaTemplate === method.ORIGINAL_META_TEMPLATE)) project.method.metaTemplate = null;
    } else if ((key === "target" || key === "generator") && value) {
      project[key] = Object.assign({}, project[key], value);
      if (value.media) project[key].media = Object.assign({}, project[key].media, value.media);
    } else project[key] = value;
  }
  if (project.state === "validated" || project.state === "dataset_ready" || project.state === "configured") {
    project.state = project.dataset && project.dataset.datasetSha ? "configured" : "draft";
  }
  return project;
}

// Hints for the config screen: places where the original meta-prompt wording may not fit this project.
function metaTemplateHints(project) {
  if (project.method && project.method.metaTemplate) return [];
  const hints = [];
  const items = store.readManifest(project.id);
  if (!items.length) return hints;
  const kinds = new Set(items.flatMap((i) => (i.input.files || []).map((f) => f.kind)));
  if (items.some((i) => typeof i.input.text === "string")) kinds.add("text");
  const gridVideo = kinds.has("video") && project.target.media && project.target.media.video && project.target.media.video.mode === "grid";
  if (!(kinds.has("image") || gridVideo) || kinds.has("text")) hints.push("The original wording says the model analyzes \"2x2 grids of 4 consecutive indoor camera frames from a senior care facility\" — your inputs are different.");
  if (project.output && project.output.style !== "index_array") hints.push("The original wording describes the output as {\"b\": integer[]} condition indices — your output schema uses named fields.");
  if ((project.fields || []).some((f) => f.type !== "binary")) hints.push("Some fields are not binary; the wrong-prediction block prints their values instead of 1/0.");
  return hints;
}

function validateForRun(project) {
  const errors = [];
  if (!project.dataset || !project.dataset.datasetSha) errors.push("Import and commit a dataset");
  if (!project.fields || project.fields.length === 0) errors.push("The dataset has no labelled fields");
  if (!project.prompt || !project.prompt.base || !project.prompt.base.trim()) errors.push("Add a base prompt");
  if (!project.output || !project.output.mapping) errors.push("Choose an output schema");
  if (!project.target.connectionId || !project.target.model) errors.push("Choose a candidate connection and model");
  if (!project.generator.connectionId || !project.generator.model) errors.push("Choose a generator connection and model");
  if (project.output && project.output.mapping) {
    for (const f of project.fields || []) if (!project.output.mapping[f.key]) errors.push(`Output mapping missing for field ${f.key}`);
  }
  if (project.method && project.method.metaTemplate) {
    try { parseTemplate(project.method.metaTemplate); } catch (e) { errors.push(`Meta-prompt template: ${e.message}`); }
  }
  return errors;
}

// ─── preflight ───
async function preflight(project, connections, onProgress) {
  const report = { startedAt: new Date().toISOString(), configSha: store.configSha(project), checks: [], dryRun: [], estimate: null, ok: false };
  const add = (name, ok, detail, level) => report.checks.push({ name, ok, level: level || (ok ? "ok" : "error"), detail });
  const errs = validateForRun(project);
  for (const e of errs) add("Configuration", false, e);
  if (errs.length) return report;

  const items = store.readManifest(project.id);
  const excluded = new Set(store.readJSON(path.join(store.projectDir(project.id), "exclusions.json"), []));
  const train = items.filter((i) => i.split === "train" && !excluded.has(i.id));
  const test = items.filter((i) => i.split === "test" && !excluded.has(i.id));
  add("Dataset", train.length > 0, `${train.length} train / ${test.length} test items, ${project.fields.length} fields`);
  const sha = store.fileSha(store.manifestPath(project.id));
  if (sha !== project.dataset.datasetSha) add("Dataset", false, "manifest changed since commit — re-commit the dataset");

  // capabilities vs inputs
  const tConn = connections.target, gConn = connections.generator;
  let tProv, gProv;
  try { tProv = createProvider(tConn, project.target); } catch (e) { add("Candidate connection", false, e.message); }
  try { gProv = createProvider(gConn, project.generator); } catch (e) { add("Generator connection", false, e.message); }
  if (!tProv || !gProv) return report;
  // preflight calls are real API calls: log them like run calls (types PREFLIGHT_*)
  const apiLog = new ApiLog(store.runPaths(project.id).api, (project.logging && project.logging.apiLog) || "compact",
    makeRedactor([...connectionsLib.secretValues(tConn), ...connectionsLib.secretValues(gConn)]));
  const caps = tProv.capabilities(project.target.model);
  const kinds = new Set(items.flatMap((i) => (i.input.files || []).map((f) => f.kind)));
  const vmode = project.target.media && project.target.media.video && project.target.media.video.mode;
  if (kinds.has("video") && vmode === "native" && !caps.video) add("Inputs", false, `${tConn.type} ${project.target.model} cannot take video — set Video to "frame grid" on the candidate harness`);
  if (kinds.has("video") && vmode !== "native") {
    const { which } = require("./media");
    add("Inputs", !!which("ffmpeg"), which("ffmpeg") ? "videos will be converted to frame grids during initialization" : "ffmpeg is required for frame grids (brew install ffmpeg)");
  }
  if (kinds.has("audio") && !caps.audio) add("Inputs", false, `${tConn.type} cannot take audio input`);
  if (kinds.has("pdf") && !caps.pdf) add("Inputs", false, `${tConn.type} cannot take PDF input`);
  if (caps.temperature === "omit" && project.target.temperature !== null && project.target.temperature !== undefined) {
    add("Candidate temperature", true, `${project.target.model} does not accept a temperature — the provider default is used`, "warn");
  }
  for (const h of metaTemplateHints(project)) add("Meta-prompt (original wording)", true, h, "warn");

  // generator: tiny call
  onProgress && onProgress({ label: "Checking the generator model" });
  const gH = new Harness("generator", Object.assign({}, project.generator, { concurrency: 1 }), gConn, { apiLog, stepRef: () => "preflight", policy: { persistentErrorPolicy: "attention", persistentErrorLimit: 1, parseRetryLimit: 1 }, sleep: async () => {} });
  try {
    const r = await withTimeout(gH.call({ system: null, parts: [{ text: "Reply with the single word OK." }], maxOutputTokens: project.generator.smokeMaxTokens || 2048, stream: false }, { kind: "PREFLIGHT_GENERATOR" }), 120000);
    add("Generator model", true, `${gConn.type} ${project.generator.model} answered (${(r.text || "").trim().slice(0, 40) || "empty text"})`);
  } catch (e) { add("Generator model", false, `${gConn.type} ${project.generator.model}: ${String(e.message || e).slice(0, 300)}`); }

  // candidate: dry run on up to 3 train items (one per field where possible)
  const picks = [];
  for (const f of project.fields) {
    const it = train.find((i) => f.key in i.labels && !picks.includes(i));
    if (it) picks.push(it);
    if (picks.length >= 3) break;
  }
  for (const it of train) { if (picks.length >= 3) break; if (!picks.includes(it)) picks.push(it); }
  const media = new MediaPipeline(store.projectDir(project.id), project.target.media || {});
  const tH = new Harness("target", Object.assign({}, project.target, { concurrency: 3 }), tConn, { apiLog, stepRef: () => "preflight", policy: { persistentErrorPolicy: "attention", persistentErrorLimit: 1, parseRetryLimit: 2 }, sleep: async () => {} });
  const mappings = {};
  for (const f of project.fields) mappings[f.key] = project.output.mapping[f.key];
  const fallback = project.output.style === "index_array" ? { s: "", b: [] } : {};
  let usageIn = 0, usageOut = 0, n = 0;
  for (const it of picks) {
    onProgress && onProgress({ label: `Dry run ${n + 1}/${picks.length}` });
    const row = { itemId: it.id, expected: it.labels };
    try {
      const { parts, vars } = await media.partsFor(it);
      const sys = renderItemPrompt(project.prompt.base, project.prompt, vars);
      const unresolved = placeholdersIn(sys);
      if (unresolved.length && project.prompt.placeholders) row.warning = `unresolved placeholders: ${unresolved.map((x) => `{{${x}}}`).join(", ")}`;
      const res = await withTimeout(tH.call({ system: sys, parts, schema: project.output.jsonSchema, nativeSchema: project.output.nativeSchema || null, trace: { itemId: it.id } }, { kind: "PREFLIGHT_TARGET", itemId: it.id }), 180000);
      const ex = extractJSON(res.text || "", fallback);
      row.raw = (res.text || "").slice(0, 4000);
      row.parsed = ex.parsed ? ex.value : null;
      row.structured = res.structured;
      const counters = scoring.newCounters(project.fields);
      const sc = scoring.scoreItem(project.fields, mappings, it, ex.value || {}, counters);
      row.predicted = sc.predicted;
      row.ok = ex.parsed && scoring.outputHasMappedPaths(project.fields.filter((f) => f.key in it.labels), mappings, ex.value);
      usageIn += (res.usage && res.usage.inputTokens) || 0;
      usageOut += (res.usage && res.usage.outputTokens) || 0;
      n++;
    } catch (e) { row.error = String(e.message || e).slice(0, 500); row.ok = false; }
    report.dryRun.push(row);
  }
  const okRows = report.dryRun.filter((r) => r.ok).length;
  add("Candidate model + output schema", okRows === report.dryRun.length && report.dryRun.length > 0,
    okRows === report.dryRun.length ? `${tConn.type} ${project.target.model} returned parseable output for ${okRows}/${report.dryRun.length} items` : `${report.dryRun.length - okRows} of ${report.dryRun.length} dry-run items failed — see the dry run table`);
  if (provHasLearned(tProv)) report.learned = tProv.learnedState();

  // estimate
  const perIn = n ? usageIn / n : null, perOut = n ? usageOut / n : null;
  const c = project.method.candidatesPerStep || 3;
  const baseChars = project.prompt.base.length;
  report.estimate = {
    trainItems: train.length, testItems: test.length, perCall: { inputTokens: perIn, outputTokens: perOut },
    baseline: { calls: train.length, inputTokens: perIn !== null ? Math.round(perIn * train.length) : null },
    perStep: { targetCalls: c * train.length, generatorCalls: 1, inputTokens: perIn !== null ? Math.round(perIn * c * train.length) : null, outputTokens: perOut !== null ? Math.round(perOut * c * train.length) : null },
    justificationCallsMax: train.length,
    metaPromptTokensStep1: Math.round((baseChars * 2 + 4000) / 4),
    metaPromptGrowthPerStepTokens: Math.round((baseChars * c) / 4),
    // the generator writes c full prompts per step; thinking models add reasoning tokens on top
    generatorVisibleOutputTokensPerStep: Math.round((baseChars * c) / 4),
    notes: [
      "Candidate input per call is measured with the base prompt; generated prompts can be shorter or longer.",
      "Generator output is at least the visible text of the candidates; thinking/reasoning models add billed tokens on top, often several times more, and it varies per step.",
    ],
  };
  const pr = project.pricing && project.pricing.target;
  if (pr && report.estimate.perStep.inputTokens !== null) {
    report.estimate.perStep.usd = (report.estimate.perStep.inputTokens / 1e6) * (pr.inPerM || 0) + (report.estimate.perStep.outputTokens / 1e6) * (pr.outPerM || 0);
  }
  await apiLog.flush();
  report.ok = report.checks.every((ch) => ch.ok);
  report.finishedAt = new Date().toISOString();
  return report;
}

function provHasLearned(p) { return p && typeof p.learnedState === "function"; }

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { newProject, defaultOutput, applyPatch, validateForRun, preflight, metaTemplateHints, hasBaseline, LOCKED_AFTER_BASELINE };
