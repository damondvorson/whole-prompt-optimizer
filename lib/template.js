// template.js — small, dependency-free templating used in three places:
//   1. the meta-prompt template (mustache-like sections, rendered exactly — no whitespace trimming)
//   2. per-item prompt variables ({{var}}) and literal find/replace rules (legacy injectTiming)
//   3. custom HTTP request templates (JSON with {{token}} values)
"use strict";

// ─── Mustache-like renderer ─────────────────────────────────────────────────
// Supports {{name}}, {{#name}}…{{/name}} (truthy / iterate arrays), {{^name}}…{{/name}} (falsy / empty).
// Inserted values are never re-parsed, and no standalone-line whitespace stripping happens, so the
// output is byte-for-byte predictable from the template text.
const TAG_RE = /\{\{\s*([#^/]?)\s*([A-Za-z_][\w.]*)\s*\}\}/g;

function parseTemplate(src) {
  const root = { type: "root", children: [] };
  const stack = [root];
  let last = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ type: "text", value: src.slice(last, m.index) });
    const [, sigil, name] = m;
    if (sigil === "#" || sigil === "^") {
      const node = { type: sigil === "#" ? "section" : "inverted", name, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (sigil === "/") {
      if (stack.length === 1 || top.name !== name) {
        throw new Error(`Template error: unexpected {{/${name}}} at offset ${m.index}`);
      }
      stack.pop();
    } else {
      top.children.push({ type: "var", name });
    }
    last = TAG_RE.lastIndex;
  }
  if (last < src.length) stack[stack.length - 1].children.push({ type: "text", value: src.slice(last) });
  if (stack.length !== 1) throw new Error(`Template error: unclosed {{#${stack[stack.length - 1].name}}}`);
  return root;
}

function lookup(stack, name) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx !== null && typeof ctx === "object" && Object.prototype.hasOwnProperty.call(ctx, name)) return ctx[name];
  }
  return undefined;
}

function renderNodes(nodes, stack, out) {
  for (const n of nodes) {
    if (n.type === "text") out.push(n.value);
    else if (n.type === "var") {
      const v = lookup(stack, n.name);
      if (v !== undefined && v !== null) out.push(String(v));
    } else if (n.type === "section") {
      const v = lookup(stack, n.name);
      if (Array.isArray(v)) {
        for (const item of v) {
          stack.push(item);
          renderNodes(n.children, stack, out);
          stack.pop();
        }
      } else if (v) {
        const pushes = v !== null && typeof v === "object";
        if (pushes) stack.push(v);
        renderNodes(n.children, stack, out);
        if (pushes) stack.pop();
      }
    } else if (n.type === "inverted") {
      const v = lookup(stack, n.name);
      if (!v || (Array.isArray(v) && v.length === 0)) renderNodes(n.children, stack, out);
    }
  }
}

function renderTemplate(src, context) {
  const ast = typeof src === "string" ? parseTemplate(src) : src;
  const out = [];
  renderNodes(ast.children, [context], out);
  return out.join("");
}

// Names used by a template (for the config screen's slot list / validation).
function templateNames(src) {
  const names = new Set();
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src)) !== null) names.add(m[2]);
  return [...names];
}

// ─── Per-item prompt variables and rules ───────────────────────────────────
const VAR_RE = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;

// Replace {{name}} with vars[name]; unknown placeholders are left untouched.
function substituteVars(text, vars) {
  if (!vars || typeof text !== "string" || text.indexOf("{{") === -1) return text;
  return text.replace(VAR_RE, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : whole);
}

function placeholdersIn(text) {
  const names = new Set();
  if (typeof text !== "string") return [];
  VAR_RE.lastIndex = 0;
  let m;
  while ((m = VAR_RE.exec(text)) !== null) names.add(m[1]);
  return [...names];
}

// Literal find/replace rules, first occurrence only (same as String.replace with a non-global regex,
// which is what the legacy injectTiming did). The replacement may contain {{vars}}. A function
// replacer is used so "$&"-style patterns in the replacement are never interpreted.
function applyRules(text, rules, vars) {
  if (!rules || rules.length === 0) return text;
  let out = text;
  for (const rule of rules) {
    if (!rule || !rule.find) continue;
    const idx = out.indexOf(rule.find);
    if (idx === -1) continue;
    const replacement = substituteVars(rule.replace || "", vars);
    out = out.slice(0, idx) + replacement + out.slice(idx + rule.find.length);
  }
  return out;
}

// Build the exact system prompt sent for one item.
function renderItemPrompt(prompt, promptCfg, vars) {
  let p = applyRules(prompt, promptCfg && promptCfg.rules, vars);
  if (promptCfg && promptCfg.placeholders) p = substituteVars(p, vars);
  return p;
}

// ─── JSON request templates (custom HTTP harness) ──────────────────────────
// A string value that is exactly "{{token}}" is replaced by the token's structured value (object,
// array, number…); tokens inside longer strings are substituted as text.
function renderJsonTemplate(tpl, tokens) {
  if (Array.isArray(tpl)) return tpl.map((v) => renderJsonTemplate(v, tokens));
  if (tpl !== null && typeof tpl === "object") {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) {
      const rendered = renderJsonTemplate(v, tokens);
      if (rendered !== undefined) out[k] = rendered;
    }
    return out;
  }
  if (typeof tpl === "string") {
    const exact = tpl.match(/^\{\{\s*([A-Za-z_][\w.]*)\s*\}\}$/);
    if (exact) return Object.prototype.hasOwnProperty.call(tokens, exact[1]) ? tokens[exact[1]] : undefined;
    return tpl.replace(VAR_RE, (whole, name) => {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) return whole;
      const v = tokens[name];
      return v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  return tpl;
}

// Dot/bracket path lookup: "a.b[0].c", "$.b", "choices[0].message.content".
function getPath(obj, path) {
  if (path === undefined || path === null || path === "" || path === "$") return obj;
  const parts = String(path).replace(/^\$\.?/, "").match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[/^\d+$/.test(p) && Array.isArray(cur) ? Number(p) : p];
  }
  return cur;
}

function hasPath(obj, path) {
  if (path === undefined || path === null || path === "" || path === "$") return obj !== undefined;
  const parts = String(path).replace(/^\$\.?/, "").match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return false;
    const key = /^\d+$/.test(p) && Array.isArray(cur) ? Number(p) : p;
    if (!(key in cur)) return false;
    cur = cur[key];
  }
  return true;
}

module.exports = {
  parseTemplate, renderTemplate, templateNames,
  substituteVars, placeholdersIn, applyRules, renderItemPrompt,
  renderJsonTemplate, getPath, hasPath,
};
