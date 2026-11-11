// End-to-end differential test: the ORIGINAL engine's main() loop and the new Engine run side by side
// for several steps on the same small dataset, both talking to the same deterministic fake Gemini SDK.
// Every history entry (prompt, accuracy, per-field metrics, wrong predictions + justifications), every
// meta-prompt, the best prompt and the counters must be identical.
// Local only: needs the original engine source and the senior-care base prompt (both kept out of the public repo).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const { loadLegacyEngine, toHost, ORIGINAL_AVAILABLE } = require("./legacy/legacy_ref");
const { tmpDir } = require("./helpers");
const legacy = require("../lib/presets/legacy");

function h01(s) { return parseInt(crypto.createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0x100000000; }

// Deterministic fake model. Stateless per request except a per-request "first call returns JSON
// without b" quirk (exercises the retry path identically in both engines).
function makeFakeModel(steps, onGeneratorPastEnd) {
  const seen = new Map();
  let seenGen = 0;
  return async (req) => {
    const cfg = req.config || {};
    const parts = req.contents[0].parts;
    if (cfg.responseSchema) {
      const data = parts[0].inlineData.data;
      const key = crypto.createHash("sha1").update(`${cfg.systemInstruction}|${data}|${JSON.stringify(cfg.responseSchema)}`).digest("hex");
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (h01(key + "quirk") < 0.05 && n === 1) return { text: JSON.stringify({ s: "no b here" }) };
      if (h01(key + "garbage") < 0.04) return { text: "I cannot comply" };
      const quality = Math.min(6, (cfg.systemInstruction.match(/careful/gi) || []).length);
      const timing = /TIMING: This grid shows/.test(cfg.systemInstruction) ? 0.08 : 0;
      const maxItems = cfg.responseSchema.properties.b.maxItems;
      const b = [];
      for (let i = 0; i < maxItems; i++) if (h01(`${key}|${i}`) < 0.25 + 0.05 * quality + timing) b.push(i);
      if (h01(key + "dup") < 0.1 && b.length) b.push(b[0]); // duplicate index
      const out = cfg.responseSchema.properties.s ? { s: `summary ${key.slice(0, 6)}`, b } : { b };
      return { text: JSON.stringify(out) };
    }
    // generator
    const meta = parts[0].text;
    const m = meta.match(/=== BEST PERFORMING PROMPT[^\n]*\n[\s\S]*?<PROMPT>\n([\s\S]*?)\n<\/PROMPT>/);
    const best = m ? m[1] : "";
    const genIndex = seenGen++;
    if (genIndex >= steps) { onGeneratorPastEnd(); return new Promise(() => {}); }
    const r = h01(meta);
    const cands = [];
    if (genIndex === 2) return { text: "<PROMPT>too short</PROMPT>" }; // no valid candidates → stale
    for (let k = 0; k < 3; k++) {
      let p;
      if (k === 0 && genIndex === 3) p = best; // regenerate the best prompt verbatim (string-match shadowing)
      else if (k === 2 && r < 0.5) p = best.replace(/careful/gi, "quick");
      else p = `${best}\nBe careful (${genIndex}.${k}).${k === 1 ? " Be careful." : ""}`;
      if (k === 1 && genIndex === 4) p = cands[0]; // duplicate candidate in one step
      cands.push(p);
    }
    return { text: cands.map((c, i) => `<PROMPT id="${i}">\n${c}\n</PROMPT>`).join("\n") };
  };
}

async function makeGrids(root, fields) {
  let colour = 0;
  for (const f of fields) {
    for (const pol of ["positive", "negative"]) {
      for (const split of ["training", "test"]) {
        const d = path.join(root, `${f.key}_${pol}`, split);
        fs.mkdirSync(d, { recursive: true });
        const n = split === "training" ? (f.key === "c_empty" && pol === "positive" ? 0 : 4) : 1;
        for (let i = 0; i < n; i++) {
          colour++;
          const file = path.join(d, `clip_${String(i).padStart(2, "0")}.png`);
          await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: (colour * 37) % 256, g: (colour * 91) % 256, b: (colour * 13) % 256 } } }).png().toFile(file);
          if (i % 2 === 0) fs.writeFileSync(file.replace(/\.png$/, ".meta.json"), JSON.stringify({ duration: 5 + colour / 10, interval: (5 + colour / 10) / 5 }));
        }
      }
    }
  }
}

