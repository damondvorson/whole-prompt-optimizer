// Differential tests: new lib/ code vs the ORIGINAL engine functions (loaded verbatim in a sandbox).
// The original source is local-only. With it present, every fuzz case is compared live against the original;
// without it (public checkout), each case is compared against a fingerprint of the original's output recorded
// in test/golden/legacy_golden.json. Re-record (needs the original source):
//   WPO_RECORD_GOLDEN=1 node --test test/legacy.test.js
"use strict";
const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const { loadLegacyEngine, toHost, ORIGINAL_AVAILABLE, ORIGINAL_SHA256 } = require("./legacy/legacy_ref");
const { rng, tmpDir, LEGACY_DIR } = require("./helpers");
const method = require("../lib/method");
const scoring = require("../lib/scoring");
const { extractJSON } = require("../lib/parse");
const { renderItemPrompt } = require("../lib/template");
const legacy = require("../lib/presets/legacy");
const { indexArrayOutput, justificationSchemas } = require("../lib/schema");

// ── golden fingerprints ──
const GOLDEN_FILE = path.join(__dirname, "golden", "legacy_golden.json");
const RECORD = process.env.WPO_RECORD_GOLDEN === "1";
if (RECORD && !ORIGINAL_AVAILABLE) throw new Error("WPO_RECORD_GOLDEN needs the original engine source");
const golden = !RECORD && fs.existsSync(GOLDEN_FILE) ? JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8")) : null;
const recorded = {};
const SERIES = ["metaPrompt", "candidates", "extractJSON", "timing"];
const FP = 16; // hex chars per case

