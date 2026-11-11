// apilog.js — JSONL log of every model call (the original wrote one file per run; here files rotate at
// 256 MB and system prompts are stored once by hash in "compact" mode so long runs don't fill the disk).
// Readers page with a {file, offset} cursor instead of re-reading the whole log.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROTATE_BYTES = 256 * 1024 * 1024;

class ApiLog {
  // level: "full" (system prompt inline, like the original) | "compact" (prompt by hash) | "errors" | "off"
  constructor(dir, level = "compact", redactor = (s) => s) {
    this.dir = dir;
    this.level = level;
    this.redact = redactor;
    this.chain = Promise.resolve();
    this.seenPrompts = new Set();
    fs.mkdirSync(dir, { recursive: true });
    const files = ApiLog.files(dir);
    this.index = files.length ? Number(files[files.length - 1].match(/(\d+)/)[1]) : 1;
    this.size = files.length ? fs.statSync(path.join(dir, files[files.length - 1])).size : 0;
  }

  static files(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => /^calls-\d+\.jsonl$/.test(f)).sort();
  }

  file() { return path.join(this.dir, `calls-${String(this.index).padStart(4, "0")}.jsonl`); }

  promptRef(text) {
    if (typeof text !== "string") return null;
    const h = crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
    if (!this.seenPrompts.has(h)) {
      this.seenPrompts.add(h);
      const line = JSON.stringify({ hash: h, text: this.redact(text) }) + "\n";
      this.chain = this.chain.then(() => fs.promises.appendFile(path.join(this.dir, "prompts.jsonl"), line)).catch(() => {});
    }
    return h;
  }

  write(record) {
    if (this.level === "off") return;
    if (this.level === "errors" && !record.error) return;
    if (this.level !== "full" && record.request && typeof record.request.system === "string") {
      record.request.systemHash = this.promptRef(record.request.system);
      record.request.systemLen = record.request.system.length;
      delete record.request.system;
    }
    const line = this.redact(JSON.stringify(record)) + "\n";
    this.chain = this.chain.then(async () => {
      if (this.size + line.length > ROTATE_BYTES) { this.index++; this.size = 0; }
      await fs.promises.appendFile(this.file(), line);
      this.size += Buffer.byteLength(line);
    }).catch(() => {});
  }

  flush() { return this.chain; }

  // Records after a cursor ("<fileIndex>:<offset>"), or the last `limit` records when no cursor.
  static read(dir, { cursor, limit = 200, type } = {}) {
    const files = ApiLog.files(dir);
    if (!files.length) return { records: [], cursor: cursor || null };
    const out = [];
    const want = (r) => !type || r.type === type;
    if (!cursor) {
      // tail: read backwards from the last file until enough records
      for (let fi = files.length - 1; fi >= 0 && out.length < limit; fi--) {
        const p = path.join(dir, files[fi]);
        const size = fs.statSync(p).size;
        const chunk = Math.min(size, 8 * 1024 * 1024);
        const fd = fs.openSync(p, "r");
        const buf = Buffer.alloc(chunk);
        fs.readSync(fd, buf, 0, chunk, size - chunk);
        fs.closeSync(fd);
        const lines = buf.toString("utf8").split("\n").filter(Boolean);
        if (chunk < size) lines.shift(); // partial first line
        const recs = [];
        for (const l of lines) { try { const r = JSON.parse(l); if (want(r)) recs.push(r); } catch {} }
        out.unshift(...recs.slice(-Math.max(0, limit - out.length)));
      }
      const last = files[files.length - 1];
      return { records: out, cursor: `${Number(last.match(/(\d+)/)[1])}:${fs.statSync(path.join(dir, last)).size}` };
    }
    let [fIdx, offset] = String(cursor).split(":").map(Number);
    for (const f of files) {
      const idx = Number(f.match(/(\d+)/)[1]);
      if (idx < fIdx) continue;
      const p = path.join(dir, f);
      const size = fs.statSync(p).size;
      const start = idx === fIdx ? offset : 0;
      if (start >= size) { fIdx = idx; offset = size; continue; }
      const len = Math.min(size - start, 16 * 1024 * 1024);
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.closeSync(fd);
      const text = buf.toString("utf8");
      const end = text.lastIndexOf("\n") + 1;
      for (const l of text.slice(0, end).split("\n").filter(Boolean)) { try { const r = JSON.parse(l); if (want(r)) out.push(r); } catch {} }
      fIdx = idx; offset = start + Buffer.byteLength(text.slice(0, end));
      if (out.length >= limit) break;
    }
    return { records: out.slice(-limit), cursor: `${fIdx}:${offset}` };
  }

  static prompt(dir, hash) {
    const p = path.join(dir, "prompts.jsonl");
    if (!fs.existsSync(p)) return null;
    for (const l of fs.readFileSync(p, "utf8").split("\n")) {
      if (l.includes(`"hash":"${hash}"`)) { try { return JSON.parse(l).text; } catch {} }
    }
    return null;
  }
}

// Build a redactor that replaces every secret value with [REDACTED].
function makeRedactor(secrets) {
  const list = (secrets || []).filter((s) => typeof s === "string" && s.length >= 6).sort((a, b) => b.length - a.length);
  if (!list.length) return (s) => s;
  return (s) => {
    let out = s;
    for (const sec of list) {
      if (out.includes(sec)) out = out.split(sec).join("[REDACTED]");
      const j = JSON.stringify(sec).slice(1, -1);
      if (j !== sec && out.includes(j)) out = out.split(j).join("[REDACTED]");
    }
    return out;
  };
}

module.exports = { ApiLog, makeRedactor };
