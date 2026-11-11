// End-to-end runs with the mock harnesses (no API spend): folder dataset with images, manifest dataset
// with text items and categorical / number / text / binary labels, kill -9 + resume from the journal,
// pause/resume, test-eval persistence, exclusions, stop conditions.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { fork } = require("child_process");
const sharp = require("sharp");
const { tmpDir } = require("./helpers");

const ROOT = tmpDir("wpo-e2e-");
process.env.WPO_PROJECTS_DIR = path.join(ROOT, "projects");
const store = require("../lib/store");
const datasets = require("../lib/dataset");
const projects = require("../lib/projects");
const { Engine } = require("../engine");

const MOCK = { type: "mock", fields: { behavior: "keyword", latencyMs: "1" } };

async function imageFolders(root) {
  let c = 0;
  const mk = async (dir, n) => {
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) { c++; await sharp({ create: { width: 32, height: 18, channels: 3, background: { r: (c * 53) % 256, g: (c * 29) % 256, b: (c * 7) % 256 } } }).png().toFile(path.join(dir, `img_${String(i).padStart(3, "0")}.png`)); }
  };
  await mk(path.join(root, "falls_positive"), 30);
  await mk(path.join(root, "falls_negative"), 30);
  await mk(path.join(root, "bed exit", "pos"), 30);
  await mk(path.join(root, "bed exit", "neg"), 30);
  await mk(path.join(root, "unrelated"), 5);
}

function newProject(name) {
  const p = projects.newProject(name);
  fs.mkdirSync(store.projectDir(p.id), { recursive: true });
  store.saveProject(p);
  return p.id;
}

async function configure(id, extra = {}) {
  const p = store.loadProject(id);
  Object.assign(p.target, { connectionId: "mock", model: "mock-target", concurrency: 20 });
  Object.assign(p.generator, { connectionId: "mock", model: "mock-generator" });
  p.prompt.base = extra.base || "You are a classifier. Report the conditions.\n";
  if (extra.method) Object.assign(p.method, extra.method);
  store.saveProject(p);
  return p;
}

test("folder dataset: categorizer → baseline → steps improve → stop condition", async () => {
  const src = path.join(ROOT, "src1");
  await imageFolders(src);
  const id = newProject("e2e folders");
  const scan = await datasets.scan(id, { uri: src }, null);
  assert.ok(scan.suggestions.length >= 4);
  const map = scan.suggestions.concat([{ path: "bed exit/neg", tags: [{ class: "bed exit", polarity: "negative" }, { class: "falls", polarity: "negative" }] }]);
  const committed = await datasets.commitFolders(id, map, { trainRatio: 0.75 }, null);
  const p = store.loadProject(id);
  p.fields = committed.fields;
  p.dataset = { datasetSha: committed.datasetSha };
  p.output = projects.defaultOutput(p.fields, {});
  store.saveProject(p);
  assert.strictEqual(p.output.style, "index_array");
  await configure(id, { method: { stop: { maxSteps: 4 } } });
  const engine = new Engine(id, { connections: { target: MOCK, generator: MOCK }, send: () => {} });
  await engine.run();
  const cp = store.loadCheckpoint(id);
  const hist = store.readHistory(id);
  assert.strictEqual(cp.currentStep, 5);
  assert.ok(hist.length >= 1 + 3 * 3, `history ${hist.length}`);
  assert.ok(cp.best.accuracy > hist[0].accuracy, `improved ${hist[0].accuracy} → ${cp.best.accuracy}`);
  assert.ok(hist.filter((e) => e.accepted).length >= 2);
  const summary = store.readSummary(id);
  assert.strictEqual(summary.state, "completed");
  assert.ok(summary.spend.target.calls > 0 && summary.spend.generator.calls === 5); // 4 steps + 1 startup smoke check;
  const best = store.readResults(id, "best");
  assert.strictEqual(best.entryId, cp.best.entryId);
  // legacy export has the original field names
  const legacyCp = store.exportLegacyCheckpoint(id);
  assert.ok(legacyCp.promptHistory.length === hist.length && legacyCp.bestImageResults.length > 0 && legacyCp.metaPromptHistory.length === 4);
});

