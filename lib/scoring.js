// scoring.js — map model output to field values, compare with labels, aggregate metrics.
// Binary fields reproduce wpo_video_engine.js evaluatePrompt (503–581) exactly, including the float
// operation order: tpr = (tp / posCount) * 100 (100 when no positives), overall = Σ (tpr+tnr)/2 in field
// order ÷ field count. Other types generalise the same idea (score per field, mean over fields).
"use strict";

const { getPath, hasPath } = require("./template");

const DEFAULT_POSITIVE = ["true", "1", "yes", "y", "positive", "pos", "t"];

function normText(v, normalize) {
  let s = String(v);
  const n = Object.assign({ case: true, whitespace: true, punct: false }, normalize || {});
  if (n.whitespace) s = s.replace(/\s+/g, " ").trim();
  if (n.case) s = s.toLowerCase();
  if (n.punct) s = s.replace(/[\p{P}\p{S}]/gu, "").replace(/\s+/g, " ").trim();
  return s;
}

// Label normalisation at import time (manifest strings → typed values). Blank → undefined (unlabelled).
function normalizeLabel(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  switch (field.type) {
    case "binary": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "number") return raw !== 0;
      const pos = (field.positiveValues && field.positiveValues.length ? field.positiveValues : DEFAULT_POSITIVE)
        .map((x) => String(x).trim().toLowerCase());
      return pos.includes(String(raw).trim().toLowerCase());
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : undefined;
    }
    case "categorical":
      return String(raw).trim();
    default:
      return String(raw);
  }
}

