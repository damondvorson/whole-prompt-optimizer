// dataset/index.js — import orchestration: scan a source, preview a folder map or manifest,
// commit (materialise only the needed files, write manifest.jsonl, build the health report).
"use strict";

const fs = require("fs");
const path = require("path");
const { openStorage, parseLocation } = require("../storage");
const store = require("../store");
const categorizer = require("./categorizer");
const manifest = require("./manifest");
const { buildHealthReport, mapLimit } = require("./health");
const { kindOf, mimeOf, isManifest, stemOf, sha1, keyFromName } = require("./files");
const { legacyTimingLine } = require("../presets/legacy");

function datasetDir(projectId) { return path.join(store.projectDir(projectId), "dataset"); }
function filesDir(projectId) { return path.join(datasetDir(projectId), "files"); }
function listingPath(projectId) { return path.join(datasetDir(projectId), "listing.json"); }

// Legacy layout: {field}_{positive|negative}/{training|test}/file
function detectLegacy(listing) {
  let hits = 0, media = 0;
  for (const o of listing) {
    if (!kindOf(o.key)) continue;
    media++;
    if (/^[^/]+_(positive|negative)\/(training|test)\/[^/]+$/.test(o.key)) hits++;
  }
  return media > 0 && hits / media > 0.9;
}

async function scan(projectId, source, connection, onProgress) {
  const storage = openStorage(source.uri, connection);
  const listing = await storage.listAll(onProgress);
  fs.mkdirSync(datasetDir(projectId), { recursive: true });
  store.writeAtomic(listingPath(projectId), JSON.stringify({ source: { uri: source.uri, connectionId: source.connectionId || null, kind: storage.kind }, scannedAt: new Date().toISOString(), listing }));
  const tree = categorizer.buildTree(listing);
  const suggestions = categorizer.suggest(tree);
  const manifests = listing.filter((o) => isManifest(o.key) && o.key.split("/").length <= 3).map((o) => o.key);
  const media = listing.filter((o) => kindOf(o.key)).length;
  return {
    kind: storage.kind, described: storage.describe(), files: listing.length, media,
    totalSize: listing.reduce((a, o) => a + (o.size || 0), 0),
    tree: categorizer.flattenTree(tree), suggestions, manifests, legacyLayout: detectLegacy(listing),
    sameVolume: storage.kind === "local" && storage.sameVolume ? storage.sameVolume(datasetDir(projectId)) : false,
  };
}

function cachedListing(projectId) {
  const data = store.readJSON(listingPath(projectId), null);
  if (!data) throw new Error("Scan the source first");
  return data;
}

function previewFolders(projectId, folderMap, opts = {}) {
  const { listing } = cachedListing(projectId);
  const { items, fields, counts } = categorizer.buildItems(listing, folderMap, opts);
  const perField = {};
  for (const f of fields) perField[f.key] = { label: f.label, train: { positive: 0, negative: 0 }, test: { positive: 0, negative: 0 } };
  for (const it of items) for (const [k, v] of Object.entries(it.labels)) perField[k][it.split][v ? "positive" : "negative"]++;
  const bytes = new Set();
  let size = 0;
  for (const it of items) if (!bytes.has(it.source.key)) { bytes.add(it.source.key); size += it.source.size || 0; }
  return { fields, counts, items: items.length, uniqueFiles: bytes.size, downloadBytes: size, perField, sample: items.slice(0, 12) };
}

async function readSourceFile(projectId, key, connection) {
  const { source } = cachedListing(projectId);
  const storage = openStorage(source.uri, connection);
  return (await storage.read(key)).toString("utf8");
}

async function previewManifest(projectId, key, connection, roles) {
  const text = await readSourceFile(projectId, key, connection);
  const parsed = manifest.parseManifest(text, key);
  const guessed = roles || manifest.guessRoles(parsed.columns, parsed.rows);
  const built = manifest.buildItemsFromRows(parsed.rows, guessed, {});
  return { columns: parsed.columns, rows: parsed.rows.length, roles: guessed, fields: built.fields, items: built.items.length, sample: parsed.rows.slice(0, 8) };
}

