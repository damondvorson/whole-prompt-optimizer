// parse.js — turn a model's text into JSON the same way the original engine did.
"use strict";

// The original extractJSON (wpo_video_engine.js 209–216), with the fallback made explicit:
// unparseable text → the fallback value (original: {s:"", b:[]}, i.e. an empty prediction, not retried).
function extractJSON(text, fallback) {
  const fb = fallback === undefined ? { s: "", b: [] } : fallback;
  if (typeof text !== "string") return { value: fb, parsed: false };
  try { return { value: JSON.parse(text), parsed: true }; } catch {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) try { return { value: JSON.parse(m[1]), parsed: true }; } catch {}
  const m2 = text.match(/\{[\s\S]*\}/);
  if (m2) try { return { value: JSON.parse(m2[0]), parsed: true }; } catch {}
  return { value: fb, parsed: false };
}

let _ajv = null;
const _validators = new WeakMap();
function validateAgainstSchema(schema, value) {
  if (!schema || typeof schema !== "object") return { valid: true, errors: [] };
  try {
    if (!_ajv) {
      const Ajv = require("ajv");
      _ajv = new Ajv({ allErrors: false, strict: false, validateFormats: false });
    }
    let v = _validators.get(schema);
    if (!v) { v = _ajv.compile(schema); _validators.set(schema, v); }
    const valid = v(value);
    return { valid: !!valid, errors: valid ? [] : (v.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`) };
  } catch (err) {
    return { valid: true, errors: [], skipped: err.message };
  }
}

module.exports = { extractJSON, validateAgainstSchema };
