// errors.js — normalise provider errors into kinds the executor understands.
"use strict";

class AttentionError extends Error {
  constructor(kind, message, role) { super(message); this.name = "AttentionError"; this.kind = kind; this.role = role; }
}
class ParseRetry extends Error {
  constructor(message) { super(message); this.name = "ParseRetry"; }
}
class ProviderError extends Error {
  constructor(message, { status, kind, retryAfterMs, code } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

const TRANSIENT = new Set(["rate", "overloaded", "server", "timeout", "network", "parse"]);

function retryAfterFrom(headers) {
  if (!headers) return undefined;
  const get = (k) => (typeof headers.get === "function" ? headers.get(k) : headers[k] || headers[k.toLowerCase()]);
  const ms = get("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const s = get("retry-after") || get("x-amz-retry-after");
  if (!s) return undefined;
  if (Number.isFinite(Number(s))) return Number(s) * 1000;
  const d = Date.parse(s);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

function kindFromStatus(status, message) {
  const m = String(message || "");
  if (status === 429) return /quota|billing|credit|spend/i.test(m) ? "quota" : "rate";
  if (status === 529 || status === 503) return "overloaded";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "server";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 404) return "not_found";
  if (status === 413) return "too_large";
  if (status === 400 || status === 422) {
    if (/context|too long|too many tokens|token count|maximum.*tokens|exceeds/i.test(m)) return "too_large";
    return "invalid";
  }
  return undefined;
}

// Generic classification (providers may set err.kind themselves).
function classify(err) {
  if (!err) return "server";
  if (err instanceof ParseRetry) return "parse";
  if (err.kind) return err.kind;
  const msg = `${err.message || ""} ${err.code || ""} ${err.name || ""}`;
  const status = err.status || err.statusCode || (err.$metadata && err.$metadata.httpStatusCode) || (err.response && err.response.status);
  const fromStatus = status ? kindFromStatus(Number(status), msg) : undefined;
  if (fromStatus) return fromStatus;
  if (/ThrottlingException|TooManyRequests|RESOURCE_EXHAUSTED|rate.?limit/i.test(msg)) return "rate";
  if (/ServiceUnavailable|UNAVAILABLE|overloaded|ModelNotReady/i.test(msg)) return "overloaded";
  if (/AccessDenied|UnrecognizedClient|ExpiredToken|invalid_grant|reauth|Could not load the default credentials|unauthenticated|PERMISSION_DENIED|UNAUTHENTICATED|credentials/i.test(msg)) return "auth";
  if (/ValidationException|INVALID_ARGUMENT/i.test(msg)) return "invalid";
  if (/ResourceNotFound|NOT_FOUND/i.test(msg)) return "not_found";
  if (/timeout|timed out|ETIMEDOUT|AbortError|ModelTimeout/i.test(msg)) return "timeout";
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i.test(msg)) return "network";
  return "server";
}

// The original engine's own tests (wpo_video_engine.js 218–222, 349) — used only to pick the backoff
// curve, so retry timing matches the original for the errors it recognised.
function legacyRateOrAuth(err) {
  const msg = (err && (err.message || "")) + (err && (err.status || ""));
  return /429|resource.*exhausted|quota|rate.?limit/i.test(msg) || /oauth|token.*failed|credentials|reason:/i.test((err && err.message) || "");
}

module.exports = { AttentionError, ParseRetry, ProviderError, TRANSIENT, classify, kindFromStatus, retryAfterFrom, legacyRateOrAuth };
