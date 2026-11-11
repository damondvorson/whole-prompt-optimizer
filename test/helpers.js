"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

// Deterministic PRNG (mulberry32) so fuzz failures are reproducible from the seed.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: (p = 0.5) => next() < p,
    shuffle: (arr) => { const a2 = arr.slice(); for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; } return a2; },
  };
  const ATOMS = ["alpha", "beta", "the resident", "staff", "{{timing_line}}", "$&", "$1", "\"quoted\"", "it's", "<b>", "\\n", "ünïcödé", "—", "✓", "{", "}", "[", "]", "``` json", "\n", "\n\n", "  ", "\t", "0.5", "100%"];
  r.text = (minWords = 0, maxWords = 30) => {
    const n = r.int(minWords, maxWords);
    const out = [];
    for (let i = 0; i < n; i++) out.push(r.bool(0.7) ? r.pick(ATOMS.slice(0, 4)) : r.pick(ATOMS));
    return out.join(r.pick([" ", " ", "", "\n"]));
  };
  r.float = () => r.pick([0, 100, 80, 79.99999, 80.00001, 50, 33.333333333333336, 66.66666666666667, r.next() * 100, r.next() * 100]);
  return r;
}

// Folder of an original wpo_video_optimizer (runners, grids, API logs). Tests that need it skip when absent.
const LEGACY_DIR = process.env.WPO_LEGACY_DIR || path.join(__dirname, "..", "..", "wpo_video_optimizer");

function tmpDir(prefix = "wpo-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { rng, tmpDir, LEGACY_DIR };
