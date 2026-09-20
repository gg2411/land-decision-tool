// A fixed-window counter per client, held in memory.
//
// /api/parse-plan spends money on every call, so it needs a ceiling. A serverless
// instance is short-lived and there can be several at once, so this caps the damage
// one caller can do rather than enforcing a global quota.

function createRateLimit({ limit = 20, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map();

  return function check(key) {
    const t = now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);

    const entry = hits.get(key) || { count: 0, reset: t + windowMs };
    entry.count += 1;
    hits.set(key, entry);

    return {
      allowed: entry.count <= limit,
      retryAfterSec: Math.max(1, Math.ceil((entry.reset - t) / 1000)),
    };
  };
}

function clientKey(req) {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

module.exports = { createRateLimit, clientKey };
