// legacy_ref.js — loads the ORIGINAL engine (test/legacy/wpo_video_engine.original.js, a verbatim,
// read-only copy of the original wpo_video_optimizer/wpo_video_engine.js) inside a sandbox and
// exposes its internal functions, so tests compare the new code against the real original behaviour.
// The original source is local-only (gitignored): without it ORIGINAL_AVAILABLE is false and the tests
// fall back to fingerprints recorded from it (test/golden/legacy_golden.json) or skip.
// The only source change is one injected line before `main().catch(...)` that publishes the closure's
// functions (and lets tests skip main()).
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ORIGINAL = path.join(__dirname, "wpo_video_engine.original.js");
const ORIGINAL_SHA256 = "02167f7332991efe9ea42aaf8369f70ccab5949673ae544b1a1931fbcfb3e388";
const ORIGINAL_AVAILABLE = fs.existsSync(ORIGINAL);

const EXPORT_LINE =
  "globalThis.__wpoLegacy = { extractJSON, isRateLimitError, loadFieldImages, buildImageList, getImageB64, " +
  "extractPromptCandidates, formatPerFieldMetricsBlock, buildBasePrompt, injectTiming, evaluatePrompt, " +
  "collectWrongPredictions, collectWrongDetails, buildWPOMetaPrompt, imageB64Cache, RESPONSE_SCHEMA, " +
  "JUSTIFICATION_SCHEMA, B_SCHEMA, setLiveCp: (cp) => { liveCp = cp; } };\n" +
  "if (CONFIG.__noMain) return;\n";

function originalSource() {
  if (!ORIGINAL_AVAILABLE) throw new Error("The original engine source (test/legacy/wpo_video_engine.original.js) is local-only and not part of the public repository");
  const src = fs.readFileSync(ORIGINAL, "utf8");
  const sha = crypto.createHash("sha256").update(src).digest("hex");
  if (sha !== ORIGINAL_SHA256) throw new Error(`legacy reference changed (sha256 ${sha})`);
  const marker = "\nmain().catch(err => {";
  const at = src.lastIndexOf(marker);
  if (at === -1) throw new Error("main() call not found in original");
  return src.slice(0, at + 1) + EXPORT_LINE + src.slice(at + 1);
}

// Load the original engine with CONFIG. opts:
//   dir     — directory used as the module's __dirname (logs, api log, checkpoint, grids live here)
//   genai   — { generateContent(request) → Promise<{text}> } used by the stubbed GoogleGenAI client
//   noMain  — true: only expose functions; false: run main() (the full optimisation loop)
//   onExit  — called if the original calls process.exit
function loadLegacyEngine(config, opts = {}) {
  const dir = opts.dir;
  if (!dir) throw new Error("opts.dir required");
  const logs = [];
  const fakeConsole = {
    log: (...a) => logs.push(a.join(" ")),
    error: (...a) => logs.push("[ERROR] " + a.join(" ")),
    warn: (...a) => logs.push("[WARN] " + a.join(" ")),
  };
  const genaiStub = {
    GoogleGenAI: class {
      constructor(o) { this.options = o; this.models = { generateContent: (req) => opts.genai.generateContent(req, o) }; }
    },
  };
  const httpStub = { createServer: () => ({ listen: () => {}, on: () => {} }) };
  const fakeRequire = (name) => {
    if (name === "@google/genai") return genaiStub;
    if (name === "http") return httpStub;
    if (name === "sharp") return require("sharp");
    if (name === "fs" || name === "path") return require(name);
    throw new Error(`legacy sandbox: unexpected require(${name})`);
  };
  const fakeProcess = {
    on: () => {},
    exit: (code) => { if (opts.onExit) opts.onExit(code); throw new Error(`legacy process.exit(${code})`); },
    env: {},
  };
  // Only host objects the original needs; built-ins (JSON, Promise, …) come from the context's own realm,
  // so tests compare results after a JSON round trip (see toHost()).
  const sandbox = {
    console: fakeConsole, process: fakeProcess, setTimeout, clearTimeout, setInterval, clearInterval, Buffer, URL,
  };
  const context = vm.createContext(sandbox);
  const wrapper = `(function (exports, require, module, __filename, __dirname) {\n${originalSource()}\n})`;
  const fn = vm.runInContext(wrapper, context, { filename: ORIGINAL });
  const mod = { exports: {} };
  fn(mod.exports, fakeRequire, mod, path.join(dir, "wpo_video_engine.js"), dir);
  mod.exports(Object.assign({ __noMain: opts.noMain !== false }, config));
  return { api: sandbox.__wpoLegacy, logs };
}

// Cross-realm values → plain host values (for deepStrictEqual).
function toHost(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

module.exports = { loadLegacyEngine, toHost, ORIGINAL, ORIGINAL_SHA256, ORIGINAL_AVAILABLE };
