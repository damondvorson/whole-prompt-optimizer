// mock.js — deterministic fake models for trying the app and for end-to-end tests (no API spend).
// Candidate mock: knows the true labels (via cfg.__mock.truth) and answers each labelled field
// correctly with probability 0.55 + 0.07·min(6, occurrences of "careful" in the system prompt), so
// prompts the generator mock improves really do score better. Generator mock: returns 3 rewrites of
// the BEST PERFORMING PROMPT with an extra "Be careful" sentence each.
"use strict";

const crypto = require("crypto");
const { ProviderError } = require("./errors");

function h01(s) { return parseInt(crypto.createHash("sha1").update(s).digest("hex").slice(0, 8), 16) / 0x100000000; }

function create(conn, cfg) {
  const behavior = (conn.fields && conn.fields.behavior) || "keyword";
  let calls = 0;
  return {
    name: "mock",
    async generate(req) {
      calls++;
      if (behavior === "auth-fail") throw new ProviderError("HTTP 401: invalid API key (mock)", { status: 401, kind: "auth" });
      if (behavior === "flaky" && h01(`flaky:${calls}`) < 0.15) throw new ProviderError("HTTP 503: overloaded (mock)", { status: 503, kind: "overloaded" });
      await new Promise((r) => setTimeout(r, Number((conn.fields && conn.fields.latencyMs) || 2)));
      const system = req.system || "";
      // generator role: no schema, meta-prompt in the user text
      if (!req.schema && !req.nativeSchema) {
        const text = (req.parts || []).map((p) => p.text || "").join("\n");
        const m = text.match(/=== BEST PERFORMING PROMPT[^\n]*\n[\s\S]*?<PROMPT>\n([\s\S]*?)\n<\/PROMPT>/);
        const best = m ? m[1] : "You are a careful classifier.";
        const step = (text.match(/Step (\d+):/g) || []).length;
        const cands = [1, 2, 3].map((k) => {
          let p = `${best}\n\nRevision ${step}.${k}: Be careful${k === 2 ? " and careful" : ""}.`;
          if (k === 3 && step % 3 === 0) p = best.replace(/careful/gi, "quick"); // occasional regression
          while (p.length < 220) p += " Look at every detail before answering.";
          return `<PROMPT>\n${p}\n</PROMPT>`;
        });
        return { text: `Here are three candidates.\n${cands.join("\n\n")}`, finish: "stop", usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 300 }, structured: "prompt", model: req.model || "mock-generator" };
      }
      const mock = cfg.__mock || {};
      const itemId = req.trace && req.trace.itemId;
      const truth = (mock.truth && itemId && mock.truth[itemId]) || {};
      const quality = Math.min(6, (system.match(/careful/gi) || []).length);
      const q = 0.55 + 0.07 * quality;
      const fields = mock.fields || [];
      const output = mock.output || { style: "index_array", mapping: {} };
      const predicted = {};
      for (const f of fields) {
        const correct = h01(`${system.length}:${quality}:${itemId}:${f.key}`) < q;
        const t = truth[f.key];
        if (t === undefined) { predicted[f.key] = f.type === "binary" ? false : null; continue; }
        if (correct) predicted[f.key] = t;
        else if (f.type === "binary") predicted[f.key] = !t;
        else if (f.type === "number") predicted[f.key] = Number(t) + 1;
        else if (f.type === "categorical") { const other = (f.classes || []).find((c) => String(c) !== String(t)); predicted[f.key] = other !== undefined ? other : `${t}?`; }
        else predicted[f.key] = `${t} (wrong)`;
      }
      let json;
      if (output.style === "index_array") {
        json = { b: fields.filter((f) => predicted[f.key] === true).map((f) => f.index) };
        if (req.schema && req.schema.properties && req.schema.properties.s) json = { s: `mock summary q=${q.toFixed(2)}`, ...json };
      } else {
        json = {};
        const jp = output.justification && output.justification.property;
        if (jp && req.schema && req.schema.properties && req.schema.properties[jp]) json[jp] = `mock reasoning q=${q.toFixed(2)}`;
        for (const f of fields) {
          const map = output.mapping && output.mapping[f.key];
          json[(map && map.path) || f.key] = predicted[f.key];
        }
      }
      return { text: JSON.stringify(json), finish: "stop", usage: { inputTokens: Math.ceil(system.length / 4) + 258, outputTokens: 20 }, structured: "native", model: req.model || "mock-target" };
    },
    async listModels() { return [{ id: "mock-target", displayName: "Mock candidate model", source: "static" }, { id: "mock-generator", displayName: "Mock generator", source: "static" }]; },
    capabilities() { return { images: true, video: true, audio: true, pdf: true, text: true, jsonSchema: "native", schemaDialect: "loose", system: true, temperature: "any" }; },
  };
}

module.exports = { create };