// Model output → predicted value for one field, via its mapping {path, op, value, map}.
//   op "contains": predicted = Array at path contains `value` (Set.has — same as the original's
//                  new Set(result.b).has(bIdx), no type coercion)
//   op "value":    predicted = value at path (coerced per field type; optional value map)
function predictValue(field, mapping, output) {
  const op = (mapping && mapping.op) || "value";
  const path = mapping && mapping.path != null ? mapping.path : field.key;
  if (op === "contains") {
    const arr = getPath(output, path);
    return new Set(Array.isArray(arr) ? arr : []).has(mapping.value);
  }
  let v = getPath(output, path);
  if (mapping && mapping.map && v !== undefined && v !== null && Object.prototype.hasOwnProperty.call(mapping.map, String(v))) {
    v = mapping.map[String(v)];
  }
  switch (field.type) {
    case "binary":
      if (typeof v === "boolean") return v;
      if (typeof v === "number") return v !== 0;
      if (typeof v === "string") {
        const pos = (field.positiveValues && field.positiveValues.length ? field.positiveValues : DEFAULT_POSITIVE)
          .map((x) => String(x).trim().toLowerCase());
        return pos.includes(v.trim().toLowerCase());
      }
      return false;
    case "number": {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "number" ? v : Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "categorical":
    case "text":
      return v === null || v === undefined ? null : (typeof v === "object" ? JSON.stringify(v) : String(v));
    default:
      return v === undefined ? null : v;
  }
}

function valuesMatch(field, expected, predicted) {
  switch (field.type) {
    case "binary": return predicted === expected;
    case "number": {
      if (predicted === null || predicted === undefined) return false;
      return Math.abs(predicted - expected) <= (field.tolerance || 0);
    }
    case "categorical":
    case "text":
      if (predicted === null || predicted === undefined) return false;
      return normText(predicted, field.normalize) === normText(expected, field.normalize);
    default:
      return predicted === expected;
  }
}

// Does the parsed output contain every path the field mappings read? (The original retried when the
// JSON had no array "b" — this is that check, generalised; justification-only keys are not required.)
function outputHasMappedPaths(fields, mappings, output) {
  if (output === null || typeof output !== "object") return false;
  for (const f of fields) {
    const m = mappings[f.key] || { op: "value", path: f.key };
    const path = m.path != null ? m.path : f.key;
    if (m.op === "contains") {
      if (!Array.isArray(getPath(output, path))) return false;
    } else if (!hasPath(output, path)) return false;
  }
  return true;
}

function newFieldCounter(field) {
  switch (field.type) {
    case "binary": return { tp: 0, fn: 0, tn: 0, fp: 0, tpr: 0, tnr: 0, posCount: 0, negCount: 0 };
    case "categorical": return { perClass: {}, correct: 0, total: 0 };
    default: return { correct: 0, total: 0 };
  }
}

// Score one item: returns wrongFields and per-field predicted values; mutates the counters.
function scoreItem(fields, mappings, item, output, counters) {
  const predicted = {};
  const wrongFields = [];
  for (const f of fields) {
    if (!item.labels || !Object.prototype.hasOwnProperty.call(item.labels, f.key)) continue;
    const expected = item.labels[f.key];
    if (expected === undefined) continue;
    const p = predictValue(f, mappings[f.key], output);
    predicted[f.key] = p;
    const c = counters[f.key];
    if (f.type === "binary") {
      if (expected) {
        c.posCount++;
        if (p) c.tp++;
        else { c.fn++; wrongFields.push({ fieldKey: f.key, bIdx: f.index, expected: true, actual: false }); }
      } else {
        c.negCount++;
        if (!p) c.tn++;
        else { c.fp++; wrongFields.push({ fieldKey: f.key, bIdx: f.index, expected: false, actual: true }); }
      }
    } else {
      const ok = valuesMatch(f, expected, p);
      c.total++;
      if (ok) c.correct++;
      else wrongFields.push({ fieldKey: f.key, bIdx: f.index, expected, actual: p });
      if (f.type === "categorical") {
        const cls = normText(expected, f.normalize);
        const pc = c.perClass[cls] || (c.perClass[cls] = { label: String(expected), correct: 0, total: 0 });
        pc.total++;
        if (ok) pc.correct++;
      }
    }
  }
  return { predicted, wrongFields };
}

// Finalise counters → per-field metrics and the overall accuracy.
//   absentFieldScore: 100 (original — a field with no examples scores 100) | "exclude" (left out of the mean)
function finalizeMetrics(fields, counters, opts = {}) {
  const absent = opts.absentFieldScore === undefined ? 100 : opts.absentFieldScore;
  const perField = {};
  for (const f of fields) {
    const c = counters[f.key];
    if (f.type === "binary") {
      c.tpr = c.posCount > 0 ? (c.tp / c.posCount) * 100 : 100;
      c.tnr = c.negCount > 0 ? (c.tn / c.negCount) * 100 : 100;
      c.score = (c.tpr + c.tnr) / 2;
      c.n = c.posCount + c.negCount;
      perField[f.key] = c;
    } else if (f.type === "categorical") {
      const classes = (f.classes && f.classes.length ? f.classes : Object.values(c.perClass).map((x) => x.label));
      const perClass = {};
      let sum = 0;
      for (const cls of classes) {
        const pc = c.perClass[normText(cls, f.normalize)];
        const recall = pc && pc.total > 0 ? (pc.correct / pc.total) * 100 : 100;
        perClass[cls] = { correct: pc ? pc.correct : 0, total: pc ? pc.total : 0, recall };
        sum += recall;
      }
      perField[f.key] = {
        perClass, correct: c.correct, total: c.total, n: c.total,
        score: classes.length > 0 ? sum / classes.length : 100,
      };
    } else {
      perField[f.key] = {
        correct: c.correct, total: c.total, n: c.total,
        score: c.total > 0 ? (c.correct / c.total) * 100 : 100,
      };
    }
  }
  let totalFieldAvg = 0;
  let counted = 0;
  for (const f of fields) {
    const m = perField[f.key];
    if (absent === "exclude" && m.n === 0) continue;
    totalFieldAvg += f.type === "binary" ? (m.tpr + m.tnr) / 2 : m.score;
    counted++;
  }
  const denom = absent === "exclude" ? counted : fields.length;
  const overallAccuracy = denom > 0 ? totalFieldAvg / denom : 0;
  return { perField, overallAccuracy };
}

// Compact per-field metrics as stored in history / best (original stored {tpr, tnr} only).
function compactMetrics(fields, perField) {
  const out = {};
  for (const f of fields) {
    const m = perField[f.key];
    if (f.type === "binary") out[f.key] = { tpr: m.tpr, tnr: m.tnr };
    else if (f.type === "categorical") out[f.key] = { score: m.score, n: m.n, perClass: m.perClass };
    else out[f.key] = { score: m.score, n: m.n, correct: m.correct };
  }
  return out;
}

function newCounters(fields) {
  const c = {};
  for (const f of fields) c[f.key] = newFieldCounter(f);
  return c;
}

module.exports = {
  normalizeLabel, predictValue, valuesMatch, outputHasMappedPaths,
  newCounters, scoreItem, finalizeMetrics, compactMetrics, normText, DEFAULT_POSITIVE,
};
