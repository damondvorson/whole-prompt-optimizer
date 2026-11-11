#!/usr/bin/env node
// server.js — local web app for the general-purpose Whole-Prompt Optimizer.
//   npm start  →  http://127.0.0.1:8490
// Binds to 127.0.0.1 only; every /api call needs the per-launch token embedded in the page; no CORS.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fork } = require("child_process");

const connections = require("./lib/connections");
connections.loadDotEnv();
const store = require("./lib/store");
const datasets = require("./lib/dataset");
const projects = require("./lib/projects");
const method = require("./lib/method");
const legacy = require("./lib/presets/legacy");
const { ApiLog } = require("./lib/apilog");
const { thumbnail } = require("./lib/media");
const { createProvider } = require("./lib/harness");
const { openStorage } = require("./lib/storage");
const { kindOf, mimeOf } = require("./lib/dataset/files");

const PORT = Number(process.env.PORT || 8490);
// Folder of an original wpo_video_optimizer (runners + grids), offered by the legacy import when present.
const LEGACY_DIR = process.env.WPO_LEGACY_DIR || path.join(__dirname, "..", "wpo_video_optimizer");
const HOST = "127.0.0.1";
const TOKEN = crypto.randomBytes(24).toString("hex");
const PUBLIC = fs.realpathSync(path.join(__dirname, "public"));
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

// ─── jobs (long-running server tasks: scans, commits, preflight) ───
const jobs = new Map();
function startJob(kind, projectId, fn) {
  const id = crypto.randomBytes(6).toString("hex");
  const job = { id, kind, projectId, status: "running", progress: null, result: null, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  Promise.resolve().then(() => fn((p) => { job.progress = p; })).then((r) => { job.status = "done"; job.result = r; }).catch((e) => { job.status = "error"; job.error = String(e && e.message ? e.message : e); });
  setTimeout(() => jobs.delete(id), 6 * 3600 * 1000).unref();
  return job;
}

// ─── engine supervisor ───
const workers = new Map(); // projectId → {child, state}
function workerState(id) { const w = workers.get(id); return w ? w.state : null; }

function resolveConnection(id) {
  const c = connections.get(id);
  if (!c) throw new Error("Connection not found — pick one on the harness card");
  return c;
}

function startEngine(project) {
  if (workers.has(project.id)) throw new Error("Already running");
  const conns = { target: resolveConnection(project.target.connectionId), generator: resolveConnection(project.generator.connectionId) };
  const child = fork(path.join(__dirname, "engine.js"), [project.id], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: Object.assign({}, process.env, { WPO_PROJECTS_DIR: store.PROJECTS_DIR }) });
  const w = { child, state: "initializing", stderr: "" };
  workers.set(project.id, w);
  child.stderr.on("data", (d) => { w.stderr = (w.stderr + d.toString()).slice(-8000); });
  child.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "spawned") child.send({ type: "init", connections: conns });
    if (msg.type === "ready") w.state = "running";
    if (msg.type === "summary") w.state = msg.state;
    if (msg.type === "attention") w.state = "needs_attention";
    if (msg.type === "stopped") w.state = msg.reason;
    if (msg.type === "fatal") w.state = "crashed";
  });
  child.on("exit", (code) => {
    workers.delete(project.id);
    let s = store.readSummary(project.id);
    if (s && !["stopped", "completed", "crashed"].includes(s.state)) {
      s = Object.assign(s, { state: code === 0 ? "stopped" : "crashed", error: code === 0 ? null : (w.stderr || `engine exited with code ${code}`).slice(-2000), updatedAt: new Date().toISOString() });
      store.writeSummary(project.id, s);
    }
    try { const pj = store.loadProject(project.id); pj.state = (s && s.state) || "stopped"; store.saveProject(pj); } catch {}
  });
  const p = store.loadProject(project.id);
  p.state = "running";
  store.saveProject(p);
}

function sendToEngine(id, msg) {
  const w = workers.get(id);
  if (!w) return false;
  w.child.send(msg);
  return true;
}

