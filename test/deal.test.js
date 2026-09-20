const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/deal");

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(o) {
      this.body = o;
    },
  };
}

test("405 on GET", async () => {
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
});

test("400 on short address", async () => {
  const res = makeRes();
  await handler({ method: "POST", body: { address: "12" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "address must be a string of 3–120 characters");
});

test("400 on mock listing key", async () => {
  const res = makeRes();
  await handler({ method: "POST", body: { address: "1401 Rutland St", listingKey: "MOCK3" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Deep dive is not available for mock listings");
});

test("503 without Tavily API key", async () => {
  delete process.env.TAVILY_API_KEY;
  const res = makeRes();
  await handler({ method: "POST", body: { address: "1401 Rutland St" } }, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /TAVILY_API_KEY is not configured/);
});
