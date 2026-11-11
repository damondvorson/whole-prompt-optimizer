// method.js — the optimisation method's pure pieces (no I/O).
// Ported from wpo_video_engine.js: buildWPOMetaPrompt / formatPerFieldMetricsBlock (648–698, 436–445),
// extractPromptCandidates (423–434), the wrongsForMeta lookup (1276–1282) and candidate acceptance
// (1333–1359). With the default template and default toggles the output is byte-identical to the
// original — test/legacy.test.js checks this against the verbatim original source.
"use strict";

const { renderTemplate, parseTemplate } = require("./template");

// The original meta-prompt, verbatim, expressed as a template. Only {{slots}} are computed.
// Do not edit: projects override it via method.metaTemplate (config screen), never by changing this.
const ORIGINAL_META_TEMPLATE =
`TASK: You are optimizing a complete system prompt for a vision-language model that analyzes 2x2 grids of 4 consecutive indoor camera frames from a senior care facility.

The model receives a 2x2 grid image (4 frames at 840x480 each, composited into 1680x960) and the system prompt.
{{#has_summary}}It outputs JSON: {"s": "...", "b": integer[]} where "s" is a natural language summary and "b" contains indices of detected conditions.
{{/has_summary}}{{^has_summary}}It outputs JSON: {"b": integer[]} where "b" contains indices of detected conditions.
{{/has_summary}}There are {{field_count}} condition indices (0-{{max_index}}).

=== BEST PERFORMING PROMPT (accuracy: {{best_accuracy}}%) ===
{{#field_metrics}}  {{pass}} b[{{index}}] {{key}}: {{metrics}}
{{/field_metrics}}<PROMPT>
{{best_prompt}}
</PROMPT>

=== WRONG PREDICTIONS ===
{{^wrong_predictions}}(none)
{{/wrong_predictions}}{{#wrong_predictions}}Image: {{item_id}} | Field: b[{{index}}] ({{field_key}})
Expected: {{expected}} | Actual: {{actual}}
{{#justification}}VLM Justification: "{{justification}}"
{{/justification}}
{{/wrong_predictions}}
{{#show_history}}=== PROMPT HISTORY ===
{{#history}}Step {{step}}: accuracy={{accuracy}}%
<PROMPT>
{{prompt}}
</PROMPT>

{{/history}}{{/show_history}}=== GENERATION DIRECTIVE ===
Generate {{candidates_per_step}} new COMPLETE system prompts{{#show_history}} different from all prompts shown in the history above{{/show_history}} that aim to achieve higher accuracy than {{best_accuracy}}%.

Each prompt MUST:
- Contain ALL {{field_count}} field definitions (indices 0-{{max_index}})
- Be a complete, self-contained system prompt
- Focus on clarifying the specific confusions shown in the wrong predictions above
- The prompt should be concise, effective, and generally applicable to all problems above.

Wrap each complete prompt in <PROMPT>...</PROMPT> tags.
`;

// Slots available to (edited) templates — shown on the config screen.
const META_SLOTS = {
  has_summary: "true when the candidate output schema includes the summary/justification property (original: alerts)",
  field_count: "number of fields",
  max_index: "field_count - 1",
  best_accuracy: "current best overall accuracy, 1 decimal",
  field_metrics: "section: one entry per field with metrics {pass, index, key, metrics}",
  best_prompt: "current best prompt",
  wrong_predictions: "section: wrong predictions of the best prompt {item_id, index, field_key, expected, actual, justification}",
  show_history: "true from step 2 on when history exists",
  history: "section: every prior candidate {step, accuracy, prompt}",
  candidates_per_step: "candidates requested per step",
};

let _originalAst = null;
function originalAst() {
  if (!_originalAst) _originalAst = parseTemplate(ORIGINAL_META_TEMPLATE);
  return _originalAst;
}

const DEFAULT_TARGETS = { tpr: 80, tnr: 80, score: 80 };

function fieldTargets(field, targets) {
  const t = Object.assign({}, DEFAULT_TARGETS, targets || {}, (field && field.target) || {});
  return t;
}

// Pass/fail exactly as the original for binary fields: tpr >= 80 && tnr >= 80.
function fieldPasses(field, m, targets) {
  if (!m) return false;
  const t = fieldTargets(field, targets);
  const type = (field && field.type) || "binary";
  if (type === "binary") return m.tpr >= t.tpr && m.tnr >= t.tnr;
  if (type === "categorical") {
    const recalls = m.perClass ? Object.values(m.perClass).map((c) => c.recall) : [];
    return recalls.length > 0 ? recalls.every((r) => r >= t.score) : m.score >= t.score;
  }
  return m.score >= t.score;
}