// Mark runs that were alive when the server last stopped.
for (const p of store.listProjects()) {
  const s = store.readSummary(p.id);
  if (s && ["running", "initializing", "paused", "needs_attention"].includes(s.state)) {
    store.writeSummary(p.id, Object.assign(s, { state: "stopped", note: "server restarted", updatedAt: new Date().toISOString() }));
  }
}

// ─── HTTP helpers ───
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "Content-Type": isBuf ? "application/octet-stream" : typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  }, headers));
  res.end(data);
}
function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("Body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJSONBody(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString("utf8")); } catch { throw Object.assign(new Error("Invalid JSON body"), { status: 400 }); }
}

function projectView(id) {
  const p = store.loadProject(id);
  const s = store.readSummary(id);
  const health = store.readJSON(path.join(datasets.datasetDir(id), "health.json"), null);
  const live = workerState(id);
  return {
    project: p, summary: s, running: workers.has(id), state: live || (s && s.state) || p.state,
    hasBaseline: projects.hasBaseline(id), health: health ? Object.assign({}, health, { leakItemIds: undefined, conflictItemIds: undefined }) : null,
    metaHints: projects.metaTemplateHints(p), exclusions: store.readJSON(path.join(store.projectDir(id), "exclusions.json"), []),
    configSha: store.configSha(p),
  };
}

function itemIndex(id) {
  const items = store.readManifest(id);
  const map = new Map(items.map((i) => [i.id, i]));
  return { items, map };
}

// ─── routes ───
const routes = [];
function route(methodName, pattern, handler) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method: methodName, re, keys, handler });
}

route("GET", "/api/meta", async () => ({
  connectionTypes: Object.fromEntries(Object.entries(connections.TYPES).map(([k, v]) => [k, { label: v.label, uses: v.uses, fields: v.fields, how: v.how }])),
  originalMetaTemplate: method.ORIGINAL_META_TEMPLATE, metaSlots: method.META_SLOTS,
  defaultToggles: require("./engine").DEFAULT_TOGGLES,
  legacyRunners: ["staff", "alerts", "health"].map((c) => path.join(LEGACY_DIR, `wpo_video_${c}.js`)).filter((p) => fs.existsSync(p)),
  legacyGrids: fs.existsSync(path.join(LEGACY_DIR, "grids")) ? path.join(LEGACY_DIR, "grids") : null,
}));

// projects
route("GET", "/api/projects", async () => store.listProjects().map((p) => Object.assign(p, { running: workers.has(p.id), state: workerState(p.id) || p.state })));
route("POST", "/api/projects", async (req) => {
  const body = await readJSONBody(req);
  const p = projects.newProject(String(body.name || "").trim() || "Untitled optimization");
  fs.mkdirSync(store.projectDir(p.id), { recursive: true });
  store.saveProject(p);
  return projectView(p.id);
});
route("GET", "/api/projects/:id", async (req, { id }) => projectView(id));
route("PATCH", "/api/projects/:id", async (req, { id }) => {
  const patch = await readJSONBody(req);
  const p = store.loadProject(id);
  if (workers.has(id) && Object.keys(patch).some((k) => projects.LOCKED_AFTER_BASELINE.includes(k))) throw Object.assign(new Error("Pause/stop the run before editing these settings"), { status: 409 });
  projects.applyPatch(p, patch);
  store.saveProject(p);
  return projectView(id);
});
route("DELETE", "/api/projects/:id", async (req, { id }) => {
  if (workers.has(id)) throw Object.assign(new Error("Stop the run first"), { status: 409 });
  const trash = path.join(store.PROJECTS_DIR, ".trash");
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(store.projectDir(id), path.join(trash, `${id}-${Date.now()}`));
  return { ok: true, movedTo: "projects/.trash" };
});
route("POST", "/api/projects/:id/fork", async (req, { id }) => {
  const src = store.loadProject(id);
  const body = await readJSONBody(req);
  const p = projects.newProject(body.name || `${src.name} (fork)`);
  Object.assign(p, JSON.parse(JSON.stringify({ dataset: src.dataset, fields: src.fields, prompt: src.prompt, output: src.output, target: src.target, generator: src.generator, method: src.method, pricing: src.pricing, logging: src.logging })));
  p.state = src.dataset ? "configured" : "draft";
  const from = store.projectDir(id), to = store.projectDir(p.id);
  fs.mkdirSync(to, { recursive: true });
  for (const f of ["manifest.jsonl", "exclusions.json"]) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(to, f));
  if (fs.existsSync(path.join(from, "dataset"))) await cloneTree(path.join(from, "dataset"), path.join(to, "dataset"));
  // keep absolute (reference-mode) paths; relative paths resolve inside the fork's own dataset folder
  store.saveProject(p);
  return projectView(p.id);
});

