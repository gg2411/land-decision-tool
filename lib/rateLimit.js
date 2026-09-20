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

// Any address header is forgeable unless a proxy in front of this process
// rewrites it, so headers are read only when the deployment says so: Vercel sets
// VERCEL and rewrites x-vercel-forwarded-for at the edge, and any other proxy
// setup opts in with TRUST_PROXY. Even then the rightmost hop is used — the one
// the proxy observed — because the caller controls everything to its left.
function clientKey(req, env = process.env) {
  const h = req.headers || {};
  const header = env.VERCEL
    ? h["x-vercel-forwarded-for"]
    : env.TRUST_PROXY
      ? h["x-forwarded-for"] || h["x-real-ip"]
      : null;
  if (typeof header === "string" && header.trim()) return header.split(",").pop().trim();

  return req.socket?.remoteAddress || "unknown";
}

module.exports = { createRateLimit, clientKey };
