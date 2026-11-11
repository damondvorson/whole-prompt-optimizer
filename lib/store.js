// store.js — project folders and run files.
//   projects/<id>/project.json      configuration (wizard state)
//   projects/<id>/manifest.jsonl    normalised items
//   projects/<id>/dataset/          imported files
//   projects/<id>/checkpoint.json   small run state (step, best, historyCount, …)
//   projects/<id>/history.jsonl     append-only history (written after each step; truncated to historyCount on load)
//   projects/<id>/steps/<n>.json    meta-prompt + generator output; steps/<n>.calls.jsonl = per-call journal
//   projects/<id>/results/<x>.json  per-item results (accepted entries, test evals)
//   projects/<id>/summary.json      small status for the dashboard
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROJECTS_DIR = process.env.WPO_PROJECTS_DIR || path.join(__dirname, "..", "projects");

function projectDir(id) {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(String(id))) throw new Error("bad project id");
  return path.join(PROJECTS_DIR, id);
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function slugify(name) {
  const base = String(name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  return `${base}-${crypto.randomBytes(3).toString("hex")}`;
}

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs.readdirSync(PROJECTS_DIR).filter((d) => fs.existsSync(path.join(PROJECTS_DIR, d, "project.json"))).map((id) => {
    const p = readJSON(path.join(PROJECTS_DIR, id, "project.json"), {});
    const s = readJSON(path.join(PROJECTS_DIR, id, "summary.json"), {});
    return { id, name: p.name, state: s.state || p.state || "draft", createdAt: p.createdAt, updatedAt: s.updatedAt || p.updatedAt, step: s.step, bestAccuracy: s.bestAccuracy, testAccuracy: s.testEval ? s.testEval.overallAccuracy : null, spend: s.spend };
  }).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
}

function loadProject(id) {
  const p = readJSON(path.join(projectDir(id), "project.json"), null);
  if (!p) throw new Error("Project not found");
  return p;
}

function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  writeAtomic(path.join(projectDir(project.id), "project.json"), JSON.stringify(project, null, 2));
  return project;
}

