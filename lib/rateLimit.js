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

// Only headers the hosting platform sets itself can be trusted; a caller can put
// anything in x-forwarded-for, so it is used only where the deployment says a
// proxy rewrites it (TRUST_PROXY), and then the rightmost hop — the one the proxy
// observed — rather than the leftmost, which the caller controls.
function clientKey(req, env = process.env) {
  const h = req.headers || {};
  const platform = h["x-vercel-forwarded-for"] || h["x-real-ip"];
  if (typeof platform === "string" && platform.trim()) return platform.split(",").pop().trim();

  const fwd = h["x-forwarded-for"];
  if (env.TRUST_PROXY && typeof fwd === "string" && fwd.trim()) return fwd.split(",").pop().trim();

  return req.socket?.remoteAddress || "unknown";
}

module.exports = { createRateLimit, clientKey };
