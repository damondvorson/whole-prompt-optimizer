// storage/index.js — one interface over local folders, S3, GCS, Azure Blob and plain https URLs.
//   listAll(onProgress) → [{key, size, etag}]   keys are relative to the root prefix, "/"-separated
//   download(key, dest)  → writes the object to dest
//   read(key, maxBytes)  → Buffer (previews)
"use strict";

const os = require("os");
const path = require("path");

function parseLocation(uri) {
  const u = String(uri || "").trim();
  if (!u) throw new Error("Enter a bucket, container, URL or local folder");
  let m;
  if ((m = u.match(/^s3:\/\/([^/]+)\/?(.*)$/i))) return { kind: "s3", bucket: m[1], prefix: m[2] };
  if ((m = u.match(/^gs:\/\/([^/]+)\/?(.*)$/i))) return { kind: "gcs", bucket: m[1], prefix: m[2] };
  if ((m = u.match(/^az:\/\/([^/]+)\/?(.*)$/i))) return { kind: "azure", container: m[1], prefix: m[2] };
  if ((m = u.match(/^https:\/\/([^.]+)\.blob\.core\.windows\.net\/([^/?]+)\/?([^?]*)(\?.*)?$/i))) {
    return { kind: "azure", account: m[1], container: m[2], prefix: decodeURIComponent(m[3] || ""), sas: m[4] ? m[4].slice(1) : "" };
  }
  if ((m = u.match(/^https:\/\/([^.]+)\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com\/?([^?]*)/i))) return { kind: "s3", bucket: m[1], prefix: decodeURIComponent(m[3] || "") };
  if ((m = u.match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/?([^?]*)/i))) return { kind: "gcs", bucket: m[1], prefix: decodeURIComponent(m[2] || "") };
  if (/^https?:\/\//i.test(u)) return { kind: "https", url: u };
  let p = u.replace(/^file:\/\//i, "");
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  return { kind: "local", root: path.resolve(p) };
}

function normPrefix(prefix) {
  if (!prefix) return "";
  return prefix.endsWith("/") ? prefix : prefix + "/";
}

function openStorage(uri, connection) {
  const loc = parseLocation(uri);
  switch (loc.kind) {
    case "local": return require("./local").open(loc);
    case "s3": return require("./s3").open(loc, connection);
    case "gcs": return require("./gcs").open(loc, connection);
    case "azure": return require("./azure").open(loc, connection);
    case "https": return require("./https").open(loc);
    default: throw new Error(`Unsupported location: ${uri}`);
  }
}

module.exports = { parseLocation, openStorage, normPrefix };