// ─── Manifest ───
function manifestPath(id) { return path.join(projectDir(id), "manifest.jsonl"); }
function writeManifest(id, items) {
  writeAtomic(manifestPath(id), items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
}
function readManifest(id) {
  try {
    return fs.readFileSync(manifestPath(id), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function fileSha(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

// Hash of the method-affecting configuration (edits after the baseline are flagged against this).
function configSha(project) {
  const pick = {
    fields: project.fields, prompt: project.prompt, output: project.output,
    target: project.target && { ...project.target, connectionId: undefined }, method: project.method && { ...project.method, stop: undefined },
  };
  return crypto.createHash("sha256").update(JSON.stringify(pick)).digest("hex").slice(0, 16);
}

// ─── Run files ───
function runPaths(id) {
  const d = projectDir(id);
  return {
    dir: d,
    checkpoint: path.join(d, "checkpoint.json"),
    history: path.join(d, "history.jsonl"),
    steps: path.join(d, "steps"),
    results: path.join(d, "results"),
    summary: path.join(d, "summary.json"),
    log: path.join(d, "run.log"),
    api: path.join(d, "api"),
    backups: path.join(d, "backups"),
    cache: path.join(d, "cache"),
    pause: path.join(d, "PAUSE"),
  };
}

function readHistory(id, limitCount) {
  const p = runPaths(id).history;
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const keep = limitCount != null ? lines.slice(0, limitCount) : lines;
  const out = [];
  for (const l of keep) { try { out.push(JSON.parse(l)); } catch { break; } }
  return out;
}

// Make history.jsonl exactly historyCount entries (drops entries of a step that crashed mid-write).
function truncateHistory(id, historyCount) {
  const entries = readHistory(id, historyCount);
  writeAtomic(runPaths(id).history, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
  return entries;
}

function appendHistory(id, entries) {
  if (!entries.length) return;
  fs.appendFileSync(runPaths(id).history, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function writeResults(id, name, data) {
  writeAtomic(path.join(runPaths(id).results, `${name}.json`), JSON.stringify(data));
}
function readResults(id, name) { return readJSON(path.join(runPaths(id).results, `${name}.json`), null); }

function writeStep(id, step, data) {
  writeAtomic(path.join(runPaths(id).steps, `${step}.json`), JSON.stringify(data));
}
function readStep(id, step) { return readJSON(path.join(runPaths(id).steps, `${step}.json`), null); }
function listSteps(id) {
  const d = runPaths(id).steps;
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map((f) => f.match(/^(\d+)\.json$/)).filter(Boolean).map((m) => Number(m[1])).sort((a, b) => a - b);
}

// Per-call journal for one step: lets a restart mid-step reuse the generator text and finished calls.
function journalPath(id, step) { return path.join(runPaths(id).steps, `${step}.calls.jsonl`); }
function readJournal(id, step) {
  const p = journalPath(id, step);
  const map = new Map();
  if (!fs.existsSync(p)) return map;
  for (const l of fs.readFileSync(p, "utf8").split("\n")) {
    if (!l) continue;
    try { const r = JSON.parse(l); map.set(r.k, r); } catch {}
  }
  return map;
}
function journalAppender(id, step) {
  const p = journalPath(id, step);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return (rec) => { try { fs.appendFileSync(p, JSON.stringify(rec) + "\n"); } catch {} };
}
function dropJournal(id, step) { try { fs.unlinkSync(journalPath(id, step)); } catch {} }

function saveCheckpoint(id, cp, opts = {}) {
  const paths = runPaths(id);
  const data = JSON.stringify(cp);
  writeAtomic(paths.checkpoint, data);
  try { fs.writeFileSync(paths.checkpoint + ".bak", data); } catch {}
  const every = opts.backupsEvery || 10;
  const step = cp.currentStep || 0;
  if (step > 0 && step % every === 0) {
    const bp = path.join(paths.backups, `step${step}.json`);
    if (!fs.existsSync(bp)) {
      try {
        fs.mkdirSync(paths.backups, { recursive: true });
        fs.writeFileSync(bp, data);
        const keep = opts.keepBackups || 20;
        const files = fs.readdirSync(paths.backups).filter((f) => /^step\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
        for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(paths.backups, f));
      } catch {}
    }
  }
}

function loadCheckpoint(id) {
  const p = runPaths(id).checkpoint;
  return readJSON(p, null) || readJSON(p + ".bak", null);
}

function writeSummary(id, summary) {
  writeAtomic(runPaths(id).summary, JSON.stringify(summary));
}
function readSummary(id) { return readJSON(runPaths(id).summary, null); }

// Legacy-shaped checkpoint (version 4 fields) for export / old tooling.
function exportLegacyCheckpoint(id) {
  const cp = loadCheckpoint(id);
  if (!cp) return null;
  const history = readHistory(id, cp.historyCount);
  const best = readResults(id, "best") || { itemResults: [] };
  const test = cp.testEval ? readResults(id, cp.testEval.resultsName || "test") : null;
  const steps = listSteps(id).slice(-50).map((s) => readStep(id, s)).filter(Boolean);
  return {
    version: 4, category: cp.category || "",
    currentStep: cp.currentStep, basePrompt: cp.basePrompt, bestPrompt: cp.best && cp.best.prompt,
    bestAccuracy: cp.best && cp.best.accuracy, bestPerFieldMetrics: cp.best && cp.best.perFieldMetrics,
    promptHistory: history.map((e) => ({ step: e.step, prompt: e.prompt, accuracy: e.accuracy, perFieldMetrics: e.perFieldMetrics, wrongPredictions: e.wrongPredictions, timestamp: e.timestamp })),
    staleSteps: cp.staleSteps, finalEval: null,
    bestImageResults: best.itemResults,
    metaPromptHistory: steps.map((s) => ({ step: s.step, metaPrompt: s.metaPrompt, sizeKB: s.sizeKB, timestamp: s.timestamp })),
    testEval: cp.testEval && test ? { timestamp: cp.testEval.timestamp, overallAccuracy: cp.testEval.overallAccuracy, perField: cp.testEval.perField, imageResults: test.itemResults } : undefined,
  };
}

module.exports = {
  PROJECTS_DIR, projectDir, writeAtomic, readJSON, slugify,
  listProjects, loadProject, saveProject, manifestPath, writeManifest, readManifest, fileSha, configSha,
  runPaths, readHistory, truncateHistory, appendHistory, writeResults, readResults,
  writeStep, readStep, listSteps, readJournal, journalAppender, dropJournal,
  saveCheckpoint, loadCheckpoint, writeSummary, readSummary, exportLegacyCheckpoint,
};