// Canonical JSON (sorted keys) so fingerprints don't depend on property order.
function canonical(v) {
  if (v === undefined) return "\u0000undefined";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
function fingerprint(v) {
  return crypto.createHash("sha256").update(typeof v === "string" ? v : canonical(v)).digest("hex").slice(0, FP);
}

// One fingerprint per fuzz case, checked against (or recorded into) the golden file when the test finishes.
function goldenSeries(name) {
  const fps = [];
  return {
    add(original) { fps.push(fingerprint(original)); },
    finish() {
      if (RECORD) { recorded[name] = fps.join(""); return; }
      if (!golden) {
        assert.ok(ORIGINAL_AVAILABLE, "neither the original engine source nor test/golden/legacy_golden.json is available");
        return;
      }
      const g = golden[name];
      assert.strictEqual(typeof g, "string", `golden series ${name} missing`);
      assert.strictEqual(fps.length, g.length / FP, `${name}: case count`);
      fps.forEach((f, i) => {
        if (f !== g.slice(i * FP, (i + 1) * FP)) assert.fail(`${name}: case ${i} differs from the original engine's recorded output`);
      });
    },
  };
}

after(() => {
  if (!RECORD) return;
  if (![...SERIES, "scoring"].every((k) => k in recorded)) {
    console.error("golden NOT written: some fidelity tests failed");
    return;
  }
  const body = Object.assign({
    _about: "Fingerprints (first 16 hex chars of sha256, one per fuzz case, in order) of the ORIGINAL wpo_video_engine.js " +
      "outputs for the seeded fuzz cases in test/legacy.test.js, plus the scoring datasets with the original's metrics. " +
      "Recorded with WPO_RECORD_GOLDEN=1 from the original source.",
    originalSha256: ORIGINAL_SHA256,
  }, recorded);
  fs.mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
  fs.writeFileSync(GOLDEN_FILE, "{\n" + Object.entries(body).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n") + "\n}\n");
  console.log(`golden written: ${GOLDEN_FILE}`);
});

function legacyConfig(dir, fields, categoryName) {
  return {
    categoryName, port: 0, photosBase: "./grids", checkpointPath: path.join(dir, "cp.json"),
    logFile: "run.log", pauseFile: "run.pause", fields,
  };
}

// Original functions, or null in a public checkout (the RNG is consumed identically either way).
function originalApi(fields, categoryName, extra) {
  if (!ORIGINAL_AVAILABLE) return null;
  const dir = tmpDir();
  return loadLegacyEngine(legacyConfig(dir, fields, categoryName), Object.assign({ dir, noMain: true }, extra)).api;
}

function randomFields(r) {
  const n = r.int(1, 14);
  const permute = r.bool(0.3);
  const idx = permute ? r.shuffle([...Array(n).keys()]) : [...Array(n).keys()];
  const names = ["is_resident_fall", "is_staff_assisting_transfer", "x", "is_hazard_clutter_on_floor", "people_count", "a.b", "weird key", "k"];
  return [...Array(n).keys()].map((i) => ({ key: `${r.pick(names)}_${i}`, bIdx: idx[i], desc: r.text(1, 8) }));
}

test("meta-prompt: default template is byte-identical to the original buildWPOMetaPrompt (fuzz)", () => {
  const r = rng(1234);
  const series = goldenSeries("metaPrompt");
  let cases = 0;
  for (let cfgIdx = 0; cfgIdx < 60; cfgIdx++) {
    const fields = randomFields(r);
    const hasSummary = r.bool();
    const category = hasSummary ? "alerts" : r.pick(["staff", "health"]);
    const api = originalApi(fields, category);
    const newFields = fields.map((f) => ({ key: f.key, index: f.bIdx, type: "binary" }));
    for (let c = 0; c < 30; c++) {
      const metrics = {};
      for (const f of fields) if (r.bool(0.85)) metrics[f.key] = { tpr: r.float(), tnr: r.float() };
      const wrongs = [];
      const nw = r.pick([0, 0, 1, 3, 12]);
      for (let i = 0; i < nw; i++) {
        const f = r.pick(fields);
        const expected = r.bool();
        wrongs.push({ imageId: `${f.key}_${expected ? "positive" : "negative"}/training/${r.text(1, 3)}`, fieldKey: f.key, bIdx: f.bIdx, expected, actual: !expected, justification: r.pick(["", "", r.text(0, 40), JSON.stringify({ s: r.text(1, 10), b: [1, 2] }, null, 2)]) });
      }
      const history = [];
      const nh = r.pick([0, 1, 4, 9]);
      for (let i = 0; i < nh; i++) history.push({ step: i === 0 ? 0 : r.int(1, 30), accuracy: r.float(), prompt: r.text(0, 60) });
      const isFirstStep = r.bool(0.3);
      const bestPrompt = r.text(0, 80);
      const bestAccuracy = r.float();
      const actual = method.buildMetaPrompt({
        fields: newFields, hasSummary, bestPrompt, bestAccuracy, bestMetrics: metrics, wrongs, history,
        isFirstStep, candidatesPerStep: 3, targets: { tpr: 80, tnr: 80 }, template: null,
      });
      let original = actual;
      if (api) {
        api.setLiveCp({ bestPerFieldMetrics: metrics });
        original = api.buildWPOMetaPrompt(bestPrompt, bestAccuracy, wrongs, history, isFirstStep);
        assert.strictEqual(actual, original, `case cfg=${cfgIdx} c=${c}`);
      }
      series.add(original);
      cases++;
    }
  }
  assert.ok(cases >= 1800);
  series.finish();
});

test("meta-prompt: explicitly passing the original template text gives the same bytes", () => {
  const fields = [{ key: "a", index: 0, type: "binary" }, { key: "b", index: 1, type: "binary" }];
  const opts = { fields, hasSummary: false, bestPrompt: "P", bestAccuracy: 50, bestMetrics: { a: { tpr: 80, tnr: 79.95 } }, wrongs: [], history: [{ step: 0, accuracy: 50, prompt: "P" }], isFirstStep: false, candidatesPerStep: 3 };
  assert.strictEqual(method.buildMetaPrompt({ ...opts, template: method.ORIGINAL_META_TEMPLATE }), method.buildMetaPrompt(opts));
});

test("extractPromptCandidates matches the original (fuzz)", () => {
  const r = rng(99);
  const series = goldenSeries("candidates");
  const api = originalApi([{ key: "a", bIdx: 0, desc: "d" }], "health");
  const frags = ["<PROMPT>", "</PROMPT>", "<prompt>", "</prompt>", "<PROMPT v=\"1\">", "<PROMPTS>", "</PROMPT >", "\n", "  "];
  for (let i = 0; i < 3000; i++) {
    const parts = [];
    const n = r.int(0, 12);
    for (let j = 0; j < n; j++) parts.push(r.bool(0.4) ? r.pick(frags) : "x".repeat(r.pick([0, 5, 150, 199, 200, 201, 260])) + r.text(0, 5));
    const text = parts.join("");
    const actual = method.extractPromptCandidates(text);
    let original = actual;
    if (api) {
      original = toHost(api.extractPromptCandidates(text));
      assert.deepStrictEqual(actual, original, `case ${i}`);
    }
    series.add(original);
  }
  series.finish();
});

test("extractJSON matches the original (fuzz)", () => {
  const r = rng(7);
  const series = goldenSeries("extractJSON");
  const api = originalApi([{ key: "a", bIdx: 0, desc: "d" }], "health");
  const samples = ["", "null", "123", "\"s\"", "{}", "{\"b\":[1,2]}", "```json\n{\"b\":[3]}\n```", "here: {\"s\":\"x\",\"b\":[0]} done", "{bad", "{\"b\":[1]} {\"b\":[2]}", "```\n[1,2]\n```", "{\"s\":\"a}\",\"b\":[]}"];
  for (let i = 0; i < 2000; i++) {
    const text = r.bool(0.5) ? r.pick(samples) : r.pick(samples) + r.text(0, 6) + r.pick(samples);
    const actual = toHost(extractJSON(text).value);
    let original = actual;
    if (api) {
      original = toHost(api.extractJSON(text));
      assert.deepStrictEqual(actual, original, `case ${i}: ${JSON.stringify(text)}`);
    }
    series.add(original);
  }
  series.finish();
});

test("timing injection: legacy rule + {{timing_line}} reproduces injectTiming", () => {
  const r = rng(5);
  const series = goldenSeries("timing");
  const api = originalApi([{ key: "a", bIdx: 0, desc: "d" }], "health");
  for (let i = 0; i < 1000; i++) {
    const meta = { duration: r.pick([8, 15.028, 0.4, r.next() * 30]), interval: r.pick([1.6, 3.0056000000000003, r.next() * 6]) };
    const id = `item${i}`;
    const s = legacy.LEGACY_TIMING_SENTENCE;
    const prompt = r.pick([r.text(0, 20), `${r.text(0, 10)}${s}${r.text(0, 10)}`, `${s}\n${s}`, s.replace("TIMING", "timing")]);
    const actual = renderItemPrompt(prompt, { rules: [{ find: s, replace: "{{timing_line}}" }], placeholders: false }, { timing_line: legacy.legacyTimingLine(meta) });
    let original = actual;
    if (api) {
      api.imageB64Cache.set(id + "::meta", meta);
      original = api.injectTiming(prompt, { id });
      assert.strictEqual(actual, original, `case ${i}`);
    }
    series.add(original);
  }
  series.finish();
});

const RUNNERS = ["staff", "alerts", "health"].map((c) => path.join(LEGACY_DIR, `wpo_video_${c}.js`));

test("legacy base prompt + runner import match the original buildBasePrompt",
  { skip: !ORIGINAL_AVAILABLE || !legacy.HAS_LEGACY_BASE_PROMPT || !RUNNERS.every((p) => fs.existsSync(p)) }, () => {
    for (const runner of RUNNERS) {
      const cfg = legacy.importLegacyRunner(runner);
      const api = originalApi(cfg.fields, cfg.categoryName);
      assert.strictEqual(legacy.legacyBuildBasePrompt(cfg.categoryName, cfg.fields), api.buildBasePrompt());
      const settings = legacy.legacyProjectSettings(cfg);
      assert.strictEqual(settings.prompt.base, api.buildBasePrompt());
      // schemas sent to Gemini must be the original objects
      assert.deepStrictEqual(settings.output.nativeSchema, toHost(api.RESPONSE_SCHEMA));
      if (cfg.categoryName !== "alerts") {
        assert.deepStrictEqual(justificationSchemas(settings.output).nativeSchema, toHost(api.JUSTIFICATION_SCHEMA));
      }
      assert.strictEqual(settings.generator.model, cfg.proModel);
    }
  });

const SCORE_KEYS = ["tp", "fn", "tn", "fp", "posCount", "negCount", "tpr", "tnr"];

// Scoring: run the ORIGINAL evaluatePrompt (real sharp + stubbed Gemini) on random datasets. Each dataset is
// kept as {fields, items [fieldKey, positive, model output text] in the original's order, original metrics}.
async function originalScoringDatasets() {
  const r = rng(42);
  const datasets = [];
  for (let ds = 0; ds < 25; ds++) {
    const dir = tmpDir();
    const fields = randomFields(r).slice(0, r.int(1, 8));
    // bIdx must be < field count for realistic data, but keep permutations
    fields.forEach((f, i) => { f.bIdx = i; });
    if (r.bool(0.3)) { const s = r.shuffle(fields.map((f) => f.bIdx)); fields.forEach((f, i) => { f.bIdx = s[i]; }); }
    let colour = 0;
    for (const f of fields) {
      for (const pol of ["positive", "negative"]) {
        const n = r.pick([0, 1, 2, 5]);
        const d = path.join(dir, "grids", `${f.key}_${pol}`, "training");
        fs.mkdirSync(d, { recursive: true });
        for (let i = 0; i < n; i++) {
          colour++;
          await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: colour % 256, g: (colour >> 8) % 256, b: 7 } } }).png().toFile(path.join(d, `img_${String(i).padStart(2, "0")}.png`));
        }
      }
    }
    const outputsByB64 = new Map();
    const genai = {
      generateContent: async (req) => {
        const b64 = req.contents[0].parts[0].inlineData.data;
        if (!outputsByB64.has(b64)) {
          const k = r.int(0, 6);
          let text;
          if (k === 0) text = "not json at all";
          else if (k === 1) text = JSON.stringify({ b: [] });
          else {
            const b = [];
            for (let i = 0; i < r.int(1, 4); i++) b.push(r.pick([r.int(0, fields.length + 1), String(r.int(0, 3))]));
            text = JSON.stringify(r.bool() ? { s: "x", b } : { b });
          }
          outputsByB64.set(b64, text);
        }
        return { text: outputsByB64.get(b64) };
      },
    };
    const hasSummary = r.bool();
    const { api } = loadLegacyEngine(legacyConfig(dir, fields, hasSummary ? "alerts" : "health"), { dir, noMain: true, genai });
    const list = api.buildImageList("training");
    const orig = toHost(await api.evaluatePrompt("SYSTEM PROMPT", list));
    datasets.push({
      hasSummary,
      fields: fields.map((f) => [f.key, f.bIdx]),
      items: list.map((item) => [item.fieldKey, item.polarity === "pos", outputsByB64.get(api.imageB64Cache.get(item.imageItem.id))]),
      expected: {
        overallAccuracy: orig.overallAccuracy,
        perField: Object.fromEntries(Object.entries(orig.perField).map(([k, m]) => [k, Object.fromEntries(SCORE_KEYS.map((s) => [s, m[s]]))])),
        wrongFields: orig.imageResults.map((x) => x.wrongFields),
      },
    });
  }
  return datasets;
}

