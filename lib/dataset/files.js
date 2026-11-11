// files.js — file-type helpers shared by the dataset and media layers.
"use strict";
const path = require("path");
const crypto = require("crypto");

const EXT = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"],
  video: ["mp4", "mov", "m4v", "avi", "mkv", "webm"],
  audio: ["wav", "mp3", "m4a", "flac", "ogg", "aac"],
  pdf: ["pdf"],
  text: ["txt", "md"],
};
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/mp4", avi: "video/x-msvideo", mkv: "video/x-matroska", webm: "video/webm",
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac", ogg: "audio/ogg", aac: "audio/aac",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
};

function ext(name) { return (path.extname(name).slice(1) || "").toLowerCase(); }
function kindOf(name) {
  const e = ext(name);
  for (const [k, list] of Object.entries(EXT)) if (list.includes(e)) return k;
  return null;
}
function mimeOf(name) { return MIME[ext(name)] || "application/octet-stream"; }
function stemOf(name) { return path.basename(name).replace(/\.[^.]+$/, ""); }
function isMetaCompanion(name) { return /\.meta\.json$/i.test(name); }
function isManifest(name) { return /\.(csv|tsv|jsonl|ndjson|json)$/i.test(name) && !isMetaCompanion(name); }

// Field keys: keep legacy keys unchanged (they're already [a-z0-9_]); turn "bed exit" into "bed_exit".
function keyFromName(name) {
  return String(name).trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "field";
}

function sha1(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

module.exports = { EXT, MIME, ext, kindOf, mimeOf, stemOf, isMetaCompanion, isManifest, keyFromName, sha1 };
