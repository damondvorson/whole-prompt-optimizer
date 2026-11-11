// connections.js — credentials shared by data sources and harnesses.
// Stored in .secrets/connections.json in the app folder (mode 0600, outside every project folder). Secrets are
// never returned to the browser (masked) and are handed to engine workers over IPC only.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SECRETS_DIR = process.env.WPO_SECRETS_DIR || path.join(__dirname, "..", ".secrets");
const STORE = path.join(SECRETS_DIR, "connections.json");

// Connection types: fields marked secret are masked; "how" is the setup help shown in the UI.
const TYPES = {
  gemini: {
    label: "Gemini API (Google AI Studio key)", uses: ["harness"],
    fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
    how: ["Create a key at https://aistudio.google.com/apikey and paste it here.", "Or set GEMINI_API_KEY in the environment / .env."],
  },
  vertex: {
    label: "Google Vertex AI", uses: ["harness"],
    fields: [
      { key: "project", label: "Project ID", required: false },
      { key: "location", label: "Location", default: "global" },
      { key: "serviceAccountJson", label: "Service-account JSON (optional)", secret: true, multiline: true },
      { key: "apiKey", label: "Vertex express API key (optional)", secret: true },
    ],
    how: [
      "Easiest on your own machine: run `gcloud auth application-default login`, then enter your project ID.",
      "On a server: paste a service-account JSON key with the \"Vertex AI User\" role.",
      "Enable the API once: `gcloud services enable aiplatform.googleapis.com --project YOUR_PROJECT`.",
    ],
  },
  aws: {
    label: "AWS (Bedrock + S3)", uses: ["harness", "data"],
    fields: [
      { key: "region", label: "Region", default: "us-east-1" },
      { key: "accessKeyId", label: "Access key ID (optional)", secret: false },
      { key: "secretAccessKey", label: "Secret access key", secret: true },
      { key: "sessionToken", label: "Session token (optional)", secret: true },
      { key: "profile", label: "Profile name (optional)" },
    ],
    how: [
      "Paste an IAM access key (Bedrock: AmazonBedrockFullAccess or bedrock:InvokeModel*; S3: read access to the bucket).",
      "Or leave keys blank to use your CLI login: `aws configure` or `aws sso login --profile NAME` (then enter the profile).",
    ],
  },
  bedrock_key: {
    label: "AWS Bedrock API key", uses: ["harness"],
    fields: [{ key: "apiKey", label: "Bedrock API key", secret: true, required: true }, { key: "region", label: "Region", default: "us-east-1" }],
    how: ["Create one in the Bedrock console → API keys. Works for Bedrock models only (not S3).", "Or set AWS_BEARER_TOKEN_BEDROCK."],
  },
  azure_openai: {
    label: "Azure OpenAI / AI Foundry", uses: ["harness"],
    fields: [
      { key: "endpoint", label: "Endpoint (https://RESOURCE.openai.azure.com)", required: true },
      { key: "apiKey", label: "API key (blank = Entra ID via az login)", secret: true },
      { key: "deployments", label: "Deployment names (comma-separated)" },
    ],
    how: ["Paste the endpoint and a key from the Azure portal (Keys and Endpoint).", "Or leave the key blank and run `az login` (needs the \"Cognitive Services OpenAI User\" role)."],
  },
  azure_blob: {
    label: "Azure Blob Storage", uses: ["data"],
    fields: [
      { key: "connectionString", label: "Connection string", secret: true },
      { key: "sasUrl", label: "Account or container SAS URL", secret: true },
      { key: "accountName", label: "Account name (with key or Entra)" },
      { key: "accountKey", label: "Account key", secret: true },
    ],
    how: ["Paste a connection string or a SAS URL (Storage account → Access keys / Shared access signature).", "Or enter the account name and run `az login` (needs \"Storage Blob Data Reader\")."],
  },
  gcs: {
    label: "Google Cloud Storage", uses: ["data"],
    fields: [{ key: "serviceAccountJson", label: "Service-account JSON (blank = gcloud login)", secret: true, multiline: true }, { key: "project", label: "Project ID (optional)" }],
    how: ["Run `gcloud auth application-default login`, or paste a service-account key with \"Storage Object Viewer\"."],
  },
  openai: {
    label: "OpenAI", uses: ["harness"],
    fields: [{ key: "apiKey", label: "API key", secret: true, required: true }, { key: "organization", label: "Organization (optional)" }],
    how: ["Create a key at https://platform.openai.com/api-keys.", "Or set OPENAI_API_KEY."],
  },
  anthropic: {
    label: "Anthropic (Claude)", uses: ["harness"],
    fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
    how: ["Create a key at https://console.anthropic.com/settings/keys.", "Or set ANTHROPIC_API_KEY."],
  },
  openai_compatible: {
    label: "OpenAI-compatible endpoint", uses: ["harness"],
    fields: [{ key: "baseURL", label: "Base URL (…/v1)", required: true }, { key: "apiKey", label: "API key (optional)", secret: true }],
    how: ["OpenRouter: https://openrouter.ai/api/v1 · Groq: https://api.groq.com/openai/v1 · Together: https://api.together.xyz/v1", "Local: Ollama http://localhost:11434/v1 · LM Studio http://localhost:1234/v1 · vLLM http://localhost:8000/v1"],
  },
  custom_http: {
    label: "Custom HTTP harness", uses: ["harness"],
    fields: [{ key: "url", label: "URL", required: true }, { key: "token", label: "Bearer token (optional)", secret: true }, { key: "headers", label: "Extra headers (JSON, optional)", secret: true, multiline: true }],
    how: ["Your service receives POST {system, parts, response_schema, temperature, max_output_tokens} and returns {text} or {json}.", "Or edit the request template on the harness card to call any existing API."],
  },
  mock: {
    label: "Mock (offline testing)", uses: ["harness"],
    fields: [{ key: "behavior", label: "Behavior", default: "keyword" }],
    how: ["Deterministic fake model for trying the app without API spend."],
  },
};

