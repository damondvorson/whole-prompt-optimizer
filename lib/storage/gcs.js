"use strict";
const fs = require("fs");
const path = require("path");
const { normPrefix } = require("./index");

function storageClient(conn) {
  const { Storage } = require("@google-cloud/storage");
  const f = (conn && conn.fields) || {};
  if (f.serviceAccountJson) {
    const sa = JSON.parse(f.serviceAccountJson);
    return new Storage({ credentials: sa, projectId: f.project || sa.project_id });
  }
  return new Storage(f.project ? { projectId: f.project } : {}); // ADC (gcloud auth application-default login)
}

function open(loc, conn, deps = {}) {
  const storage = deps.client || storageClient(conn);
  const bucket = storage.bucket(loc.bucket);
  const prefix = normPrefix(loc.prefix);
  return {
    kind: "gcs",
    describe: () => `gs://${loc.bucket}/${prefix}`,
    async listAll(onProgress) {
      const out = [];
      let query = { prefix: prefix || undefined, maxResults: 1000, autoPaginate: false };
      for (;;) {
        const [files, nextQuery] = await bucket.getFiles(query);
        for (const f of files) {
          if (f.name.endsWith("/")) continue;
          out.push({ key: f.name.slice(prefix.length), size: Number((f.metadata && f.metadata.size) || 0), etag: (f.metadata && (f.metadata.md5Hash || f.metadata.etag)) || "" });
        }
        if (onProgress) onProgress(out.length);
        if (!nextQuery || !nextQuery.pageToken) break;
        query = Object.assign({}, query, nextQuery);
      }
      return out;
    },
    async download(key, dest) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".part";
      await bucket.file(prefix + key).download({ destination: tmp });
      fs.renameSync(tmp, dest);
      return "downloaded";
    },
    async read(key, maxBytes) {
      const [buf] = await bucket.file(prefix + key).download(maxBytes ? { start: 0, end: maxBytes - 1 } : {});
      return buf;
    },
  };
}

module.exports = { open, storageClient };
