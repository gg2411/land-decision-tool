const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/analyze");

// Tests exercise the deterministic mock path regardless of local credentials.
delete process.env.REPLIERS_API_KEY;
delete process.env.HAR_API_KEY;

const SQUARE = [
  [29.75, -95.4],
  [29.76, -95.4],
  [29.76, -95.39],
  [29.75, -95.39],
];

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

test("POST analyze with mock data", async () => {
  const res = makeRes();
  await handler(
    { method: "POST", body: { polygon: SQUARE, lotAskingPrice: 250000 } },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dataSource, "mock");
  const statuses = new Set(res.body.compsPoints.map((p) => p.status));
  assert.ok(statuses.has("sold") && statuses.has("pending") && statuses.has("active"));
  assert.ok(res.body.compsPoints.some((p) => p.used === true));
  assert.ok(res.body.compsPoints.some((p) => p.status === "sold" && p.used === false) || res.body.comps.n === res.body.counts.sold);
  assert.ok(res.body.asking);
  assert.equal(res.body.asking.landPrice, 250000);
  assert.ok(res.body.result.maxLandPrice > 0);
});

test("asking is null without lotAskingPrice", async () => {
  const res = makeRes();
  await handler({ method: "POST", body: { polygon: SQUARE } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.asking, null);
});

test("405 on GET", async () => {
  const res = makeRes();
  await handler({ method: "GET" }, res);
  assert.equal(res.statusCode, 405);
});

test("400 on bad polygon", async () => {
  const res = makeRes();
  await handler({ method: "POST", body: { polygon: [[1, 2]] } }, res);
  assert.equal(res.statusCode, 400);
  assert.ok(res.body.error);
});