function ensureDir() {
  if (!fs.existsSync(SECRETS_DIR)) fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
}

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { connections: [] }; }
}

function save(data) {
  ensureDir();
  const tmp = STORE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE);
  try { fs.chmodSync(STORE, 0o600); } catch {}
}

function mask(value) {
  if (!value) return "";
  const s = String(value);
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function publicView(conn) {
  const t = TYPES[conn.type] || { fields: [] };
  const fields = {};
  for (const f of t.fields) {
    const v = conn.fields ? conn.fields[f.key] : undefined;
    if (v === undefined || v === "") continue;
    fields[f.key] = f.secret ? { set: true, masked: mask(v) } : v;
  }
  return { id: conn.id, type: conn.type, name: conn.name, fields, source: conn.source || "saved", createdAt: conn.createdAt };
}

// .env in the project root, re-read on every call so a key added later works without a restart.
// Real environment variables take precedence over the file.
function dotEnvValues() {
  const p = path.join(__dirname, "..", ".env");
  const out = {};
  try {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, "");
      out[m[1]] = v;
    }
  } catch {}
  return out;
}

// gcloud's default project (so "gcloud application-default login" connections come pre-filled)
function gcloudDefaultProject() {
  try {
    const dir = path.join(os.homedir(), ".config", "gcloud");
    let name = "default";
    try { name = fs.readFileSync(path.join(dir, "active_config"), "utf8").trim() || "default"; } catch {}
    const cfg = fs.readFileSync(path.join(dir, "configurations", `config_${name}`), "utf8");
    const m = cfg.match(/^\s*project\s*=\s*(\S+)/m);
    return m ? m[1] : "";
  } catch { return ""; }
}

