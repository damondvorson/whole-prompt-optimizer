"use strict";
// A single file behind an http(s) URL (a manifest or a .zip). Listing returns that one file.
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

function open(loc) {
  const name = decodeURIComponent(new URL(loc.url).pathname.split("/").filter(Boolean).pop() || "download");
  return {
    kind: "https",
    describe: () => loc.url.split("?")[0],
    async listAll() {
      const res = await fetch(loc.url, { method: "HEAD" }).catch(() => null);
      const size = res && res.ok ? Number(res.headers.get("content-length") || 0) : 0;
      return [{ key: name, size, etag: (res && res.headers.get("etag")) || "" }];
    },
    async download(key, dest) {
      const res = await fetch(loc.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${loc.url.split("?")[0]}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".part";
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return "downloaded";
    },
    async read(key, maxBytes) {
      const res = await fetch(loc.url, { headers: maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : {} });
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

module.exports = { open };
