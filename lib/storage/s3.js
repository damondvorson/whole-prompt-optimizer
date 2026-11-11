"use strict";
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { normPrefix } = require("./index");

function awsCredentials(conn) {
  const f = (conn && conn.fields) || {};
  if (f.accessKeyId && f.secretAccessKey) {
    return { accessKeyId: f.accessKeyId, secretAccessKey: f.secretAccessKey, sessionToken: f.sessionToken || undefined };
  }
  if (f.profile) return require("@aws-sdk/credential-providers").fromIni({ profile: f.profile });
  return undefined; // SDK default chain (env, ~/.aws, SSO, instance roles)
}

function client(conn, region) {
  const { S3Client } = require("@aws-sdk/client-s3");
  const f = (conn && conn.fields) || {};
  if (conn && conn.type === "bedrock_key") throw new Error("Bedrock API keys cannot read S3 — use an AWS connection");
  return new S3Client({ region: region || f.region || "us-east-1", followRegionRedirects: true, credentials: awsCredentials(conn), maxAttempts: 4 });
}

function open(loc, conn, deps = {}) {
  const s3 = deps.client || client(conn);
  const prefix = normPrefix(loc.prefix);
  const { paginateListObjectsV2, GetObjectCommand } = deps.sdk || require("@aws-sdk/client-s3");
  return {
    kind: "s3",
    describe: () => `s3://${loc.bucket}/${prefix}`,
    async listAll(onProgress) {
      const out = [];
      for await (const page of paginateListObjectsV2({ client: s3, pageSize: 1000 }, { Bucket: loc.bucket, Prefix: prefix || undefined })) {
        for (const o of page.Contents || []) {
          if (!o.Key || o.Key.endsWith("/")) continue;
          out.push({ key: o.Key.slice(prefix.length), size: Number(o.Size || 0), etag: String(o.ETag || "").replace(/"/g, "") });
        }
        if (onProgress) onProgress(out.length);
      }
      return out;
    },
    async download(key, dest) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const res = await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: prefix + key }));
      const tmp = dest + ".part";
      await pipeline(res.Body, fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return "downloaded";
    },
    async read(key, maxBytes) {
      const res = await s3.send(new GetObjectCommand({ Bucket: loc.bucket, Key: prefix + key, Range: maxBytes ? `bytes=0-${maxBytes - 1}` : undefined }));
      const chunks = [];
      for await (const c of res.Body) chunks.push(c);
      return Buffer.concat(chunks);
    },
  };
}

module.exports = { open, client, awsCredentials };
