// snapshot.js — self-contained HTML export of a run (no server needed to view it).
"use strict";

const fs = require("fs");
const path = require("path");
const store = require("./store");

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildSnapshot(id) {
  const p = store.loadProject(id);
  const s = store.readSummary(id) || {};
  const cp = store.loadCheckpoint(id) || {};
  const history = store.readHistory(id, cp.historyCount);
  const best = store.readResults(id, "best") || { itemResults: [] };
  const fields = p.fields || [];
  const rows = fields.map((f) => {
    const m = (cp.best && cp.best.perFieldMetrics && cp.best.perFieldMetrics[f.key]) || null;
    const t = (cp.testEval && cp.testEval.perField && cp.testEval.perField[f.key]) || null;
    const fmt = (x) => (!x ? "—" : f.type === "binary" ? `TPR ${x.tpr.toFixed(1)}% · TNR ${x.tnr.toFixed(1)}%` : `${x.score.toFixed(1)}%`);
    return `<tr><td>${esc(f.label || f.key)}</td><td>${esc(f.type)}</td><td>${esc(fmt(m))}</td><td>${esc(fmt(t))}</td></tr>`;
  }).join("");
  const hist = history.map((e) => `<details><summary>Step ${e.step}${e.kind === "baseline" ? " (baseline)" : ` · candidate ${e.candidateIndex + 1}`}: ${e.accuracy.toFixed(2)}%${e.accepted ? " — accepted" : ""}</summary><pre>${esc(e.prompt)}</pre></details>`).join("");
  const wrong = best.itemResults.filter((r) => r.wrongFields && r.wrongFields.length).slice(0, 300)
    .map((r) => `<tr><td>${esc(r.imageId)}</td><td>${esc(r.wrongFields.map((w) => `${w.fieldKey}: expected ${JSON.stringify(w.expected)}, got ${JSON.stringify(w.actual)}`).join("; "))}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>WPO snapshot — ${esc(p.name)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;max-width:1100px;color:#1d1d1f;background:#fafafa}
h1{font-size:22px}h2{font-size:17px;margin-top:28px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;padding:12px;border-radius:6px;font-size:12px}details{margin:4px 0}
@media (prefers-color-scheme:dark){body{background:#151517;color:#e8e8ea}pre{background:#1e1e22;border-color:#333}td,th{border-color:#333}}</style></head><body>
<h1>${esc(p.name)}</h1>
<p>Exported ${esc(new Date().toISOString())} · step ${esc(cp.currentStep || 0)} · best train accuracy ${cp.best ? cp.best.accuracy.toFixed(2) + "%" : "—"} · test ${cp.testEval ? cp.testEval.overallAccuracy.toFixed(2) + "%" : "—"}
· candidate ${esc(p.target.model)} · generator ${esc(p.generator.model)}</p>
<h2>Per-field metrics</h2><table><tr><th>Field</th><th>Type</th><th>Train (best)</th><th>Test</th></tr>${rows}</table>
<h2>Best prompt</h2><pre>${esc(cp.best ? cp.best.prompt : p.prompt.base)}</pre>
<h2>History</h2>${hist}
<h2>Wrong predictions of the best prompt (first 300)</h2><table>${wrong}</table>
</body></html>`;
}

module.exports = { buildSnapshot };