// Connections detected from the environment / .env / CLI logins (not saved; read on demand).
function detectEnvironment() {
  const env = Object.assign({}, dotEnvValues(), process.env);
  const out = [];
  const add = (type, name, fields) => out.push({ id: `env:${type}:${name}`, type, name, fields, source: "environment" });
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) add("gemini", "GEMINI_API_KEY", { apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY });
  if (env.OPENAI_API_KEY) add("openai", "OPENAI_API_KEY", { apiKey: env.OPENAI_API_KEY });
  if (env.ANTHROPIC_API_KEY) add("anthropic", "ANTHROPIC_API_KEY", { apiKey: env.ANTHROPIC_API_KEY });
  if (env.AWS_BEARER_TOKEN_BEDROCK) add("bedrock_key", "AWS_BEARER_TOKEN_BEDROCK", { apiKey: env.AWS_BEARER_TOKEN_BEDROCK, region: env.AWS_REGION || "us-east-1" });
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    add("aws", "AWS env keys", { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN, region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1" });
  } else if (fs.existsSync(path.join(os.homedir(), ".aws", "credentials")) || fs.existsSync(path.join(os.homedir(), ".aws", "config"))) {
    add("aws", "AWS CLI profile (default chain)", { region: env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1", profile: env.AWS_PROFILE || "" });
  }
  if (env.AZURE_STORAGE_CONNECTION_STRING) add("azure_blob", "AZURE_STORAGE_CONNECTION_STRING", { connectionString: env.AZURE_STORAGE_CONNECTION_STRING });
  if (env.AZURE_OPENAI_ENDPOINT) add("azure_openai", "AZURE_OPENAI_ENDPOINT", { endpoint: env.AZURE_OPENAI_ENDPOINT, apiKey: env.AZURE_OPENAI_API_KEY || "" });
  const adc = env.GOOGLE_APPLICATION_CREDENTIALS || path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json");
  if (fs.existsSync(adc)) {
    let project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT || "";
    try { if (!project) project = JSON.parse(fs.readFileSync(adc, "utf8")).quota_project_id || ""; } catch {}
    if (!project) project = gcloudDefaultProject();
    add("vertex", "gcloud application-default login", { project, location: "global" });
    add("gcs", "gcloud application-default login", { project });
  }
  return out;
}

function loadDotEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (fs.existsSync(p) && typeof process.loadEnvFile === "function") {
    try { process.loadEnvFile(p); } catch {}
  }
}

function list() {
  return [...load().connections.map(publicView), ...detectEnvironment().map(publicView)];
}

function get(id) {
  if (!id) return null;
  if (id.startsWith("env:")) return detectEnvironment().find((c) => c.id === id) || null;
  return load().connections.find((c) => c.id === id) || null;
}

function create({ type, name, fields }) {
  if (!TYPES[type]) throw new Error(`Unknown connection type: ${type}`);
  const t = TYPES[type];
  const clean = {};
  for (const f of t.fields) {
    const v = fields ? fields[f.key] : undefined;
    if (v !== undefined && v !== null && String(v).trim() !== "") clean[f.key] = String(v).trim();
    else if (f.default !== undefined) clean[f.key] = f.default;
  }
  for (const f of t.fields) if (f.required && !clean[f.key]) throw new Error(`${f.label} is required`);
  if (clean.serviceAccountJson) {
    try { JSON.parse(clean.serviceAccountJson); } catch { throw new Error("Service-account JSON is not valid JSON"); }
  }
  if (clean.headers) {
    try { JSON.parse(clean.headers); } catch { throw new Error("Extra headers must be a JSON object"); }
  }
  const data = load();
  const conn = { id: crypto.randomBytes(6).toString("hex"), type, name: name || t.label, fields: clean, createdAt: new Date().toISOString() };
  data.connections.push(conn);
  save(data);
  return publicView(conn);
}

function update(id, { name, fields }) {
  const data = load();
  const conn = data.connections.find((c) => c.id === id);
  if (!conn) throw new Error("Connection not found");
  if (name) conn.name = name;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      if (String(v).trim() === "") delete conn.fields[k];
      else conn.fields[k] = String(v).trim();
    }
  }
  save(data);
  return publicView(conn);
}

function remove(id) {
  const data = load();
  const before = data.connections.length;
  data.connections = data.connections.filter((c) => c.id !== id);
  save(data);
  return before !== data.connections.length;
}

// Every secret value of a connection (for log redaction).
function secretValues(conn) {
  if (!conn) return [];
  const t = TYPES[conn.type] || { fields: [] };
  const out = [];
  for (const f of t.fields) if (f.secret && conn.fields && conn.fields[f.key]) out.push(String(conn.fields[f.key]));
  if (conn.fields && conn.fields.serviceAccountJson) {
    try { const sa = JSON.parse(conn.fields.serviceAccountJson); if (sa.private_key) out.push(sa.private_key); } catch {}
  }
  return out.filter((s) => s.length >= 6);
}

module.exports = { TYPES, list, get, create, update, remove, publicView, detectEnvironment, loadDotEnv, secretValues, mask, STORE };