async function runBoth(category, steps) {
  const fields = [
    { key: "a_fall", bIdx: 0, desc: "Resident has fallen." },
    { key: "b_bed_exit", bIdx: 1, desc: "Resident is getting out of bed." },
    { key: "c_empty", bIdx: 2, desc: "No positives exist for this one." },
  ];
  const root = tmpDir("wpo-diff-");
  const grids = path.join(root, "orig", "grids");
  await makeGrids(grids, fields);

  // ── original engine ──
  const origDir = path.join(root, "orig");
  let origDone;
  const origFinished = new Promise((r) => { origDone = r; });
  const origModel = makeFakeModel(steps, () => origDone());
  loadLegacyEngine({ categoryName: category, port: 0, photosBase: "./grids", checkpointPath: path.join(origDir, "cp.json"), logFile: "run.log", pauseFile: "run.pause", proModel: "gemini-3.1-pro-preview", useFlex: true, fields },
    { dir: origDir, noMain: false, genai: { generateContent: origModel } });
  await origFinished;
  await new Promise((r) => setTimeout(r, 50));
  const orig = JSON.parse(fs.readFileSync(path.join(origDir, "cp.json"), "utf8"));

  // ── new engine (real google.js provider over the same fake SDK) ──
  process.env.WPO_PROJECTS_DIR = path.join(root, "projects");
  const appRoot = path.join(__dirname, "..");
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(appRoot, "lib") + path.sep) || k === path.join(appRoot, "engine.js")) delete require.cache[k];
  const genaiPath = require.resolve("@google/genai");
  const realGenai = require.cache[genaiPath];
  const newModel = makeFakeModel(steps, () => {});
  require.cache[genaiPath] = { id: genaiPath, filename: genaiPath, loaded: true, exports: { GoogleGenAI: class { constructor() { this.models = { generateContent: newModel, list: async () => [] }; } } } };
  try {
    const store = require("../lib/store");
    const datasets = require("../lib/dataset");
    const categorizer = require("../lib/dataset/categorizer");
    const { Engine } = require("../engine");
    const id = "diff-test";
    const settings = legacy.legacyProjectSettings({ categoryName: category, proModel: "gemini-3.1-pro-preview", useFlex: true, fields });
    fs.mkdirSync(store.projectDir(id), { recursive: true });
    store.saveProject({ id, name: "diff", state: "draft", createdAt: new Date().toISOString() });
    const scan = await datasets.scan(id, { uri: grids }, null);
    const map = scan.suggestions;
    const committed = await datasets.commitFolders(id, map, { classOrder: fields.map((f) => f.key), legacyMeta: true, mode: "clone" }, null);
    const project = store.loadProject(id);
    Object.assign(project, {
      fields: settings.fields, prompt: settings.prompt, output: settings.output,
      target: Object.assign(settings.target, { connectionId: "x" }), generator: Object.assign(settings.generator, { connectionId: "y" }),
      method: { candidatesPerStep: 3, minCandidateChars: 200, targets: { tpr: 80, tnr: 80, score: 80 }, toggles: Object.assign({}, settings.toggles, { matchBestBy: "prompt" }), stop: { maxSteps: steps }, smoke: false },
      dataset: { datasetSha: committed.datasetSha }, logging: { apiLog: "compact" },
    });
    store.saveProject(project);
    const conn = { type: "vertex", fields: { project: "p", location: "global" } };
    const engine = new Engine(id, { connections: { target: conn, generator: conn }, send: () => {} });
    await engine.run();
    const cp = store.loadCheckpoint(id);
    const history = store.readHistory(id);
    const metas = store.listSteps(id).map((s) => store.readStep(id, s));
    return { orig, cp, history, metas, committed };
  } finally {
    if (realGenai) require.cache[genaiPath] = realGenai; else delete require.cache[genaiPath];
  }
}

for (const category of ["health", "alerts"]) {
  test(`original main() vs new Engine: identical run for ${category} (${category === "alerts" ? "summary in main response" : "separate justification pass"})`,
    { skip: !ORIGINAL_AVAILABLE || !legacy.HAS_LEGACY_BASE_PROMPT }, async () => {
    const steps = 6;
    const { orig, cp, history, metas } = await runBoth(category, steps);
    const oh = orig.promptHistory;
    assert.strictEqual(history.length, oh.length, "history length");
    for (let i = 0; i < oh.length; i++) {
      const a = history[i], e = oh[i];
      assert.strictEqual(a.step, e.step, `entry ${i} step`);
      assert.strictEqual(a.prompt, e.prompt, `entry ${i} prompt`);
      assert.ok(Object.is(a.accuracy, e.accuracy), `entry ${i} accuracy ${a.accuracy} vs ${e.accuracy}`);
      assert.deepStrictEqual(a.perFieldMetrics, toHost(e.perFieldMetrics), `entry ${i} metrics`);
      const strip = (ws) => ws.map((w) => ({ imageId: w.imageId, fieldKey: w.fieldKey, bIdx: w.bIdx, expected: w.expected, actual: w.actual, detectedB: w.detectedB, justification: w.justification }));
      assert.deepStrictEqual(strip(a.wrongPredictions), strip(toHost(e.wrongPredictions)), `entry ${i} wrongs`);
    }
    assert.strictEqual(cp.best.prompt, orig.bestPrompt);
    assert.ok(Object.is(cp.best.accuracy, orig.bestAccuracy));
    assert.strictEqual(cp.currentStep, orig.currentStep);
    assert.strictEqual(cp.staleSteps, orig.staleSteps);
    const om = orig.metaPromptHistory;
    assert.strictEqual(metas.length, om.length, "meta-prompt count");
    for (let i = 0; i < om.length; i++) {
      assert.strictEqual(metas[i].step, om[i].step);
      assert.strictEqual(metas[i].metaPrompt, om[i].metaPrompt, `meta-prompt step ${om[i].step}`);
    }
    // the scenario must actually exercise the interesting paths
    assert.ok(oh.some((e) => e.wrongPredictions.some((w) => w.justification)), "justifications exercised");
    assert.notStrictEqual(orig.bestPrompt, orig.basePrompt, "at least one candidate was accepted");
    const stepsWithEntries = new Set(oh.map((e) => e.step));
    assert.ok([...Array(steps).keys()].map((i) => i + 1).some((s) => !stepsWithEntries.has(s)), "a step with no valid candidates (stale) happened");
    assert.ok(oh.some((e, i) => e.step > 0 && oh.slice(0, i).some((p) => p.prompt === e.prompt)), "a candidate repeated an earlier prompt verbatim");
    assert.ok(history.some((e) => e.accepted && e.step > 0), "accepted flag recorded");
  });
}