function metricText(field, m) {
  const type = (field && field.type) || "binary";
  if (type === "binary") return `TPR=${m.tpr.toFixed(1)}% TNR=${m.tnr.toFixed(1)}%`;
  if (type === "categorical") {
    const parts = Object.entries(m.perClass || {}).map(([cls, c]) => `${cls}=${c.recall.toFixed(1)}%`);
    return `score=${m.score.toFixed(1)}%` + (parts.length ? ` (recall ${parts.join(" ")})` : "");
  }
  return `accuracy=${m.score.toFixed(1)}%`;
}

// Same lines as formatPerFieldMetricsBlock: "  ✓ b[i] key: TPR=..% TNR=..%\n", fields without metrics skipped.
function fieldMetricEntries(fields, metrics, targets) {
  const out = [];
  for (const f of fields) {
    const m = metrics && metrics[f.key];
    if (!m) continue;
    out.push({ pass: fieldPasses(f, m, targets) ? "✓" : "✗", index: f.index, key: f.key, metrics: metricText(f, m) });
  }
  return out;
}

function formatValue(field, v) {
  const type = (field && field.type) || "binary";
  if (type === "binary") return v ? 1 : 0;
  if (v === null || v === undefined) return "null";
  if (type === "text") return JSON.stringify(String(v));
  return String(v);
}

function buildMetaContext(opts) {
  const {
    fields, hasSummary, bestPrompt, bestAccuracy, bestMetrics, wrongs, history,
    isFirstStep, candidatesPerStep, targets,
  } = opts;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const showHistory = !isFirstStep && history.length > 0;
  return {
    has_summary: !!hasSummary,
    field_count: fields.length,
    max_index: fields.length - 1,
    best_accuracy: bestAccuracy.toFixed(1),
    field_metrics: fieldMetricEntries(fields, bestMetrics, targets),
    best_prompt: bestPrompt,
    wrong_predictions: (wrongs || []).map((wp) => {
      const f = byKey.get(wp.fieldKey);
      return {
        item_id: wp.imageId,
        index: wp.bIdx,
        field_key: wp.fieldKey,
        expected: formatValue(f, wp.expected),
        actual: formatValue(f, wp.actual),
        justification: wp.justification || "",
      };
    }),
    show_history: showHistory,
    history: showHistory ? history.map((e) => ({ step: e.step, accuracy: e.accuracy.toFixed(1), prompt: e.prompt })) : [],
    candidates_per_step: candidatesPerStep,
  };
}

// historyWindow: 0/null = all entries (original). N = entries from the last N steps (baseline kept).
function windowHistory(history, currentStep, historyWindow) {
  if (!historyWindow || historyWindow <= 0) return history;
  const minStep = currentStep - historyWindow;
  return history.filter((e) => e.step === 0 || e.step >= minStep);
}

function buildMetaPrompt(opts) {
  const template = opts.template;
  const ctx = buildMetaContext(opts);
  return renderTemplate(template ? template : originalAst(), ctx);
}

// extractPromptCandidates (original 423–434) + optional dedupe / cap toggles (off by default).
function extractPromptCandidates(text, opts = {}) {
  const minChars = opts.minChars != null ? opts.minChars : 200;
  const candidates = [];
  const regex = /<PROMPT(?:\s[^>]*)?>([\s\S]*?)<\/PROMPT>/gi;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const prompt = m[1].trim();
    if (prompt.length >= minChars) candidates.push(prompt);
  }
  let out = candidates;
  if (opts.dedupe) out = out.filter((p, i) => out.indexOf(p) === i);
  if (opts.maxCandidates && opts.maxCandidates > 0) out = out.slice(0, opts.maxCandidates);
  return out;
}

// Which history entry supplies the wrong predictions for the next meta-prompt (original 1276–1282).
function wrongsForMeta(history, best, matchBestBy) {
  for (let hi = history.length - 1; hi >= 0; hi--) {
    const e = history[hi];
    const match = matchBestBy === "id" ? (best.entryId != null && e.id === best.entryId) : e.prompt === best.prompt;
    if (match && Array.isArray(e.wrongPredictions)) return e.wrongPredictions;
  }
  return [];
}

// Earliest candidate with accuracy strictly greater than the running best wins (original 1333–1359).
function pickWinner(accuracies, currentBest) {
  let winner = -1;
  let bestAcc = currentBest;
  for (let i = 0; i < accuracies.length; i++) {
    if (accuracies[i] > bestAcc) { winner = i; bestAcc = accuracies[i]; }
  }
  return winner;
}

function placeholdersDropped(candidate, basePlaceholders) {
  return basePlaceholders.filter((name) => !candidate.includes(`{{${name}}}`) && !new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`).test(candidate));
}

module.exports = {
  ORIGINAL_META_TEMPLATE, META_SLOTS, DEFAULT_TARGETS,
  buildMetaPrompt, buildMetaContext, windowHistory,
  fieldMetricEntries, fieldPasses, metricText, formatValue, fieldTargets,
  extractPromptCandidates, wrongsForMeta, pickWinner, placeholdersDropped,
};