async function cloneTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) await cloneTree(s, d);
    else if (e.isFile()) { try { fs.copyFileSync(s, d, fs.constants.COPYFILE_FICLONE); } catch { fs.copyFileSync(s, d); } }
  }
}

// dataset
route("POST", "/api/projects/:id/dataset/upload", async (req, { id }, url) => {
  const rel = url.searchParams.get("path");
  const abs = datasets.safeUploadPath(id, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const buf = await readBody(req, 2 * 1024 * 1024 * 1024);
  fs.writeFileSync(abs, buf);
  if (/\.zip$/i.test(abs) && url.searchParams.get("extract") !== "0") {
    await datasets.extractZip(abs, path.dirname(abs));
    fs.unlinkSync(abs);
  }
  return { ok: true, bytes: buf.length, root: datasets.uploadDir(id) };
});
route("POST", "/api/projects/:id/dataset/scan", async (req, { id }) => {
  const body = await readJSONBody(req);
  const uri = body.uri === "@upload" ? datasets.uploadDir(id) : body.uri;
  const conn = body.connectionId ? resolveConnection(body.connectionId) : null;
  return startJob("scan", id, (progress) => datasets.scan(id, { uri, connectionId: body.connectionId || null }, conn, (n) => progress({ label: "Listing files", done: n })));
});
route("POST", "/api/projects/:id/dataset/preview-folders", async (req, { id }) => {
  const body = await readJSONBody(req);
  return datasets.previewFolders(id, body.folderMap || [], { classOrder: body.classOrder, trainRatio: body.trainRatio });
});
route("POST", "/api/projects/:id/dataset/preview-manifest", async (req, { id }) => {
  const body = await readJSONBody(req);
  const { source } = datasets.cachedListing(id);
  const conn = source.connectionId ? resolveConnection(source.connectionId) : null;
  return datasets.previewManifest(id, body.key, conn, body.roles);
});
route("GET", "/api/projects/:id/dataset/source-thumb", async (req, { id }, url, res) => {
  const key = url.searchParams.get("key");
  const { source, listing } = datasets.cachedListing(id);
  if (!listing.some((o) => o.key === key)) throw Object.assign(new Error("Not in listing"), { status: 404 });
  const conn = source.connectionId ? resolveConnection(source.connectionId) : null;
  const st = openStorage(source.uri, conn);
  const cacheDir = path.join(store.projectDir(id), "cache", "source-thumbs");
  const out = path.join(cacheDir, `${crypto.createHash("sha1").update(key).digest("hex")}.jpg`);
  if (!fs.existsSync(out)) {
    let local = st.kind === "local" ? st.absPath(key) : null;
    if (!local) {
      local = path.join(cacheDir, "src", crypto.createHash("sha1").update(key).digest("hex") + path.extname(key));
      if (!fs.existsSync(local)) await st.download(key, local);
    }
    await thumbnail(local, out, 240);
  }
  send(res, 200, fs.readFileSync(out), { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
  return undefined;
});
route("POST", "/api/projects/:id/dataset/commit", async (req, { id }) => {
  if (workers.has(id)) throw Object.assign(new Error("Stop the run before changing the dataset"), { status: 409 });
  if (projects.hasBaseline(id)) throw Object.assign(new Error("This run already has a baseline — fork the project to change the dataset"), { status: 409 });
  const body = await readJSONBody(req);
  const { source } = datasets.cachedListing(id);
  const conn = source.connectionId ? resolveConnection(source.connectionId) : null;
  return startJob("commit", id, async (progress) => {
    const opts = { classOrder: body.classOrder, trainRatio: body.trainRatio, mode: body.mode || "clone", legacyMeta: !!body.legacyMeta };
    const r = body.layout === "manifest"
      ? await datasets.commitManifest(id, body.key, body.roles, opts, conn, progress)
      : await datasets.commitFolders(id, body.folderMap || [], opts, conn, progress);
    const p = store.loadProject(id);
    // keep per-field settings the user already made (descriptions, targets, types) when keys match
    const prev = new Map((p.fields || []).map((f) => [f.key, f]));
    p.fields = r.fields.map((f) => Object.assign({}, f, prev.get(f.key) ? { description: prev.get(f.key).description || f.description, target: prev.get(f.key).target } : {}));
    if (body.fieldOverrides) for (const f of p.fields) Object.assign(f, body.fieldOverrides[f.key] || {});
    p.dataset = { source, layout: body.layout || "folders", folderMap: body.folderMap || null, manifestKey: body.key || null, roles: body.roles || null, classOrder: body.classOrder || null, trainRatio: body.trainRatio || 0.8, mode: opts.mode, legacyMeta: opts.legacyMeta, datasetSha: r.datasetSha, committedAt: new Date().toISOString(), items: r.items, info: r.info };
    try { p.output = projects.defaultOutput(p.fields, { justificationInMain: p.output && p.output.justification && p.output.justification.mode === "main_response" && p.output.style === "index_array", style: p.output && p.output.style }); }
    catch { p.output = projects.defaultOutput(p.fields, {}); }
    p.state = "dataset_ready";
    store.saveProject(p);
    try { fs.unlinkSync(path.join(store.projectDir(id), "exclusions.json")); } catch {}
    return { items: r.items, fields: p.fields, health: Object.assign({}, r.health, { leakItemIds: undefined, conflictItemIds: undefined }), info: r.info };
  });
});
route("POST", "/api/projects/:id/dataset/policies", async (req, { id }) => {
  if (projects.hasBaseline(id)) throw Object.assign(new Error("Run has a baseline — fork to change the dataset"), { status: 409 });
  const body = await readJSONBody(req);
  const r = datasets.applyPolicies(id, body);
  const p = store.loadProject(id);
  p.dataset.datasetSha = r.datasetSha;
  p.dataset.items = r.after;
  p.dataset.policies = body;
  store.saveProject(p);
  return r;
});
route("POST", "/api/projects/:id/import-legacy-runner", async (req, { id }) => {
  const body = await readJSONBody(req);
  const cfg = legacy.importLegacyRunner(String(body.path || ""));
  const s = legacy.legacyProjectSettings(cfg);
  const p = store.loadProject(id);
  if (projects.hasBaseline(id)) throw Object.assign(new Error("Run has a baseline — fork first"), { status: 409 });
  p.fields = s.fields;
  p.prompt = s.prompt;
  p.output = s.output;
  p.target = Object.assign({}, p.target, s.target, { connectionId: p.target.connectionId });
  p.generator = Object.assign({}, p.generator, s.generator, { connectionId: p.generator.connectionId });
  p.method.toggles = Object.assign({}, p.method.toggles, s.toggles);
  p.method.metaTemplate = null;
  p.categoryName = cfg.categoryName;
  p.preset = s.preset;
  store.saveProject(p);
  const gridsGuess = path.resolve(path.dirname(String(body.path)), cfg.photosBase || "./grids");
  return { project: p, classOrder: s.fields.map((f) => f.key), gridsPath: fs.existsSync(gridsGuess) ? gridsGuess : null };
});

// items
route("GET", "/api/projects/:id/items/:itemId/thumb", async (req, { id, itemId }, url, res) => {
  const { map } = itemIndex(id);
  const it = map.get(decodeURIComponent(itemId));
  if (!it || !it.input.files || !it.input.files[0]) throw Object.assign(new Error("No file for this item"), { status: 404 });
  const f = it.input.files[0];
  let src = datasets.absItemPath(id, f.path);
  const p = store.loadProject(id);
  const vmode = p.target && p.target.media && p.target.media.video && p.target.media.video.mode;
  let tag = "src";
  if ((f.kind || kindOf(f.path)) === "video" && vmode !== "native") {
    // show the frame grid the model actually receives (built during initialization / preflight)
    try { src = (await new (require("./lib/media").MediaPipeline)(store.projectDir(id), p.target.media).gridFor(f)).path; tag = "grid"; } catch {}
  }
  const w = Math.min(1600, Math.max(64, Number(url.searchParams.get("w") || 240)));
  const out = path.join(store.projectDir(id), "cache", "thumbs", `${crypto.createHash("sha1").update(`${it.id}|${w}|${tag}`).digest("hex")}.jpg`);
  await thumbnail(src, out, w);
  send(res, 200, fs.readFileSync(out), { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
  return undefined;
});
route("GET", "/api/projects/:id/items/:itemId", async (req, { id, itemId }) => {
  const { map } = itemIndex(id);
  const it = map.get(decodeURIComponent(itemId));
  if (!it) throw Object.assign(new Error("Item not found"), { status: 404 });
  const files = (it.input.files || []).map((f) => ({ kind: f.kind || kindOf(f.path), mime: f.mime || mimeOf(f.path), name: path.basename(f.path) }));
  let textFile = null;
  const tf = (it.input.files || []).find((f) => (f.kind || kindOf(f.path)) === "text");
  if (tf) { try { textFile = fs.readFileSync(datasets.absItemPath(id, tf.path), "utf8").slice(0, 20000); } catch {} }
  return { id: it.id, split: it.split, labels: it.labels, vars: it.vars, text: it.input.text ? it.input.text.slice(0, 20000) : textFile, files, source: it.source || null, missingFile: it.missingFile };
});
route("POST", "/api/projects/:id/items/:itemId/exclude", async (req, { id, itemId }) => setExcluded(id, decodeURIComponent(itemId), true));
route("POST", "/api/projects/:id/items/:itemId/include", async (req, { id, itemId }) => setExcluded(id, decodeURIComponent(itemId), false));
function setExcluded(id, itemId, on) {
  const p = path.join(store.projectDir(id), "exclusions.json");
  const set = new Set(store.readJSON(p, []));
  if (on) set.add(itemId); else set.delete(itemId);
  store.writeAtomic(p, JSON.stringify([...set]));
  sendToEngine(id, { type: on ? "exclude" : "include", itemId });
  return { ok: true, excluded: set.size, appliesAtNextStep: workers.has(id) };
}

// connections
route("GET", "/api/connections", async () => connections.list());
route("POST", "/api/connections", async (req) => connections.create(await readJSONBody(req)));
route("PATCH", "/api/connections/:cid", async (req, { cid }) => connections.update(cid, await readJSONBody(req)));
route("DELETE", "/api/connections/:cid", async (req, { cid }) => ({ ok: connections.remove(cid) }));
route("GET", "/api/connections/:cid/models", async (req, { cid }) => {
  const c = resolveConnection(decodeURIComponent(cid));
  if (!connections.TYPES[c.type].uses.includes("harness")) return [];
  return createProvider(c, {}).listModels();
});
route("POST", "/api/connections/:cid/test", async (req, { cid }) => {
  const c = resolveConnection(decodeURIComponent(cid));
  const body = await readJSONBody(req);
  const t0 = Date.now();
  try {
    if (connections.TYPES[c.type].uses.includes("harness")) {
      const p = createProvider(c, {});
      if (body.model) {
        const r = await p.generate({ model: body.model, system: null, parts: [{ text: "Reply with the single word OK." }], maxOutputTokens: 2048, temperature: null, placement: "system", headers: {}, extra: {} });
        return { ok: true, latencyMs: Date.now() - t0, detail: `model answered: ${(r.text || "").trim().slice(0, 40) || "(empty)"}` };
      }
      const models = await p.listModels();
      return { ok: true, latencyMs: Date.now() - t0, detail: `${models.length} models available`, models: models.slice(0, 500) };
    }
    if (!body.uri) return { ok: true, detail: "Saved. Enter a bucket/container path to test listing." };
    const st = openStorage(body.uri, c);
    let n = 0;
    const listing = await st.listAll((k) => { n = k; });
    return { ok: true, latencyMs: Date.now() - t0, detail: `${listing.length} objects visible` };
  } catch (e) { return { ok: false, latencyMs: Date.now() - t0, detail: String(e.message || e).slice(0, 600) }; }
});

// configuration helpers
route("POST", "/api/projects/:id/output/generate", async (req, { id }) => {
  const body = await readJSONBody(req);
  const p = store.loadProject(id);
  return projects.defaultOutput(p.fields, body);
});
route("POST", "/api/projects/:id/render-preview", async (req, { id }) => {
  const body = await readJSONBody(req);
  const p = store.loadProject(id);
  const role = body.role === "generator" ? "generator" : "target";
  const cfg = role === "target" ? p.target : p.generator;
  const conn = cfg.connectionId ? connections.get(cfg.connectionId) : null;
  if (!conn) throw Object.assign(new Error("Pick a connection first"), { status: 400 });
  const prov = createProvider(conn, cfg);
  const redact = require("./lib/apilog").makeRedactor(connections.secretValues(conn));
  let req2;
  if (role === "target") {
    const items = store.readManifest(id).filter((i) => i.split === "train");
    if (!items.length) throw Object.assign(new Error("No training items"), { status: 400 });
    const { MediaPipeline } = require("./lib/media");
    const media = new MediaPipeline(store.projectDir(id), p.target.media || {});
    const { parts, vars } = await media.partsFor(items[0]);
    const sys = require("./lib/template").renderItemPrompt(p.prompt.base, p.prompt, vars);
    req2 = { model: cfg.model, system: sys, parts, schema: p.output.jsonSchema, nativeSchema: p.output.nativeSchema, temperature: cfg.temperature, maxOutputTokens: cfg.maxOutputTokens, placement: cfg.placement, headers: cfg.headers, extra: cfg.extra, stream: false };
  } else {
    req2 = { model: cfg.model, system: null, parts: [{ text: "<meta-prompt>" }], temperature: cfg.temperature, maxOutputTokens: cfg.maxOutputTokens, placement: "system", headers: cfg.headers, extra: cfg.extra, stream: cfg.stream !== false };
  }
  let rendered;
  if (prov.buildRequest) rendered = prov.buildRequest(req2);
  else if (prov.buildBody) rendered = prov.buildBody(req2, req2.schema ? "strict" : "none");
  else if (prov.buildParams) rendered = prov.buildParams(req2).params;
  else if (prov.buildInput) rendered = prov.buildInput(req2, !!req2.schema);
  else rendered = req2;
  const text = JSON.stringify(rendered, (k, v) => (typeof v === "string" && v.length > 400 && /^[A-Za-z0-9+/=]+$/.test(v) ? `<base64 ${v.length} chars>` : Buffer.isBuffer(v) || (v && v.type === "Buffer") ? `<bytes>` : v), 2);
  return { provider: conn.type, rendered: redact(text), headers: Object.keys(cfg.headers || {}) };
});
route("POST", "/api/projects/:id/meta-preview", async (req, { id }) => {
  const body = await readJSONBody(req);
  const p = store.loadProject(id);
  const hist = store.readHistory(id);
  const cp = store.loadCheckpoint(id);
  const fields = p.fields;
  const template = body.template !== undefined ? (body.template || null) : p.method.metaTemplate;
  const best = cp && cp.best ? cp.best : { prompt: p.prompt.base, accuracy: 0, perFieldMetrics: {} };
  const wrongs = hist.length ? method.wrongsForMeta(hist, { prompt: best.prompt, entryId: best.entryId }, (p.method.toggles || {}).matchBestBy) : [];
  return {
    text: method.buildMetaPrompt({
      fields, hasSummary: p.output && p.output.justification && p.output.justification.mode === "main_response",
      bestPrompt: best.prompt, bestAccuracy: best.accuracy, bestMetrics: best.perFieldMetrics, wrongs: wrongs.slice(0, 20),
      history: hist.slice(0, 4), isFirstStep: !(hist.length > 1), candidatesPerStep: p.method.candidatesPerStep || 3,
      targets: p.method.targets, template,
    }),
    basedOn: hist.length ? "current run (first 20 wrongs, first 4 history entries)" : "base prompt (no run yet)",
  };
});

// preflight + run control
route("POST", "/api/projects/:id/preflight", async (req, { id }) => {
  const p = store.loadProject(id);
  const conns = { target: p.target.connectionId ? connections.get(p.target.connectionId) : null, generator: p.generator.connectionId ? connections.get(p.generator.connectionId) : null };
  return startJob("preflight", id, async (progress) => {
    const report = await projects.preflight(p, conns, progress);
    const fresh = store.loadProject(id);
    fresh.preflight = report;
    if (report.learned) fresh.target.learned = report.learned;
    if (report.ok && store.configSha(fresh) === report.configSha) fresh.state = "validated";
    store.saveProject(fresh);
    return report;
  });
});
route("POST", "/api/projects/:id/start", async (req, { id }) => {
  const p = store.loadProject(id);
  const errs = projects.validateForRun(p);
  if (errs.length) throw Object.assign(new Error(errs.join("; ")), { status: 400 });
  const resuming = projects.hasBaseline(id);
  if (!resuming && !(p.preflight && p.preflight.ok && p.preflight.configSha === store.configSha(p))) {
    throw Object.assign(new Error("Run Validate & initialize first (the configuration changed since the last check)"), { status: 409 });
  }
  try { fs.unlinkSync(store.runPaths(id).pause); } catch {}
  startEngine(p);
  return { ok: true, resuming };
});
for (const action of ["pause", "resume", "stop"]) {
  route("POST", `/api/projects/:id/${action}`, async (req, { id }) => {
    if (action === "pause" && !workers.has(id)) { fs.writeFileSync(store.runPaths(id).pause, "pause"); return { ok: true, running: false }; }
    if (!sendToEngine(id, { type: action })) throw Object.assign(new Error("Not running"), { status: 409 });
    if (action === "stop") setTimeout(() => { const w = workers.get(id); if (w) w.child.kill("SIGTERM"); }, 15000).unref();
    return { ok: true };
  });
}
route("POST", "/api/projects/:id/test-eval", async (req, { id }) => {
  if (!sendToEngine(id, { type: "testEval" })) throw Object.assign(new Error("Start or resume the run to evaluate on the test set"), { status: 409 });
  return { ok: true };
});

// dashboard data
route("GET", "/api/projects/:id/summary", async (req, { id }) => {
  const s = store.readSummary(id) || {};
  return Object.assign(s, { running: workers.has(id), state: workerState(id) || s.state || store.loadProject(id).state });
});
route("GET", "/api/projects/:id/history/:entryId", async (req, { id, entryId }) => {
  const e = store.readHistory(id).find((x) => x.id === decodeURIComponent(entryId));
  if (!e) throw Object.assign(new Error("Not found"), { status: 404 });
  return e;
});
route("GET", "/api/projects/:id/steps", async (req, { id }) => store.listSteps(id).map((s) => { const st = store.readStep(id, s); return { step: s, sizeKB: st.sizeKB, timestamp: st.timestamp, candidateCount: st.candidateCount }; }));
route("GET", "/api/projects/:id/steps/:n", async (req, { id, n }) => store.readStep(id, Number(n)) || Promise.reject(Object.assign(new Error("Not found"), { status: 404 })));
route("GET", "/api/projects/:id/results", async (req, { id }, url) => {
  const which = url.searchParams.get("which") === "test" ? "test" : "best";
  const r = store.readResults(id, which);
  if (!r) return { entryId: null, itemResults: [] };
  const { map } = itemIndex(id);
  const excluded = new Set(store.readJSON(path.join(store.projectDir(id), "exclusions.json"), []));
  return { entryId: r.entryId, itemResults: r.itemResults.map((ir) => { const it = map.get(ir.imageId); return Object.assign({}, ir, { split: it ? it.split : null, kind: it && it.input.files && it.input.files[0] ? it.input.files[0].kind : it && it.input.text ? "text" : null, text: it && it.input.text ? it.input.text.slice(0, 300) : undefined, excluded: excluded.has(ir.imageId) }); }) };
});
route("GET", "/api/projects/:id/items", async (req, { id }, url) => {
  const { items } = itemIndex(id);
  const split = url.searchParams.get("split");
  const excluded = new Set(store.readJSON(path.join(store.projectDir(id), "exclusions.json"), []));
  return items.filter((i) => !split || i.split === split).map((i) => ({ id: i.id, split: i.split, labels: i.labels, kind: i.input.files && i.input.files[0] ? i.input.files[0].kind : "text", excluded: excluded.has(i.id) }));
});
route("GET", "/api/projects/:id/apicalls", async (req, { id }, url) => ApiLog.read(store.runPaths(id).api, { cursor: url.searchParams.get("cursor") || null, limit: Math.min(500, Number(url.searchParams.get("limit") || 150)), type: url.searchParams.get("type") || undefined }));
route("GET", "/api/projects/:id/prompt/:hash", async (req, { id, hash }) => ({ text: ApiLog.prompt(store.runPaths(id).api, hash) }));
route("GET", "/api/projects/:id/logs", async (req, { id }, url) => {
  const p = store.runPaths(id).log;
  if (!fs.existsSync(p)) return { text: "", offset: 0 };
  const size = fs.statSync(p).size;
  let offset = Number(url.searchParams.get("offset"));
  if (!Number.isFinite(offset) || offset > size || offset < 0) offset = Math.max(0, size - 64 * 1024);
  const len = Math.min(size - offset, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(p, "r");
  fs.readSync(fd, buf, 0, len, offset);
  fs.closeSync(fd);
  return { text: buf.toString("utf8"), offset: offset + len };
});
route("GET", "/api/projects/:id/export/checkpoint", async (req, { id }, url, res) => {
  const data = store.exportLegacyCheckpoint(id);
  if (!data) throw Object.assign(new Error("No run yet"), { status: 404 });
  send(res, 200, JSON.stringify(data), { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="wpo_${id}_checkpoint.json"` });
  return undefined;
});
route("GET", "/api/projects/:id/snapshot", async (req, { id }, url, res) => {
  const html = require("./lib/snapshot").buildSnapshot(id);
  send(res, 200, html, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="wpo_snapshot_${id}_${Date.now()}.html"` });
  return undefined;
});
route("GET", "/api/jobs/:jid", async (req, { jid }) => {
  const j = jobs.get(jid);
  if (!j) throw Object.assign(new Error("Job not found"), { status: 404 });
  return j;
});

// ─── server ───
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(String(req.headers.host || ""))) return send(res, 421, "Misdirected request");
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      const token = req.headers["x-wpo-token"] || url.searchParams.get("token");
      if (token !== TOKEN) return send(res, 403, { error: "Missing or wrong token — reload the page" });
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.origin;
        if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, { error: "Cross-origin request refused" });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
        if (params.id) store.projectDir(params.id); // validates the id shape
        const out = await r.handler(req, params, url, res);
        if (out !== undefined && !res.headersSent) send(res, 200, out);
        return undefined;
      }
      return send(res, 404, { error: "Not found" });
    }
    // static files from public/ only
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const abs = path.join(PUBLIC, rel);
    let real;
    try { real = fs.realpathSync(abs); } catch { return send(res, 404, "Not found"); }
    if (!real.startsWith(PUBLIC + path.sep) || !fs.statSync(real).isFile()) return send(res, 404, "Not found");
    let body = fs.readFileSync(real);
    if (rel === "/index.html") body = Buffer.from(body.toString("utf8").replace("__WPO_TOKEN__", TOKEN));
    return send(res, 200, body, { "Content-Type": STATIC_TYPES[path.extname(real)] || "application/octet-stream", "Content-Security-Policy": "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'" });
  } catch (err) {
    const status = err.status || (/not found/i.test(err.message) ? 404 : 400);
    if (!res.headersSent) send(res, status, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WPO general: http://${HOST}:${PORT}/`);
});

function shutdown() {
  for (const [id, w] of workers) { try { w.child.kill("SIGTERM"); } catch {} }
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = { server, TOKEN };
