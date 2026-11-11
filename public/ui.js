// ui.js — tiny DOM + API helpers shared by app.js and dashboard.js. All text goes through textContent.
"use strict";

const TOKEN = document.querySelector('meta[name="wpo-token"]').content;

async function api(method, path, body, opts = {}) {
  const init = { method, headers: { "X-WPO-Token": TOKEN } };
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (body !== undefined) init.body = body;
  const res = await fetch(path, init);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    if (!opts.quiet) toast(err.message, true);
    throw err;
  }
  return data;
}
const GET = (p, o) => api("GET", p, undefined, o);
const POST = (p, b, o) => api("POST", p, b === undefined ? {} : b, o);
const PATCH = (p, b, o) => api("PATCH", p, b, o);
const DEL = (p, o) => api("DELETE", p, undefined, o);
function withToken(url) { return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}`; }

// h("div.class#id", {attrs, on:{click}}, ...children)
function h(sel, attrs, ...children) {
  const m = String(sel).match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || "div");
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) { if (part[0] === ".") el.classList.add(part.slice(1)); else el.id = part.slice(1); }
  if (attrs !== undefined && attrs !== null && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  const add = (c) => {
    if (c === undefined || c === null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function appendChildren(el, children) {
  const add = (c) => {
    if (c === undefined || c === null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}
function mount(el, ...children) { clear(el); return appendChildren(el, children); }

function toast(msg, bad) {
  const root = document.getElementById("toast-root");
  const t = h("div.toast", { class: bad ? "bad" : "" }, msg);
  root.appendChild(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

function modal(title, body, actions) {
  const root = document.getElementById("modal-root");
  const close = () => { back.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const back = h("div.modal-back", { on: { click: (e) => { if (e.target === back) close(); } } },
    h("div.modal", { role: "dialog", "aria-modal": "true" },
      h("div.panel-head", h("h2", title), h("button.small", { on: { click: close }, "aria-label": "Close" }, "✕")),
      body,
      actions ? h("div.row", { style: { marginTop: "14px", justifyContent: "flex-end" } }, actions) : null));
  document.addEventListener("keydown", onKey);
  root.appendChild(back);
  return { close, el: back };
}

function confirmModal(title, text, okLabel = "Confirm", danger = false) {
  return new Promise((resolve) => {
    let m;
    const ok = h("button", { class: danger ? "danger" : "primary", on: { click: () => { m.close(); resolve(true); } } }, okLabel);
    const cancel = h("button", { on: { click: () => { m.close(); resolve(false); } } }, "Cancel");
    m = modal(title, h("p", text), [cancel, ok]);
  });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function waitJob(job, onProgress) {
  for (;;) {
    const j = await GET(`/api/jobs/${job.id}`, { quiet: true });
    if (onProgress) onProgress(j.progress);
    if (j.status === "done") return j.result;
    if (j.status === "error") throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 700));
  }
}

const fmt = {
  pct: (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${Number(x).toFixed(d)}%`),
  int: (x) => (x === null || x === undefined ? "—" : Number(x).toLocaleString()),
  bytes: (n) => { if (!n) return "0 B"; const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; },
  tokens: (n) => (n === null || n === undefined ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))),
  usd: (x) => (x === null || x === undefined ? "—" : `$${Number(x).toFixed(2)}`),
  time: (s) => (s ? new Date(s).toLocaleString() : "—"),
  val: (v) => (v === true ? "1" : v === false ? "0" : v === null || v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v)),
};

function progressBar(done, total) {
  const pct = total ? Math.min(100, (100 * done) / total) : 0;
  return h("div.progress", h("div", { style: { width: `${pct}%` } }));
}

function stateBadge(state) {
  const cls = { running: "ok", completed: "ok", validated: "accent", paused: "warn", initializing: "accent", needs_attention: "bad", crashed: "bad", stopped: "", draft: "", dataset_ready: "accent", configured: "accent" }[state] || "";
  return h("span.badge", { class: cls }, String(state || "draft").replace(/_/g, " "));
}

function field(label, input, hint) {
  return h("label.field", h("span.lab", label), input, hint ? h("span.hint", hint) : null);
}

function select(options, value, onChange, attrs = {}) {
  const s = h("select", Object.assign({ on: { change: (e) => onChange && onChange(e.target.value) } }, attrs),
    options.map((o) => (typeof o === "string" ? h("option", { value: o }, o) : h("option", { value: o.value, disabled: o.disabled }, o.label))));
  s.value = value === undefined || value === null ? "" : String(value);
  return s;
}

function numInput(value, onChange, attrs = {}) {
  return h("input", Object.assign({ type: "number", value: value === null || value === undefined ? "" : value, on: { change: (e) => onChange(e.target.value === "" ? null : Number(e.target.value)) } }, attrs));
}
function textInput(value, onChange, attrs = {}) {
  return h("input", Object.assign({ type: "text", value: value || "", on: { change: (e) => onChange(e.target.value) } }, attrs));
}

window.WPO = { api, GET, POST, PATCH, DEL, withToken, h, clear, mount, toast, modal, confirmModal, debounce, waitJob, fmt, progressBar, stateBadge, field, select, numInput, textInput };
