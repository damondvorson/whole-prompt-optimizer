// media.js — turn an item's input into request parts, with preprocessing and caching.
//   images: none | resize W×H (fit) → png/jpeg       (legacy: 840×480 fill → PNG, byte-identical)
//   video:  native | frame grid (port of generate_grids.js: ffmpeg + sharp)
//   audio/pdf: passed through; text files and item.input.text become text parts
// Frame grids are cached on disk (projects/<id>/cache/media/grids — expensive to rebuild); resized images
// live only in a byte-capped in-memory LRU, like the original engine (no extra disk per image).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { kindOf, mimeOf } = require("./dataset/files");
const { legacyTimingLine } = require("./presets/legacy");

let _sharp = null;
function sharp() { if (!_sharp) _sharp = require("sharp"); return _sharp; }

class ByteLRU {
  constructor(maxBytes) { this.max = maxBytes; this.bytes = 0; this.map = new Map(); }
  get(k) { const v = this.map.get(k); if (v) { this.map.delete(k); this.map.set(k, v); } return v; }
  set(k, buf) {
    if (this.map.has(k)) { this.bytes -= this.map.get(k).length; this.map.delete(k); }
    if (buf.length > this.max) return;
    this.map.set(k, buf); this.bytes += buf.length;
    while (this.bytes > this.max && this.map.size) { const [ok, ov] = this.map.entries().next().value; this.map.delete(ok); this.bytes -= ov.length; }
  }
}

