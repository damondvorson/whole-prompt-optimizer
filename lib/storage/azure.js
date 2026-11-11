"use strict";
const fs = require("fs");
const path = require("path");
const { normPrefix } = require("./index");

function containerClient(loc, conn) {
  const { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } = require("@azure/storage-blob");
  const f = (conn && conn.fields) || {};
  const account = loc.account || f.accountName;
  if (loc.sas) return new ContainerClient(`https://${account}.blob.core.windows.net/${loc.container}?${loc.sas}`);
  if (f.connectionString) return BlobServiceClient.fromConnectionString(f.connectionString).getContainerClient(loc.container);
  if (f.sasUrl) {
    const u = new URL(f.sasUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 1) return new ContainerClient(f.sasUrl); // container-level SAS URL
    return new BlobServiceClient(f.sasUrl).getContainerClient(loc.container);
  }
  if (!account) throw new Error("Azure: give a https://ACCOUNT.blob.core.windows.net/CONTAINER/… URL or set the account on the connection");
  const url = `https://${account}.blob.core.windows.net`;
  if (f.accountKey) return new BlobServiceClient(url, new StorageSharedKeyCredential(account, f.accountKey)).getContainerClient(loc.container);
  const { DefaultAzureCredential } = require("@azure/identity");
  return new BlobServiceClient(url, new DefaultAzureCredential()).getContainerClient(loc.container);
}

function open(loc, conn, deps = {}) {
  const cc = deps.client || containerClient(loc, conn);
  const prefix = normPrefix(loc.prefix);
  return {
    kind: "azure",
    describe: () => `${cc.url ? cc.url.split("?")[0] : loc.container}/${prefix}`,
    async listAll(onProgress) {
      const out = [];
      for await (const b of cc.listBlobsFlat({ prefix: prefix || undefined })) {
        if (b.name.endsWith("/")) continue;
        out.push({ key: b.name.slice(prefix.length), size: Number((b.properties && b.properties.contentLength) || 0), etag: String((b.properties && b.properties.etag) || "").replace(/"/g, "") });
        if (onProgress && out.length % 500 === 0) onProgress(out.length);
      }
      if (onProgress) onProgress(out.length);
      return out;
    },
    async download(key, dest) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + ".part";
      await cc.getBlobClient(prefix + key).downloadToFile(tmp);
      fs.renameSync(tmp, dest);
      return "downloaded";
    },
    async read(key, maxBytes) {
      return cc.getBlobClient(prefix + key).downloadToBuffer(0, maxBytes || undefined);
    },
  };
}

module.exports = { open, containerClient };