// Copy (clone/download) the given source keys into the project. Returns key → stored path (relative to
// the project dir, or absolute in "reference" mode).
async function materialize(projectId, keys, source, connection, mode, onProgress) {
  const storage = openStorage(source.uri, connection);
  const dest = filesDir(projectId);
  const out = new Map();
  let done = 0, cloned = 0, copied = 0, downloaded = 0;
  const unique = [...new Set(keys)];
  await mapLimit(unique, storage.kind === "local" ? 16 : 8, async (key) => {
    if (storage.kind === "local" && mode === "reference") {
      out.set(key, storage.absPath(key));
    } else {
      const target = path.join(dest, ...key.split("/"));
      const rel = path.relative(store.projectDir(projectId), target);
      if (!fs.existsSync(target)) {
        let how;
        for (let attempt = 0; ; attempt++) {
          try { how = await storage.download(key, target, mode === "copy" ? "copy" : "clone"); break; } catch (err) {
            if (attempt >= 3) throw new Error(`Download failed for ${key}: ${err.message}`);
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
        if (how === "cloned") cloned++; else if (how === "copied") copied++; else downloaded++;
      }
      out.set(key, rel);
    }
    done++;
    if (onProgress && (done % 100 === 0 || done === unique.length)) onProgress(done, unique.length);
  });
  return { paths: out, stats: { files: unique.length, cloned, copied, downloaded } };
}

function readMetaVars(absPath, legacyDefaults) {
  // Original behaviour: only .png has a companion (path.replace(/\.png$/i, ".meta.json")); defaults 8 / 1.6.
  let meta = null;
  if (/\.png$/i.test(absPath)) {
    try { meta = JSON.parse(fs.readFileSync(absPath.replace(/\.png$/i, ".meta.json"), "utf8")); } catch {}
  }
  if (meta && Number.isFinite(meta.duration) && Number.isFinite(meta.interval)) {
    return { vars: { duration: meta.duration, interval: meta.interval, timing_line: legacyTimingLine(meta) }, metaStatus: "ok" };
  }
  if (legacyDefaults) {
    const d = { duration: 8, interval: 1.6 };
    return { vars: { duration: d.duration, interval: d.interval, timing_line: legacyTimingLine(d) }, metaStatus: meta ? "invalid" : "missing" };
  }
  return { vars: {}, metaStatus: "none" };
}

function absItemPath(projectId, p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.join(store.projectDir(projectId), p);
}

// Commit a folder-tagged dataset.
async function commitFolders(projectId, folderMap, opts, connection, onProgress) {
  const { source, listing } = cachedListing(projectId);
  const { items, fields, counts } = categorizer.buildItems(listing, folderMap, opts);
  if (items.length === 0) throw new Error("No files are tagged — tag at least one folder with a class and polarity");
  const keys = items.map((i) => i.source.key);
  // companion .meta.json files for png grids
  const listingKeys = new Set(listing.map((o) => o.key));
  for (const k of new Set(keys)) {
    const meta = k.replace(/\.png$/i, ".meta.json");
    if (meta !== k && listingKeys.has(meta)) keys.push(meta);
  }
  onProgress && onProgress({ phase: "copy", done: 0, total: new Set(keys).size });
  const { paths, stats } = await materialize(projectId, keys, source, connection, opts.mode || "clone", (d, t) => onProgress && onProgress({ phase: "copy", done: d, total: t }));
  let metaMissing = 0, metaInvalid = 0;
  const out = items.map((it) => {
    const rel = paths.get(it.source.key);
    const abs = absItemPath(projectId, rel);
    const { vars, metaStatus } = readMetaVars(abs, !!opts.legacyMeta);
    if (metaStatus === "missing") metaMissing++;
    if (metaStatus === "invalid") metaInvalid++;
    return { id: it.id, split: it.split, input: { files: [{ path: rel, mime: mimeOf(it.source.key), kind: it.kind }] }, vars, labels: it.labels, source: it.source };
  });
  return finishCommit(projectId, out, fields, { layout: "folders", folderMap, counts, copy: stats, metaMissing, metaInvalid }, onProgress);
}

// Commit a manifest dataset. File references may be relative to the manifest's folder, relative to the
// source root, or absolute URIs (s3://, gs://, az://, https://) fetched with the given connection.
async function commitManifest(projectId, manifestKey, roles, opts, connection, onProgress, connectionResolver) {
  const { source, listing } = cachedListing(projectId);
  const text = await readSourceFile(projectId, manifestKey, connection);
  const parsed = manifest.parseManifest(text, manifestKey);
  const { fields, items } = manifest.buildItemsFromRows(parsed.rows, roles, opts);
  if (items.length === 0) throw new Error("No labelled rows found — pick at least one label column");
  const listingKeys = new Set(listing.map((o) => o.key));
  const baseDir = categorizer.dirOf(manifestKey);
  const localKeys = [];
  const remote = [];
  for (const it of items) {
    const ref = it.input.fileRef;
    if (!ref) continue;
    if (/^(s3|gs|az|https?):\/\//i.test(ref)) { remote.push(it); continue; }
    const cand = [baseDir ? `${baseDir}/${ref}` : ref, ref].map((k) => k.replace(/^\.\//, "").replace(/\/+/g, "/"));
    const hit = cand.find((k) => listingKeys.has(k));
    if (hit) { it.input.fileKey = hit; localKeys.push(hit); } else it.input.missing = ref;
  }
  const { paths, stats } = await materialize(projectId, localKeys, source, connection, opts.mode || "clone", (d, t) => onProgress && onProgress({ phase: "copy", done: d, total: t }));
  // remote URIs: download each into dataset/files/_remote/<hash>-<name>
  let rdone = 0;
  await mapLimit(remote, 8, async (it) => {
    const ref = it.input.fileRef;
    const loc = parseLocation(ref);
    const conn = connectionResolver ? connectionResolver(loc.kind) : connection;
    const name = decodeURIComponent(ref.split("?")[0].split("/").pop());
    const target = path.join(filesDir(projectId), "_remote", `${sha1(ref).slice(0, 12)}-${name}`);
    if (!fs.existsSync(target)) {
      let st;
      if (loc.kind === "https") st = openStorage(ref);
      else {
        // open the object's parent "folder" and download the object by its base name
        const full = loc.prefix || "";
        const dir = full.includes("/") ? full.slice(0, full.lastIndexOf("/")) : "";
        const dirUri = loc.kind === "s3" ? `s3://${loc.bucket}/${dir}`
          : loc.kind === "gcs" ? `gs://${loc.bucket}/${dir}`
          : loc.account ? `https://${loc.account}.blob.core.windows.net/${loc.container}/${dir}${loc.sas ? "?" + loc.sas : ""}`
          : `az://${loc.container}/${dir}`;
        st = openStorage(dirUri, conn);
      }
      await st.download(name, target);
    }
    it.input.fileKey = null;
    it.input.storedPath = path.relative(store.projectDir(projectId), target);
    rdone++;
    onProgress && onProgress({ phase: "download", done: rdone, total: remote.length });
  });
  let missing = 0;
  const out = items.map((it) => {
    const files = [];
    if (it.input.fileKey) files.push({ path: paths.get(it.input.fileKey), mime: mimeOf(it.input.fileKey), kind: kindOf(it.input.fileKey) });
    else if (it.input.storedPath) files.push({ path: it.input.storedPath, mime: mimeOf(it.input.storedPath), kind: kindOf(it.input.storedPath) });
    if (it.input.missing) missing++;
    const input = {};
    if (it.input.text !== undefined) input.text = it.input.text;
    if (files.length) input.files = files;
    return { id: it.id, split: it.split, input, vars: it.vars, labels: it.labels, ...(it.input.missing ? { missingFile: it.input.missing } : {}) };
  });
  return finishCommit(projectId, out, fields, { layout: "manifest", manifestKey, roles, copy: stats, remote: remote.length, missingFiles: missing }, onProgress);
}

async function finishCommit(projectId, items, fields, info, onProgress) {
  store.writeManifest(projectId, items);
  onProgress && onProgress({ phase: "health", done: 0, total: items.length });
  const health = await buildHealthReport(items, fields, (it) => (it.input.files && it.input.files[0] ? absItemPath(projectId, it.input.files[0].path) : null),
    (d, t) => onProgress && onProgress({ phase: "health", done: d, total: t }));
  const hashes = health.hashes;
  delete health.hashes;
  // record content hashes on items (used by merge / leak policies and the cache)
  for (const it of items) {
    const f = it.input.files && it.input.files[0];
    if (f) f.sha = hashes[absItemPath(projectId, f.path)] || null;
  }
  store.writeManifest(projectId, items);
  store.writeAtomic(path.join(datasetDir(projectId), "health.json"), JSON.stringify(health));
  const datasetSha = store.fileSha(store.manifestPath(projectId));
  return { items: items.length, fields, info, health, datasetSha };
}

// Health policies applied after commit: drop leaked test items / conflicting items, etc.
function applyPolicies(projectId, policies) {
  const health = store.readJSON(path.join(datasetDir(projectId), "health.json"), null);
  if (!health) throw new Error("No health report");
  let items = store.readManifest(projectId);
  const before = items.length;
  if (policies.leaks === "drop_test") {
    const leakIds = new Set(health.leakItemIds);
    items = items.filter((it) => !(leakIds.has(it.id) && it.split === "test"));
  }
  if (policies.conflicts === "drop") {
    const ids = new Set(health.conflictItemIds);
    items = items.filter((it) => !ids.has(it.id));
  }
  if (policies.missing === "drop") items = items.filter((it) => !it.missingFile);
  store.writeManifest(projectId, items);
  return { before, after: items.length, datasetSha: store.fileSha(store.manifestPath(projectId)) };
}

// Browser uploads land in projects/<id>/upload/ and are then scanned like a local folder.
function uploadDir(projectId) { return path.join(store.projectDir(projectId), "upload"); }
function safeUploadPath(projectId, rel) {
  const clean = String(rel || "").replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
  if (!clean) throw new Error("bad upload path");
  const abs = path.join(uploadDir(projectId), ...clean.split("/"));
  if (!abs.startsWith(uploadDir(projectId) + path.sep)) throw new Error("bad upload path");
  return abs;
}

async function extractZip(zipPath, destDir) {
  const yauzl = require("yauzl");
  await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.readEntry();
      zip.on("entry", (entry) => {
        const clean = entry.fileName.replace(/\\/g, "/").split("/").filter((s) => s && s !== "." && s !== "..").join("/");
        if (!clean || /\/$/.test(entry.fileName) || clean.startsWith("__MACOSX")) { zip.readEntry(); return; }
        const out = path.join(destDir, ...clean.split("/"));
        if (!out.startsWith(destDir + path.sep)) { zip.readEntry(); return; }
        fs.mkdirSync(path.dirname(out), { recursive: true });
        zip.openReadStream(entry, (e2, rs) => {
          if (e2) return reject(e2);
          rs.pipe(fs.createWriteStream(out)).on("finish", () => zip.readEntry()).on("error", reject);
        });
      });
      zip.on("end", resolve);
      zip.on("error", reject);
    });
  });
}

module.exports = {
  scan, previewFolders, previewManifest, commitFolders, commitManifest, applyPolicies,
  cachedListing, datasetDir, filesDir, uploadDir, safeUploadPath, extractZip, absItemPath, detectLegacy, keyFromName, stemOf,
};