test("scoring reproduces the original evaluatePrompt exactly (fuzz, real original pipeline)", async () => {
  let datasets;
  if (ORIGINAL_AVAILABLE) datasets = await originalScoringDatasets();
  else {
    assert.ok(golden && Array.isArray(golden.scoring), "neither the original engine source nor recorded scoring datasets are available");
    datasets = golden.scoring;
  }
  if (RECORD) recorded.scoring = datasets;
  assert.strictEqual(datasets.length, 25);
  datasets.forEach((d, n) => {
    const newFields = d.fields.map(([key, index]) => ({ key, index, type: "binary" }));
    const out = indexArrayOutput(newFields, d.hasSummary);
    const counters = scoring.newCounters(newFields);
    const results = d.items.map(([fieldKey, positive, text]) =>
      scoring.scoreItem(newFields, out.mapping, { labels: { [fieldKey]: positive } }, extractJSON(text).value, counters));
    const fin = scoring.finalizeMetrics(newFields, counters);
    assert.ok(Object.is(fin.overallAccuracy, d.expected.overallAccuracy), `dataset ${n}: overall ${fin.overallAccuracy} vs ${d.expected.overallAccuracy}`);
    for (const f of newFields) {
      for (const k of SCORE_KEYS) {
        assert.ok(Object.is(fin.perField[f.key][k], d.expected.perField[f.key][k]), `dataset ${n}: ${f.key}.${k}`);
      }
    }
    results.forEach((res, i) => assert.deepStrictEqual(res.wrongFields, d.expected.wrongFields[i], `dataset ${n} item ${i}`));
  });
});
