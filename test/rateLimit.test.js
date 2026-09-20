const test = require("node:test");
const assert = require("node:assert");
const { createRateLimit, clientKey } = require("../lib/rateLimit");

test("a caller is cut off after the limit and freed in the next window", () => {
  let now = 1000;
  const check = createRateLimit({ limit: 2, windowMs: 60_000, now: () => now });

  assert.equal(check("a").allowed, true);
  assert.equal(check("a").allowed, true);
  const blocked = check("a");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 60);

  assert.equal(check("b").allowed, true, "other callers are unaffected");

  now += 61_000;
  assert.equal(check("a").allowed, true);
});

test("clientKey ignores headers a caller can forge", () => {
  const socket = { remoteAddress: "10.0.0.1" };
  assert.equal(
    clientKey({ headers: { "x-forwarded-for": "1.2.3.4" }, socket }, {}),
    "10.0.0.1",
    "an untrusted x-forwarded-for must not become the key"
  );
  assert.equal(
    clientKey({ headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.5" }, socket }, { TRUST_PROXY: "1" }),
    "203.0.113.5",
    "behind a trusted proxy, the hop the proxy saw wins"
  );
  assert.equal(clientKey({ headers: { "x-vercel-forwarded-for": "198.51.100.7" }, socket }, {}), "198.51.100.7");
  assert.equal(clientKey({ headers: {}, socket }, {}), "10.0.0.1");
  assert.equal(clientKey({ headers: {} }, {}), "unknown");
});

test("/api/parse-plan returns 429 once a caller floods it", async () => {
  const handler = require("../api/parse-plan");
  const req = () => ({
    method: "POST",
    headers: { "x-vercel-forwarded-for": "198.51.100.9" },
    body: { file: "data:image/png;base64,PHNjcmlwdD4=" },
  });
  const run = async () => {
    let code = 0;
    let payload = null;
    const res = {
      setHeader() {},
      status(c) {
        code = c;
        return res;
      },
      json(o) {
        payload = o;
      },
    };
    await handler(req(), res);
    return { code, payload };
  };

  let last = null;
  for (let i = 0; i < 11; i++) last = await run();
  assert.equal(last.code, 429);
  assert.match(last.payload.error, /Too many plan uploads/);
});