function which(bin) {
  for (const d of (process.env.PATH || "").split(path.delimiter).concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"])) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

function run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function videoDuration(videoPath) {
  const ffprobe = which("ffprobe");
  if (!ffprobe) return 8;
  try {
    const out = await run(ffprobe, ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath], 15000);
    const dur = parseFloat(out.trim());
    return dur > 0 && isFinite(dur) ? dur : 8;
  } catch { return 8; }
}

// Port of generate_grids.js buildGrid: frames at k·duration/(N+1), each resized to the cell (fill),
// composited row-major (TL = earliest). Missing frames become black cells.
async function buildGrid(videoPath, outPng, cfg, tmpDir) {
  const frames = cfg.frames || 4, rows = cfg.rows || 2, cols = cfg.cols || 2;
  const W = cfg.cellWidth || 840, H = cfg.cellHeight || 480;
  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg not found (needed for video → frame grid). Install it, e.g. `brew install ffmpeg`.");
  const duration = await videoDuration(videoPath);
  const interval = duration / (frames + 1);
  const uid = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const buffers = await Promise.all(Array.from({ length: frames }, async (_, i) => {
    const ts = interval * (i + 1);
    const tmp = path.join(tmpDir, `grid_${uid}_f${i}.png`);
    try {
      await run(ffmpeg, ["-nostdin", "-y", "-ss", ts.toFixed(3), "-i", videoPath, "-frames:v", "1", "-q:v", "2", tmp], 30000);
      const buf = await sharp()(tmp).resize(W, H, { fit: "fill" }).png().toBuffer();
      try { fs.unlinkSync(tmp); } catch {}
      return buf;
    } catch {
      try { fs.unlinkSync(tmp); } catch {}
      return sharp()({ create: { width: W, height: H, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    }
  }));
  const composite = buffers.slice(0, rows * cols).map((input, i) => ({ input, top: Math.floor(i / cols) * H, left: (i % cols) * W }));
  const grid = await sharp()({ create: { width: W * cols, height: H * rows, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(composite).png().toBuffer();
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  fs.writeFileSync(outPng, grid);
  const meta = { duration, interval };
  fs.writeFileSync(outPng.replace(/\.png$/i, ".meta.json"), JSON.stringify(meta));
  return meta;
}

function cfgHash(obj) { return crypto.createHash("sha1").update(JSON.stringify(obj || {})).digest("hex").slice(0, 10); }

class MediaPipeline {
  // projectDir: for relative item paths and the cache; media: target.media config
  constructor(projectDir, media, opts = {}) {
    this.projectDir = projectDir;
    this.media = media || {};
    this.cacheDir = path.join(projectDir, "cache", "media");
    this.lru = new ByteLRU(opts.maxBytes || 1.5 * 1024 * 1024 * 1024);
    this.diskCacheImages = !!opts.diskCacheImages;
    this.imgHash = cfgHash(this.media.image);
    this.vidHash = cfgHash(this.media.video);
  }

  abs(p) { return path.isAbsolute(p) ? p : path.join(this.projectDir, p); }

  // Video → grid (cached). Returns {path, meta}.
  async gridFor(file) {
    const src = this.abs(file.path);
    const key = `${file.sha || crypto.createHash("sha1").update(src).digest("hex")}-${this.vidHash}`;
    const out = path.join(this.cacheDir, "grids", `${key}.png`);
    if (fs.existsSync(out)) {
      try { return { path: out, meta: JSON.parse(fs.readFileSync(out.replace(/\.png$/i, ".meta.json"), "utf8")) }; } catch {}
    }
    const meta = await buildGrid(src, out, this.media.video || {}, path.join(this.cacheDir, "tmp"));
    return { path: out, meta };
  }

  async imageBytes(srcPath, sha) {
    const im = this.media.image || { mode: "none" };
    if (!im.mode || im.mode === "none") return { buf: fs.readFileSync(srcPath), mime: mimeOf(srcPath) };
    const key = `${sha || srcPath}-${this.imgHash}`;
    const hit = this.lru.get(key);
    const mime = im.format === "jpeg" ? "image/jpeg" : "image/png";
    if (hit) return { buf: hit, mime };
    let pipe = sharp()(srcPath).resize(im.width || 840, im.height || 480, { fit: im.fit || "fill" });
    pipe = im.format === "jpeg" ? pipe.jpeg({ quality: im.quality || 90 }) : pipe.png();
    let buf;
    if (this.diskCacheImages) {
      const diskPath = path.join(this.cacheDir, "img", `${crypto.createHash("sha1").update(key).digest("hex")}.${im.format === "jpeg" ? "jpg" : "png"}`);
      if (fs.existsSync(diskPath)) buf = fs.readFileSync(diskPath);
      else { buf = await pipe.toBuffer(); fs.mkdirSync(path.dirname(diskPath), { recursive: true }); fs.writeFileSync(diskPath, buf); }
    } else buf = await pipe.toBuffer();
    this.lru.set(key, buf);
    return { buf, mime };
  }

  // → {parts:[{text}|{bytes, mime, path}], vars}
  async partsFor(item) {
    const parts = [];
    const vars = Object.assign({}, item.vars || {});
    for (const f of (item.input && item.input.files) || []) {
      const kind = f.kind || kindOf(f.path);
      const src = this.abs(f.path);
      if (kind === "image") {
        const { buf, mime } = await this.imageBytes(src, f.sha);
        parts.push({ bytes: buf, mime, path: src });
      } else if (kind === "video") {
        const vmode = (this.media.video && this.media.video.mode) || "grid";
        if (vmode === "native") parts.push({ bytes: fs.readFileSync(src), mime: f.mime || mimeOf(src), path: src });
        else {
          const g = await this.gridFor(f);
          if (vars.duration === undefined) vars.duration = g.meta.duration;
          if (vars.interval === undefined) vars.interval = g.meta.interval;
          if (vars.timing_line === undefined) vars.timing_line = legacyTimingLine(g.meta);
          const { buf, mime } = await this.imageBytes(g.path, `${f.sha || src}-grid-${this.vidHash}`);
          parts.push({ bytes: buf, mime, path: src });
        }
      } else if (kind === "text") {
        parts.push({ text: fs.readFileSync(src, "utf8") });
      } else {
        parts.push({ bytes: fs.readFileSync(src), mime: f.mime || mimeOf(src), path: src });
      }
    }
    if (item.input && typeof item.input.text === "string") parts.push({ text: item.input.text });
    return { parts, vars };
  }

  // Initialize phase: build every frame grid up front (so the run never waits on ffmpeg) and check
  // that every image is readable; image resizing itself happens lazily per call (in-memory LRU).
  async warm(items, onProgress, concurrency = 6) {
    let i = 0, done = 0;
    const errors = [];
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const it = items[i++];
        try {
          for (const f of (it.input && it.input.files) || []) {
            const kind = f.kind || kindOf(f.path);
            const vmode = (this.media.video && this.media.video.mode) || "grid";
            if (kind === "video" && vmode !== "native") await this.gridFor(f);
            else if (kind === "image") await sharp()(this.abs(f.path)).metadata();
            else fs.accessSync(this.abs(f.path), fs.constants.R_OK);
          }
        } catch (err) { errors.push({ id: it.id, error: err.message }); }
        done++;
        if (onProgress && (done % 25 === 0 || done === items.length)) onProgress(done, items.length);
      }
    });
    await Promise.all(workers);
    return errors;
  }
}

async function thumbnail(srcPath, outPath, width = 240) {
  if (fs.existsSync(outPath)) return outPath;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const kind = kindOf(srcPath);
  let input = srcPath;
  if (kind === "video") {
    const ffmpeg = which("ffmpeg");
    if (!ffmpeg) throw new Error("ffmpeg not found");
    const tmp = outPath + ".frame.png";
    await run(ffmpeg, ["-nostdin", "-y", "-ss", "0.5", "-i", srcPath, "-frames:v", "1", tmp], 20000);
    input = tmp;
  }
  await sharp()(input).resize({ width, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(outPath);
  if (input !== srcPath) try { fs.unlinkSync(input); } catch {}
  return outPath;
}

module.exports = { MediaPipeline, ByteLRU, buildGrid, videoDuration, thumbnail, which };
