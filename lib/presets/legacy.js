// presets/legacy.js — everything needed to reproduce a wpo_video_engine.js run exactly:
// the original base prompt builder (448–486, loaded from a local-only module), the TIMING line (489–500),
// the runner-config import and the harness/method settings the original hardcoded.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { indexArrayOutput } = require("../schema");

const LEGACY_TIMING_SENTENCE =
  "The exact time interval between frames varies per video and is specified in the TIMING section below.";

const FLEX_HEADERS = {
  "X-Vertex-AI-LLM-Request-Type": "shared",
  "X-Vertex-AI-LLM-Shared-Request-Type": "flex",
  "X-Server-Timeout": "600",
};

// Original injectTiming text. meta = {duration, interval} from the grid's .meta.json (default 8 / 1.6).
function legacyTimingLine(meta) {
  const interval = meta.interval;
  const duration = meta.duration;
  return `TIMING: This grid shows 4 frames from a ${duration.toFixed(1)}s video clip, spaced ${interval.toFixed(1)}s apart. Grid layout: top-left = t=0s, top-right = t=${interval.toFixed(1)}s, bottom-left = t=${(interval*2).toFixed(1)}s, bottom-right = t=${(interval*3).toFixed(1)}s.`;
}

// Original buildBasePrompt (video grid). The senior-care base prompt text is product content and is not part
// of the public repository: it lives in the local-only module private/senior_care_base_prompt.js.
const PRIVATE_BASE_PROMPT = path.join(__dirname, "private", "senior_care_base_prompt.js");
const HAS_LEGACY_BASE_PROMPT = fs.existsSync(PRIVATE_BASE_PROMPT);

// fields: [{bIdx|index, desc|description}] in runner order.
function legacyBuildBasePrompt(categoryName, fields) {
  if (!HAS_LEGACY_BASE_PROMPT) {
    throw Object.assign(new Error("The legacy preset rebuilds the original senior-care base prompt, which is not part of the public " +
      "repository (lib/presets/private/senior_care_base_prompt.js). Create a normal project and add your own base prompt instead."), { status: 400 });
  }
  return require(PRIVATE_BASE_PROMPT).legacyBuildBasePrompt(categoryName, fields);
}

// Load a legacy runner (e.g. wpo_video_alerts.js) without running the engine: the file is evaluated in a
// sandbox whose require() captures the CONFIG passed to the engine.
function importLegacyRunner(runnerPath) {
  const src = fs.readFileSync(runnerPath, "utf8");
  let captured = null;
  let engineName = null;
  const fakeRequire = (name) => {
    if (/wpo_(video_)?engine/.test(name)) {
      engineName = path.basename(name);
      return (cfg) => { captured = cfg; };
    }
    throw new Error(`unexpected require("${name}") in legacy runner`);
  };
  const sandbox = {
    require: fakeRequire, module: { exports: {} }, exports: {},
    __dirname: path.dirname(runnerPath), __filename: runnerPath,
    console: { log() {}, error() {}, warn() {} },
  };
  vm.runInNewContext(src, sandbox, { filename: runnerPath, timeout: 2000 });
  if (!captured || !Array.isArray(captured.fields)) throw new Error("No engine CONFIG found in runner file");
  if (engineName && !/video/.test(engineName)) {
    throw new Error("This runner uses the single-image engine (wpo_engine.js); only video-grid runners can be imported");
  }
  return JSON.parse(JSON.stringify(captured));
}

// Project settings that reproduce the original engine for a runner config. The original ran on Vertex AI
// (Gemini models); pick a Vertex or Gemini API connection on the harness cards.
function legacyProjectSettings(runnerCfg) {
  const fields = runnerCfg.fields.map((f) => ({
    key: f.key, label: f.key, type: "binary", index: f.bIdx, description: f.desc || "",
  }));
  const hasSummary = runnerCfg.categoryName === "alerts";
  return {
    preset: "legacy-wpo-video",
    categoryName: runnerCfg.categoryName,
    fields,
    prompt: {
      base: legacyBuildBasePrompt(runnerCfg.categoryName, runnerCfg.fields),
      placeholders: false,
      rules: [{ find: LEGACY_TIMING_SENTENCE, replace: "{{timing_line}}" }],
    },
    output: indexArrayOutput(fields, hasSummary),
    target: {
      model: "gemini-2.5-flash-lite", temperature: 0, maxOutputTokens: null,
      placement: "system", concurrency: 300, timeoutMs: 0, schemaMode: "native", headers: {},
      media: {
        image: { mode: "resize", width: 840, height: 480, fit: "fill", format: "png" },
        video: { mode: "grid", frames: 4, rows: 2, cols: 2, cellWidth: 840, cellHeight: 480 },
      },
    },
    generator: {
      model: runnerCfg.proModel || "gemini-2.5-pro", temperature: 1.0, maxOutputTokens: 65536,
      concurrency: 100, timeoutMs: 0, stream: false, headers: runnerCfg.useFlex ? Object.assign({}, FLEX_HEADERS) : {},
    },
    toggles: { parseRetryLimit: 0, persistentErrorPolicy: "retry" },
  };
}

module.exports = {
  LEGACY_TIMING_SENTENCE, FLEX_HEADERS, HAS_LEGACY_BASE_PROMPT, legacyTimingLine, legacyBuildBasePrompt,
  importLegacyRunner, legacyProjectSettings,
};
