// manifest.js — CSV/TSV/JSONL/JSON manifests: parsing, column-role guessing, items.
"use strict";

const { normalizeLabel } = require("../scoring");
const { splitFromWord, hashSplit } = require("./split");
const { kindOf, keyFromName } = require("./files");

// RFC-4180-ish CSV parser (quotes, doubled quotes, CR/LF, BOM). delimiter auto-detected (, ; tab |).
function parseDelimited(text, delimiter) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!delimiter) {
    const firstLine = text.split(/\r?\n/, 1)[0] || "";
    const counts = [",", "\t", ";", "|"].map((d) => [d, firstLine.split(d).length]);
    counts.sort((a, b) => b[1] - a[1]);
    delimiter = counts[0][1] > 1 ? counts[0][0] : ",";
  }
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === "") inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (!(row.length === 1 && row[0] === "")) rows.push(row); }
  if (rows.length === 0) return { columns: [], rows: [] };
  const columns = rows[0].map((h, i) => (h || `column_${i + 1}`).trim());
  const out = rows.slice(1).map((r) => {
    const o = {};
    columns.forEach((c, i) => { o[c] = r[i] !== undefined ? r[i] : ""; });
    return o;
  });
  return { columns, rows: out, delimiter };
}

function flattenRecord(rec, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(rec || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flattenRecord(v, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

function parseManifest(text, name) {
  const lower = (name || "").toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) {
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
      try { return flattenRecord(JSON.parse(l)); } catch { throw new Error(`Line ${i + 1} is not valid JSON`); }
    });
    return { columns: [...new Set(rows.flatMap((r) => Object.keys(r)))], rows };
  }
  if (lower.endsWith(".json")) {
    const data = JSON.parse(text);
    const arr = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : Array.isArray(data.data) ? data.data : null;
    if (!arr) throw new Error("JSON manifest must be an array of records (or {items:[...]})");
    const rows = arr.map((r) => flattenRecord(r));
    return { columns: [...new Set(rows.flatMap((r) => Object.keys(r)))], rows };
  }
  return parseDelimited(text, lower.endsWith(".tsv") ? "\t" : undefined);
}

const BINARY_VALUES = new Set(["0", "1", "true", "false", "yes", "no", "y", "n", "pos", "neg", "positive", "negative", "t", "f"]);

// Guess a role for every column: id | file | text | split | label | var | ignore (+ label type).
function guessRoles(columns, rows) {
  const sample = rows.slice(0, 2000);
  const roles = {};
  let haveFile = false;
  let haveText = false;
  for (const col of columns) {
    const name = col.toLowerCase();
    const vals = sample.map((r) => r[col]).filter((v) => v !== undefined && v !== null && String(v).trim() !== "");
    const strs = vals.map((v) => String(v).trim());
    const distinct = new Set(strs.map((s) => s.toLowerCase()));
    const avgLen = strs.length ? strs.reduce((a, s) => a + s.length, 0) / strs.length : 0;
    const fileLike = strs.length > 0 && strs.filter((s) => /^(s3|gs|az|https?):\/\//i.test(s) || kindOf(s)).length / strs.length > 0.8;
    const numeric = strs.length > 0 && strs.every((s) => Number.isFinite(Number(s)));
    let role = "label";
    let type;
    if (/^(id|item_?id|uid|uuid|key|name)$/.test(name) && distinct.size === strs.length && !fileLike) role = "id";
    else if (fileLike && !haveFile) { role = "file"; haveFile = true; }
    else if (/^(split|set|partition|subset|fold)$/.test(name) && [...distinct].every((v) => splitFromWord(v))) role = "split";
    else if (!haveText && (/^(text|input|content|prompt|question|document|body|message|transcript)$/.test(name) || (avgLen > 60 && distinct.size > Math.min(50, strs.length * 0.5)))) { role = "text"; haveText = true; }
    else if (strs.length === 0) role = "ignore";
    else if (distinct.size <= 2 && [...distinct].every((v) => BINARY_VALUES.has(v))) type = "binary";
    else if (numeric && distinct.size > 20) type = "number";
    else if (distinct.size <= Math.max(20, Math.min(50, strs.length / 10))) type = "categorical";
    else if (avgLen > 60) role = "var";
    else type = "text";
    roles[col] = { role, ...(type ? { type } : {}), distinct: distinct.size, examples: strs.slice(0, 3) };
  }
  return roles;
}

// rows + roles → {fields, items}. fileResolver(value) → {path} | {uri} for the input file column.
function buildItemsFromRows(rows, roles, opts = {}) {
  const cols = Object.keys(roles);
  const idCol = cols.find((c) => roles[c].role === "id");
  const fileCol = cols.find((c) => roles[c].role === "file");
  const textCol = cols.find((c) => roles[c].role === "text");
  const splitCol = cols.find((c) => roles[c].role === "split");
  const varCols = cols.filter((c) => roles[c].role === "var");
  const labelCols = cols.filter((c) => roles[c].role === "label");
  const fields = labelCols.map((c, i) => {
    const r = roles[c];
    const f = { key: keyFromName(c), label: c, column: c, type: r.type || "categorical", index: i, description: r.description || "" };
    if (f.type === "binary" && r.positiveValues) f.positiveValues = r.positiveValues;
    if (f.type === "number") f.tolerance = r.tolerance || 0;
    return f;
  });
  for (const f of fields) {
    if (f.type === "categorical") {
      const classes = new Set();
      for (const row of rows) { const v = normalizeLabel(f, row[f.column]); if (v !== undefined) classes.add(v); }
      f.classes = [...classes].sort();
    }
  }
  const items = [];
  const seen = new Set();
  rows.forEach((row, i) => {
    let id = idCol ? String(row[idCol]).trim() : fileCol ? String(row[fileCol]).trim() : `row_${i + 1}`;
    if (!id || seen.has(id)) id = `${id || "row"}#${i + 1}`;
    seen.add(id);
    const labels = {};
    for (const f of fields) { const v = normalizeLabel(f, row[f.column]); if (v !== undefined) labels[f.key] = v; }
    if (Object.keys(labels).length === 0) return; // unlabelled rows are skipped
    const split = (splitCol && splitFromWord(row[splitCol])) || hashSplit(id, opts.trainRatio != null ? opts.trainRatio : 0.8, opts.seed);
    const vars = {};
    for (const c of varCols) vars[keyFromName(c)] = row[c];
    const input = {};
    if (textCol) input.text = String(row[textCol] ?? "");
    if (fileCol && String(row[fileCol] || "").trim()) input.fileRef = String(row[fileCol]).trim();
    items.push({ id, split, input, vars, labels });
  });
  for (const f of fields) delete f.column;
  return { fields, items };
}

module.exports = { parseDelimited, parseManifest, guessRoles, buildItemsFromRows, flattenRecord };
