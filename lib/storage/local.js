"use strict";
const fs = require("fs");
const path = require("path");

const SKIP = new Set([".DS_Store", ".frame_tmp", ".git", "node_modules", "Thumbs.db"]);

function open(loc) {
  const root = loc.root;
  return {
    kind: "local",
    root,
    describe: () => root,
    async listAll(onProgress) {
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Folder not found: ${root}`);
      const out = [];
      const walk = (dir, rel) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
          const abs = path.join(dir, e.name);
          const key = rel ? `${rel}/${e.name}` : e.name;
          let st;
          try { st = fs.statSync(abs); } catch { continue; } // broken symlink etc.
          if (st.isDirectory()) walk(abs, key);
          else if (st.isFile()) {
            out.push({ key, size: st.size, etag: `${st.size}-${Math.floor(st.mtimeMs)}` });
            if (onProgress && out.length % 500 === 0) onProgress(out.length);
          }
        }
      };
      walk(root, "");
      if (onProgress) onProgress(out.length);
      return out;
    },
    absPath: (key) => path.join(root, ...key.split("/")),
    // mode: "clone" (APFS copy-on-write, falls back to copy when the volume can't clone) | "copy"
    async download(key, dest, mode = "clone") {
      const src = path.join(root, ...key.split("/"));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (mode === "clone") {
        try { fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE_FORCE); return "cloned"; } catch {}
      }
      fs.copyFileSync(src, dest);
      return "copied";
    },
    async read(key, maxBytes) {
      const src = path.join(root, ...key.split("/"));
      if (!maxBytes) return fs.readFileSync(src);
      const fd = fs.openSync(src, "r");
      try {
        const buf = Buffer.alloc(Math.min(maxBytes, fs.fstatSync(fd).size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        return buf;
      } finally { fs.closeSync(fd); }
    },
    // Same APFS volume as dest? (clones are free only within one volume)
    sameVolume(destDir) {
      try {
        fs.mkdirSync(destDir, { recursive: true });
        return fs.statSync(root).dev === fs.statSync(destDir).dev;
      } catch { return false; }
    },
  };
}

module.exports = { open };
