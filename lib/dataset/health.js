// health.js — dataset health report: content-hash duplicates, train/test leaks, same-field label
// conflicts, missing/unreadable files, per-field label counts by split.
"use strict";

const fs = require("fs");
const crypto = require("crypto");

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    fs.createReadStream(p).on("error", reject).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex")));
  });
}

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k], k); }
  });
  await Promise.all(workers);
  return out;
}

// items: manifest items; resolvePath(item) → absolute path of its first input file (or null for text-only).
async function buildHealthReport(items, fields, resolvePath, onProgress) {
  const hashes = new Map(); // path → sha1
  const paths = [...new Set(items.map(resolvePath).filter(Boolean))];
  let done = 0;
  const missing = [];
  await mapLimit(paths, 16, async (p) => {
    try { hashes.set(p, await hashFile(p)); } catch { missing.push(p); }
    done++;
    if (onProgress && (done % 200 === 0 || done === paths.length)) onProgress(done, paths.length);
  });
  const byHash = new Map();
  for (const it of items) {
    const p = resolvePath(it);
    const key = p ? hashes.get(p) : it.input && it.input.text ? "text:" + crypto.createHash("sha1").update(it.input.text).digest("hex") : null;
    if (!key) continue;
    if (!byHash.has(key)) byHash.set(key, []);
    byHash.get(key).push(it);
  }
  let duplicateGroups = 0, multiField = 0;
  const leaks = [];
  const conflicts = [];
  for (const [h, group] of byHash) {
    if (group.length > 1) duplicateGroups++;
    const fieldsHere = new Set(group.flatMap((g) => Object.keys(g.labels)));
    if (fieldsHere.size > 1) multiField++;
    if (new Set(group.map((g) => g.split)).size > 1) leaks.push({ hash: h, items: group.map((g) => ({ id: g.id, split: g.split })) });
    for (const fk of fieldsHere) {
      const vals = new Set(group.filter((g) => fk in g.labels).map((g) => JSON.stringify(g.labels[fk])));
      if (vals.size > 1) conflicts.push({ hash: h, field: fk, items: group.filter((g) => fk in g.labels).map((g) => ({ id: g.id, split: g.split, label: g.labels[fk] })) });
    }
  }
  const perField = {};
  for (const f of fields) {
    const c = { train: {}, test: {} };
    for (const it of items) {
      if (!(f.key in it.labels)) continue;
      const v = String(it.labels[f.key]);
      c[it.split][v] = (c[it.split][v] || 0) + 1;
    }
    perField[f.key] = c;
  }
  return {
    generatedAt: new Date().toISOString(),
    items: items.length,
    files: paths.length,
    uniqueContents: byHash.size,
    duplicateGroups,
    multiFieldContents: multiField,
    crossSplitLeaks: leaks.length,
    labelConflicts: conflicts.length,
    missing: missing.length,
    examples: { leaks: leaks.slice(0, 50), conflicts: conflicts.slice(0, 50), missing: missing.slice(0, 50) },
    leakItemIds: leaks.flatMap((l) => l.items.map((i) => i.id)),
    conflictItemIds: conflicts.flatMap((c) => c.items.map((i) => i.id)),
    perField,
    hashes: Object.fromEntries([...hashes].map(([p, h]) => [p, h])),
  };
}

module.exports = { buildHealthReport, hashFile, mapLimit };
