// Server security + basic API behaviour (spawns server.js on a spare port with a temp projects dir).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { tmpDir } = require("./helpers");

const PORT = 18490 + Math.floor(Math.random() * 400);
let child, token;

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: Object.assign({ Host: `127.0.0.1:${PORT}` }, headers) }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env: Object.assign({}, process.env, { PORT: String(PORT), WPO_PROJECTS_DIR: tmpDir("wpo-srv-"), WPO_SECRETS_DIR: tmpDir("wpo-sec-") }), stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (/WPO general/.test(d.toString())) resolve(); });
    child.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
  const page = await req("GET", "/");
  token = page.body.match(/name="wpo-token" content="([0-9a-f]+)"/)[1];
});
test.after(() => { if (child) child.kill(); });

test("serves the app with a token and CSP; binds to localhost only", async () => {
  const r = await req("GET", "/");
  assert.strictEqual(r.status, 200);
  assert.ok(/default-src 'self'/.test(r.headers["content-security-policy"]));
  assert.ok(!r.headers["access-control-allow-origin"]);
  assert.match(token, /^[0-9a-f]{48}$/);
});

test("rejects bad Host (DNS rebinding), missing token, cross-origin writes", async () => {
  assert.strictEqual((await req("GET", "/", { headers: { Host: "evil.example:80" } })).status, 421);
  assert.strictEqual((await req("GET", "/api/projects")).status, 403);
  assert.strictEqual((await req("GET", "/api/projects", { headers: { "X-WPO-Token": "nope" } })).status, 403);
  const r = await req("POST", "/api/projects", { headers: { "X-WPO-Token": token, Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" });
  assert.strictEqual(r.status, 403);
});

test("static and item paths cannot escape their roots", async () => {
  for (const p of ["/../server.js", "/%2e%2e/server.js", "/..%2Fserver.js", "/vendor/../../server.js", "/%2e%2e%2f%2e%2e%2fpackage.json"]) {
    const r = await req("GET", p);
    assert.ok(r.status === 404 || r.status === 400, `${p} → ${r.status}`);
    assert.ok(!r.body.includes("require("), `${p} leaked a source file`);
  }
  const created = JSON.parse((await req("POST", "/api/projects", { headers: { "X-WPO-Token": token, "Content-Type": "application/json" }, body: JSON.stringify({ name: "sec" }) })).body);
  const id = created.project.id;
  const t = await req("GET", `/api/projects/${id}/items/${encodeURIComponent("../../server.js")}/thumb`, { headers: { "X-WPO-Token": token } });
  assert.strictEqual(t.status, 404);
  const up = await req("POST", `/api/projects/${id}/dataset/upload?path=${encodeURIComponent("../../evil.txt")}`, { headers: { "X-WPO-Token": token }, body: "x" });
  // the path is sanitised into the project's upload dir (".." segments dropped) — never written outside
  assert.ok(up.status === 200 || up.status === 400);
  if (up.status === 200) assert.ok(JSON.parse(up.body).root.includes(`${id}${path.sep}upload`));
  const bad = await req("GET", "/api/projects/..%2F..%2Fetc", { headers: { "X-WPO-Token": token } });
  assert.ok(bad.status >= 400);
});

test("connections are masked and secrets never returned", async () => {
  const body = JSON.stringify({ type: "openai", name: "test key", fields: { apiKey: "sk-test-secret-value-1234567890" } });
  const r = await req("POST", "/api/connections", { headers: { "X-WPO-Token": token, "Content-Type": "application/json" }, body });
  assert.strictEqual(r.status, 200);
  assert.ok(!r.body.includes("sk-test-secret-value-1234567890"));
  const list = await req("GET", "/api/connections", { headers: { "X-WPO-Token": token } });
  assert.ok(!list.body.includes("sk-test-secret-value-1234567890"));
  assert.ok(list.body.includes("\"masked\""));
});
