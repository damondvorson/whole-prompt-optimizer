// schema.js — output schemas for the candidate harness.
// Schemas are authored as standard JSON Schema (lowercase types). Two generators cover the common
// cases; "custom" lets the user paste any schema plus a per-field mapping. The legacy index-array style
// also carries the original Gemini-native (uppercase) schema so the legacy request is sent verbatim.
"use strict";

const SUMMARY_DESCRIPTION = "Natural language summary of the scene and detected conditions";
const B_DESCRIPTION = "Array of integer indices whose value is equal to 1";

// ─── Original schemas (wpo_video_engine.js 149–177), Gemini-native form ───
function legacyNative(fieldCount, withSummary) {
  const B_SCHEMA = {
    type: "ARRAY",
    description: B_DESCRIPTION,
    items: { type: "INTEGER" },
    minItems: 0,
    maxItems: fieldCount,
  };
  return withSummary
    ? { type: "OBJECT", properties: { s: { type: "STRING", description: SUMMARY_DESCRIPTION }, b: B_SCHEMA }, required: ["s", "b"] }
    : { type: "OBJECT", properties: { b: B_SCHEMA }, required: ["b"] };
}

function indexArrayJsonSchema(fieldCount, withSummary) {
  const b = { type: "array", description: B_DESCRIPTION, items: { type: "integer" }, minItems: 0, maxItems: fieldCount };
  return withSummary
    ? { type: "object", properties: { s: { type: "string", description: SUMMARY_DESCRIPTION }, b }, required: ["s", "b"] }
    : { type: "object", properties: { b }, required: ["b"] };
}

// Index-array output {"b": [indices of fields that are 1]} (+ "s" summary when withSummary).
// Only binary fields can be expressed this way.
function indexArrayOutput(fields, withSummary) {
  const mapping = {};
  for (const f of fields) mapping[f.key] = { path: "b", op: "contains", value: f.index };
  return {
    style: "index_array",
    jsonSchema: indexArrayJsonSchema(fields.length, withSummary),
    nativeSchema: legacyNative(fields.length, withSummary),
    mapping,
    justification: { mode: withSummary ? "main_response" : "second_call", property: "s" },
  };
}

function fieldPropertySchema(f) {
  const description = f.description || undefined;
  switch (f.type) {
    case "binary": return { type: "boolean", ...(description ? { description } : {}) };
    case "categorical":
      return { type: "string", ...(f.classes && f.classes.length ? { enum: f.classes.map(String) } : {}), ...(description ? { description } : {}) };
    case "number": return { type: "number", ...(description ? { description } : {}) };
    default: return { type: "string", ...(description ? { description } : {}) };
  }
}

// Named-fields output {"<field>": value, ...} (+ optional justification property first).
function namedFieldsOutput(fields, opts = {}) {
  const prop = opts.justificationProperty || "reasoning";
  const properties = {};
  const required = [];
  if (opts.justificationInMain) {
    properties[prop] = { type: "string", description: "Brief justification for the values below" };
    required.push(prop);
  }
  const mapping = {};
  for (const f of fields) {
    properties[f.key] = fieldPropertySchema(f);
    required.push(f.key);
    mapping[f.key] = { path: f.key, op: "value" };
  }
  return {
    style: "named",
    jsonSchema: { type: "object", properties, required, additionalProperties: false },
    nativeSchema: null,
    mapping,
    justification: { mode: opts.justificationInMain ? "main_response" : "second_call", property: prop },
  };
}

// Schema for the justification pass (original JUSTIFICATION_SCHEMA = {s, b}: the main schema with the
// summary property added first). Returns {jsonSchema, nativeSchema}.
function justificationSchemas(output) {
  const prop = (output.justification && output.justification.property) || "s";
  let nativeSchema = null;
  if (output.nativeSchema) {
    const ns = output.nativeSchema;
    const props = Object.assign({}, ns.properties || {});
    const sDef = props[prop] || { type: "STRING", description: SUMMARY_DESCRIPTION };
    delete props[prop];
    nativeSchema = {
      type: "OBJECT",
      properties: Object.assign({ [prop]: sDef }, props),
      required: [prop, ...(ns.required || []).filter((r) => r !== prop)],
    };
  }
  const js = output.jsonSchema || { type: "object", properties: {} };
  const props = Object.assign({}, js.properties || {});
  const sDef = props[prop] || { type: "string", description: SUMMARY_DESCRIPTION };
  delete props[prop];
  const jsonSchema = Object.assign({}, js, {
    properties: Object.assign({ [prop]: sDef }, props),
    required: [prop, ...((js.required || []).filter((r) => r !== prop))],
  });
  return { jsonSchema, nativeSchema };
}

function schemaHasProperty(schema, prop) {
  return !!(schema && schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, prop));
}

// ─── Provider dialects ────────────────────────────────────────────────────
// Strip what a provider rejects; move stripped constraints into the description so the model still
// sees them. Local Ajv validation always runs against the ORIGINAL schema.
const STRIP_SETS = {
  "openai-strict": [],
  "azure-strict": ["minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems"],
  anthropic: ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems"],
  bedrock: ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "pattern", "format"],
};

function cloneJSON(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

function normalizeSchema(schema, dialect) {
  if (!schema || dialect === "gemini" || dialect === "loose" || !dialect) return cloneJSON(schema);
  const strict = dialect === "openai-strict" || dialect === "azure-strict";
  const strip = STRIP_SETS[dialect] || [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    const notes = [];
    for (const [k, v] of Object.entries(node)) {
      if (strip.includes(k)) { notes.push(`${k}: ${JSON.stringify(v)}`); continue; }
      if (k === "minItems" && (dialect === "anthropic" || dialect === "bedrock") && v > 1) { notes.push(`minItems: ${v}`); out.minItems = 1; continue; }
      if (k === "properties") {
        out.properties = {};
        for (const [pk, pv] of Object.entries(v)) out.properties[pk] = walk(pv);
      } else if (k === "items" || k === "additionalProperties" && typeof v === "object") {
        out[k] = walk(v);
      } else if (k === "anyOf" || k === "oneOf" || k === "allOf") {
        out[k] = v.map(walk);
      } else out[k] = v;
    }
    if (notes.length) out.description = [out.description, `(constraints: ${notes.join(", ")})`].filter(Boolean).join(" ");
    const isObject = out.type === "object" || (Array.isArray(out.type) && out.type.includes("object")) || out.properties;
    if (isObject && out.properties) {
      out.additionalProperties = false;
      if (strict) {
        const req = new Set(out.required || []);
        for (const pk of Object.keys(out.properties)) {
          if (!req.has(pk)) {
            const p = out.properties[pk];
            if (typeof p.type === "string") p.type = [p.type, "null"];
            req.add(pk);
          }
        }
        out.required = [...req];
      }
    }
    return out;
  };
  return walk(cloneJSON(schema));
}

// Render the schema as text for providers without native structured output (prompt-only rung).
function schemaInstruction(schema) {
  return `Respond with a single JSON object (no prose, no code fences) that conforms to this JSON Schema:\n${JSON.stringify(schema, null, 2)}`;
}

module.exports = {
  SUMMARY_DESCRIPTION, legacyNative, indexArrayJsonSchema,
  indexArrayOutput, namedFieldsOutput, justificationSchemas, schemaHasProperty,
  normalizeSchema, schemaInstruction, fieldPropertySchema,
};