test("manifest dataset: text items, categorical / number / text / binary labels, named-field output", async () => {
  const src = path.join(ROOT, "src2");
  fs.mkdirSync(src, { recursive: true });
  const rows = [];
  const intents = ["greet", "complain", "ask"];
  for (let i = 0; i < 60; i++) {
    rows.push(JSON.stringify({ id: `t${i}`, text: `Message number ${i} from a customer about order ${1000 + i}.`, intent: intents[i % 3], urgent: i % 4 === 0, order: 1000 + i, lang: i % 2 ? "en" : "de", split: i % 5 === 0 ? "test" : "train" }));
  }
  fs.writeFileSync(path.join(src, "data.jsonl"), rows.join("\n"));
  const id = newProject("e2e manifest");
  const scan = await datasets.scan(id, { uri: src }, null);
  assert.deepStrictEqual(scan.manifests, ["data.jsonl"]);
  const pv = await datasets.previewManifest(id, "data.jsonl", null);
  const roles = pv.roles;
  roles.text = { role: "text" };
  roles.order = { role: "label", type: "number" };
  roles.lang = { role: "label", type: "text" };
  const committed = await datasets.commitManifest(id, "data.jsonl", roles, {}, null);
  const types = Object.fromEntries(committed.fields.map((f) => [f.key, f.type]));
  assert.deepStrictEqual(types, { intent: "categorical", urgent: "binary", order: "number", lang: "text" });
  const p = store.loadProject(id);
  p.fields = committed.fields;
  p.dataset = { datasetSha: committed.datasetSha };
  p.output = projects.defaultOutput(p.fields, {});
  assert.strictEqual(p.output.style, "named");
  store.saveProject(p);
  await configure(id, { method: { stop: { maxSteps: 2, testEvalOnStop: true } } });
  const engine = new Engine(id, { connections: { target: MOCK, generator: MOCK }, send: () => {} });
  await engine.run();
  const cp = store.loadCheckpoint(id);
  assert.strictEqual(cp.currentStep, 3);
  assert.ok(cp.testEval && cp.testEval.entryId === cp.best.entryId, "test eval ran for the final best prompt when the run stopped");
  const m = cp.best.perFieldMetrics;
  assert.ok(m.intent.perClass && Object.keys(m.intent.perClass).length === 3);
  assert.ok(typeof m.order.score === "number" && typeof m.lang.score === "number" && typeof m.urgent.tpr === "number");
  const meta = store.readStep(id, 1).metaPrompt;
  assert.ok(meta.startsWith("TASK: You are optimizing a complete system prompt for a vision-language model"), "original meta-prompt wording by default");
  assert.ok(/Expected: \w+ \| Actual:/.test(meta) || /\(none\)/.test(meta));
});

