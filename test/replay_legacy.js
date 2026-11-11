#!/usr/bin/env node
// replay_legacy.js — rebuild every meta-prompt stored in an ORIGINAL run's checkpoint and diff it
// byte-for-byte against what was actually sent. Inputs are read-only.
//
//   node test/replay_legacy.js <checkpoint.json> [runner.js]
//
// For each stored metaPromptHistory step s, the state before s is replayed from promptHistory:
// history = entries with step < s; best = greedy strict-> acceptance in history order; wrongs = latest
// entry whose prompt === best prompt. The meta-prompt is rebuilt twice — with the verbatim original
// function (oracle) and with lib/method.js — and both are compared with the stored text. A mismatch the
// oracle shares is engine-version drift or later edits to the checkpoint, not a porting error.
"use strict";

const fs = require("fs");
const path = require("path");
const { loadLegacyEngine } = require("./legacy/legacy_ref");
const { tmpDir } = require("./helpers");
const method = require("../lib/method");
const scoring = require("../lib/scoring");
const legacy = require("../lib/presets/legacy");

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { at: i, expected: JSON.stringify(b.slice(Math.max(0, i - 60), i + 80)), actual: JSON.stringify(a.slice(Math.max(0, i - 60), i + 80)) };
}

function main() {
  const [cpPath, runnerPath] = process.argv.slice(2);
  if (!cpPath) { console.error("usage: node test/replay_legacy.js <checkpoint.json> [runner.js]"); process.exit(2); }
  const cp = JSON.parse(fs.readFileSync(cpPath, "utf8"));
  const category = cp.category;
  let fields;
  if (runnerPath) {
    fields = legacy.importLegacyRunner(runnerPath).fields;
  } else {
    // Field order = key order of the stored per-field metrics (written in CONFIG.fields order);
    // bIdx from stored wrong predictions, else position.
    const keys = Object.keys(cp.bestPerFieldMetrics || cp.promptHistory[0].perFieldMetrics);
    const bIdx = {};
    for (const e of cp.promptHistory) for (const w of e.wrongPredictions || []) if (w.bIdx !== undefined) bIdx[w.fieldKey] = w.bIdx;
    fields = keys.map((k, i) => ({ key: k, bIdx: bIdx[k] !== undefined ? bIdx[k] : i, desc: "" }));
  }
  const hasSummary = category === "alerts";
  const dir = tmpDir("wpo-replay-");
  const { api } = loadLegacyEngine({ categoryName: category, port: 0, checkpointPath: path.join(dir, "cp.json"), logFile: "l", pauseFile: "p", fields }, { dir, noMain: true });
  const newFields = fields.map((f) => ({ key: f.key, index: f.bIdx, type: "binary" }));
  const history = cp.promptHistory;
  const stored = cp.metaPromptHistory || [];

  const report = { checkpoint: cpPath, category, fields: fields.length, historyEntries: history.length, storedMetaPrompts: stored.length, compared: 0, newIdentical: 0, oracleIdentical: 0, newEqualsOracle: 0, mismatches: [] };
  for (const mp of stored) {
    const s = mp.step;
    const before = history.filter((e) => e.step < s);
    if (before.length === 0) continue;
    let best = before[0];
    let t = 1;
    const stepsSeen = [...new Set(before.map((e) => e.step))].filter((x) => x > 0).sort((a, b) => a - b);
    for (t of stepsSeen) {
      const cands = before.filter((e) => e.step === t);
      const w = method.pickWinner(cands.map((c) => c.accuracy), best.accuracy);
      if (w >= 0) best = cands[w];
    }
    const wrongs = method.wrongsForMeta(before, { prompt: best.prompt }, "prompt");
    api.setLiveCp({ bestPerFieldMetrics: best.perFieldMetrics });
    const oracle = api.buildWPOMetaPrompt(best.prompt, best.accuracy, wrongs, before, s === 1);
    const ours = method.buildMetaPrompt({
      fields: newFields, hasSummary, bestPrompt: best.prompt, bestAccuracy: best.accuracy, bestMetrics: best.perFieldMetrics,
      wrongs, history: before, isFirstStep: s === 1, candidatesPerStep: 3, targets: { tpr: 80, tnr: 80 },
    });
    report.compared++;
    if (ours === mp.metaPrompt) report.newIdentical++;
    if (oracle === mp.metaPrompt) report.oracleIdentical++;
    if (ours === oracle) report.newEqualsOracle++;
    if (ours !== mp.metaPrompt) {
      report.mismatches.push({ step: s, oracleAlsoMismatches: oracle !== mp.metaPrompt, ...firstDiff(ours, mp.metaPrompt) });
    }
  }

  // Metrics recompute: stored bestImageResults → per-field TPR/TNR + overall vs stored best metrics.
  if (Array.isArray(cp.bestImageResults) && cp.bestImageResults.length) {
    const counters = scoring.newCounters(newFields);
    const byKey = new Map(newFields.map((f) => [f.key, f]));
    for (const ir of cp.bestImageResults) {
      const f = byKey.get(ir.fieldKey);
      if (!f) continue;
      scoring.scoreItem(newFields, { [f.key]: { path: "b", op: "contains", value: f.index } }, { labels: { [f.key]: ir.polarity === "pos" } }, { b: ir.detectedB }, counters);
    }
    const fin = scoring.finalizeMetrics(newFields, counters);
    const diffs = [];
    for (const f of newFields) {
      const st = cp.bestPerFieldMetrics[f.key];
      const m = fin.perField[f.key];
      if (!st || !Object.is(st.tpr, m.tpr) || !Object.is(st.tnr, m.tnr)) diffs.push({ field: f.key, stored: st, recomputed: { tpr: m.tpr, tnr: m.tnr, pos: m.posCount, neg: m.negCount } });
    }
    report.metrics = { items: cp.bestImageResults.length, storedBest: cp.bestAccuracy, recomputed: fin.overallAccuracy, identical: Object.is(fin.overallAccuracy, cp.bestAccuracy) && diffs.length === 0, fieldDiffs: diffs };
  }
  console.log(JSON.stringify(report, null, 2));
}

main();
