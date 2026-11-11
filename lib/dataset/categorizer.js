// categorizer.js — folder tree from a bucket/folder listing, name-based suggestions, and the
// folder-tag → items expansion. A folder carries tags [{class, polarity}] (several allowed), an optional
// split override, or "ignore". The nearest folder with tags/ignore decides a file's tags; the nearest
// folder with a split override decides its split (else a train/test path segment, else a stable hash).
"use strict";

const { kindOf, stemOf, isMetaCompanion, keyFromName } = require("./files");
const { splitFromWord, hashSplit } = require("./split");

function dirOf(key) { const i = key.lastIndexOf("/"); return i === -1 ? "" : key.slice(0, i); }
function baseOf(key) { const i = key.lastIndexOf("/"); return i === -1 ? key : key.slice(i + 1); }

// Tree: {path, name, files, recursiveFiles, size, types:{kind:count}, children:[...]}
function buildTree(listing) {
  const nodes = new Map();
  const node = (p) => {
    if (nodes.has(p)) return nodes.get(p);
    const n = { path: p, name: p === "" ? "/" : baseOf(p), files: 0, recursiveFiles: 0, size: 0, recursiveSize: 0, types: {}, children: [] };
    nodes.set(p, n);
    if (p !== "") node(dirOf(p)).children.push(n);
    return n;
  };
  node("");
  for (const o of listing) {
    if (isMetaCompanion(o.key)) continue;
    const d = dirOf(o.key);
    const n = node(d);
    const kind = kindOf(o.key) || "other";
    n.files++;
    n.size += o.size || 0;
    n.types[kind] = (n.types[kind] || 0) + 1;
    let p = d;
    for (;;) {
      const a = node(p);
      a.recursiveFiles++;
      a.recursiveSize += o.size || 0;
      if (p === "") break;
      p = dirOf(p);
    }
  }
  for (const n of nodes.values()) n.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return nodes.get("");
}

function flattenTree(root) {
  const out = [];
  const walk = (n, depth) => { out.push({ ...n, depth, children: undefined, childCount: n.children.length }); n.children.forEach((c) => walk(c, depth + 1)); };
  walk(root, 0);
  return out;
}

const POLARITY_SUFFIX = /^(.*?)[\s_\-.]*(positives?|negatives?|pos|neg)$/i;
const POLARITY_PREFIX = /^(positives?|negatives?|pos|neg)[\s_\-.]+(.+)$/i;
function polarityWord(w) { return /^pos/i.test(w) ? "positive" : "negative"; }

// Suggested folder map from folder names, e.g. "falls_positive", "bed exit/neg", "b43_positive/training".
function suggest(root) {
  const map = [];
  const walk = (n, parentName) => {
    if (n.path !== "") {
      let m;
      const entry = { path: n.path };
      if ((m = n.name.match(POLARITY_SUFFIX)) && (m[1] || parentName)) {
        entry.tags = [{ class: m[1] ? m[1].replace(/[\s_\-.]+$/, "") : parentName, polarity: polarityWord(m[2]) }];
      } else if ((m = n.name.match(POLARITY_PREFIX))) {
        entry.tags = [{ class: m[2], polarity: polarityWord(m[1]) }];
      }
      const sp = splitFromWord(n.name);
      if (sp) entry.split = sp;
      if (entry.tags || entry.split) map.push(entry);
    }
    n.children.forEach((c) => walk(c, n.path === "" ? "" : n.name));
  };
  walk(root, "");
  return map;
}

function indexMap(folderMap) {
  const m = new Map();
  for (const e of folderMap || []) m.set(e.path || "", e);
  return m;
}

function resolveFor(key, mapIdx) {
  let d = dirOf(key);
  let tags = null;
  let split = null;
  let splitWord = null;
  for (;;) {
    const e = mapIdx.get(d);
    if (e) {
      if (tags === null && (e.ignore || (e.tags && e.tags.length))) tags = e.ignore ? [] : e.tags;
      if (split === null && (e.split === "train" || e.split === "test")) split = e.split;
    }
    if (splitWord === null && d !== "") splitWord = splitFromWord(baseOf(d));
    if (d === "") break;
    d = dirOf(d);
  }
  return { tags: tags || [], split: split || splitWord || null };
}

// Classes (fields) in order: explicit order first, then order of first appearance in folder order.
function classOrder(folderMap, explicitOrder) {
  const seen = [];
  for (const k of explicitOrder || []) if (!seen.includes(k)) seen.push(k);
  const sorted = [...(folderMap || [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const e of sorted) for (const t of e.tags || []) { const k = keyFromName(t.class); if (!seen.includes(k)) seen.push(k); }
  return seen;
}

// Expand tagged folders into items (one item per file × tag — the legacy one-label-per-item shape).
// Order: class order → positives → negatives → folder path → filename (default string sort), which is
// the original engine's order for the legacy layout.
function buildItems(listing, folderMap, opts = {}) {
  const mapIdx = indexMap(folderMap);
  const order = classOrder(folderMap, opts.classOrder);
  const labelsByKey = {};
  for (const e of folderMap || []) for (const t of e.tags || []) labelsByKey[keyFromName(t.class)] = labelsByKey[keyFromName(t.class)] || t.class;
  const groups = new Map(); // `${cls}|${pol}` → [{key, split}]
  const counts = { files: 0, tagged: 0, ignored: 0, unsupported: 0 };
  for (const o of listing) {
    if (isMetaCompanion(o.key)) continue;
    const kind = kindOf(o.key);
    counts.files++;
    if (!kind) { counts.unsupported++; continue; }
    const r = resolveFor(o.key, mapIdx);
    if (r.tags.length === 0) { counts.ignored++; continue; }
    counts.tagged++;
    const split = r.split || hashSplit(o.key, opts.trainRatio != null ? opts.trainRatio : 0.8, opts.seed);
    for (const t of r.tags) {
      const g = `${keyFromName(t.class)}|${t.polarity}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ key: o.key, kind, size: o.size, etag: o.etag, split });
    }
  }
  const items = [];
  const usedIds = new Set();
  for (const cls of order) {
    for (const pol of ["positive", "negative"]) {
      const list = groups.get(`${cls}|${pol}`) || [];
      list.sort((a, b) => {
        const da = dirOf(a.key), db = dirOf(b.key);
        if (da !== db) return da < db ? -1 : 1;
        const na = baseOf(a.key), nb = baseOf(b.key);
        return na < nb ? -1 : na > nb ? 1 : 0;
      });
      for (const f of list) {
        let id = `${cls}_${pol}/${f.split === "train" ? "training" : "test"}/${stemOf(f.key)}`;
        if (usedIds.has(id)) id = `${cls}_${pol}/${f.split === "train" ? "training" : "test"}/${dirOf(f.key).replace(/[/\\]+/g, "__")}__${stemOf(f.key)}`;
        let n = 2;
        while (usedIds.has(id)) id = `${id}~${n++}`;
        usedIds.add(id);
        items.push({ id, split: f.split, source: { key: f.key, size: f.size, etag: f.etag }, kind: f.kind, labels: { [cls]: pol === "positive" } });
      }
    }
  }
  const fields = order.map((k, i) => ({ key: k, label: labelsByKey[k] || k, type: "binary", index: i, description: "" }));
  return { items, fields, counts };
}

module.exports = { buildTree, flattenTree, suggest, resolveFor, buildItems, classOrder, dirOf, baseOf };