function runWorker(id, conns) {
  const child = fork(path.join(__dirname, "..", "engine.js"), [id], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: Object.assign({}, process.env) });
  const msgs = [];
  child.on("message", (m) => { msgs.push(m); if (m.type === "spawned") child.send({ type: "init", connections: conns }); });
  return { child, msgs };
}
const waitFor = async (fn, ms = 60000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

test("worker process: kill -9 mid-step resumes from the journal; pause/resume; test eval persists; exclusions", async () => {
  const src = path.join(ROOT, "src3");
  await imageFolders(src);
  const id = newProject("e2e worker");
  const scan = await datasets.scan(id, { uri: src }, null);
  const committed = await datasets.commitFolders(id, scan.suggestions, {}, null);
  const p = store.loadProject(id);
  p.fields = committed.fields;
  p.dataset = { datasetSha: committed.datasetSha };
  p.output = projects.defaultOutput(p.fields, {});
  store.saveProject(p);
  const slow = { type: "mock", fields: { behavior: "keyword", latencyMs: "15" } };
  await configure(id, { method: { stop: { maxSteps: 3 } } });

  // run 1: kill -9 during step 1's evaluation
  let w = runWorker(id, { target: slow, generator: slow });
  await waitFor(() => fs.existsSync(path.join(store.runPaths(id).steps, "1.calls.jsonl")) && fs.readFileSync(path.join(store.runPaths(id).steps, "1.calls.jsonl"), "utf8").split("\n").length > 40);
  w.child.kill("SIGKILL");
  await new Promise((r) => w.child.on("exit", r));
  const journaled = fs.readFileSync(path.join(store.runPaths(id).steps, "1.calls.jsonl"), "utf8").split("\n").filter(Boolean).length;
  const cpMid = store.loadCheckpoint(id);
  assert.strictEqual(cpMid.currentStep, 1, "baseline saved, step 1 not yet");

  // run 2: resume; the journal must be reused (generator not called again for step 1)
  w = runWorker(id, { target: slow, generator: slow });
  await waitFor(() => w.msgs.some((m) => m.type === "ready"));
  w.child.send({ type: "pause" });
  await waitFor(() => (store.readSummary(id) || {}).state === "paused" || store.loadCheckpoint(id).currentStep >= 2, 60000);
  w.child.send({ type: "resume" });
  await waitFor(() => store.loadCheckpoint(id).currentStep >= 2, 60000);
  // test eval while running; must survive later saves (the original lost it)
  w.child.send({ type: "testEval" });
  await waitFor(() => w.msgs.some((m) => m.type === "testEvalDone"), 60000);
  const someTest = store.readManifest(id).find((i) => i.split === "train");
  w.child.send({ type: "exclude", itemId: someTest.id });
  await waitFor(() => w.msgs.some((m) => m.type === "stopped"), 120000);
  await new Promise((r) => w.child.on("exit", r));
  const cp = store.loadCheckpoint(id);
  assert.strictEqual(cp.currentStep, 4);
  assert.ok(cp.testEval && typeof cp.testEval.overallAccuracy === "number", "test eval persisted across later saves");
  const gen = fs.readdirSync(store.runPaths(id).api).filter((f) => f.startsWith("calls-")).flatMap((f) => fs.readFileSync(path.join(store.runPaths(id).api, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.type === "GENERATOR");
  assert.strictEqual(gen.filter((r) => r.step === 1).length, 1, "generator called once for step 1 despite the crash");
  assert.ok(journaled > 40);
  const best = store.readResults(id, "best");
  assert.ok(!best.itemResults.some((r) => r.imageId === someTest.id), "excluded item removed from best results");
  const hist = store.readHistory(id);
  assert.ok(hist.length === cp.historyCount);
});

test("needs-attention: persistent auth failure pauses instead of retrying forever", async () => {
  const id = newProject("e2e attention");
  const src = path.join(ROOT, "src4");
  await imageFolders(src);
  const scan = await datasets.scan(id, { uri: src }, null);
  const committed = await datasets.commitFolders(id, scan.suggestions, {}, null);
  const p = store.loadProject(id);
  p.fields = committed.fields; p.dataset = { datasetSha: committed.datasetSha }; p.output = projects.defaultOutput(p.fields, {});
  p.method.toggles.persistentErrorLimit = 2;
  store.saveProject(p);
  await configure(id, { method: { stop: { maxSteps: 1 } } });
  const sent = [];
  const engine = new Engine(id, { connections: { target: { type: "mock", fields: { behavior: "auth-fail" } }, generator: MOCK }, send: (m) => sent.push(m) });
  engine.target && 0;
  const run = engine.run();
  await waitFor(() => sent.some((m) => m.type === "attention"), 120000);
  const a = sent.find((m) => m.type === "attention");
  assert.strictEqual(a.kind, "auth");
  assert.strictEqual(store.readSummary(id).state, "needs_attention");
  engine.stopRequested = true;
  engine.attention = null;
  await run;
});
