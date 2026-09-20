const test = require("node:test");
const assert = require("node:assert");
const analyze = require("../api/analyze");

const POLY = [[29.81, -95.37], [29.81, -95.34], [29.77, -95.34], [29.77, -95.37]];

// The endpoint hits Repliers when a key is present; these tests only exercise
// the request-validation path, which returns before any network call.
function call(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    analyze({ method: "POST", body }, res);
  });
}

const valid = { polygon: POLY, plan: { livingAreaSqft: 3000 }, lotPrice: 439000, salePrice: 1000000 };

test("a polygon with fewer than 3 points is rejected", async () => {
  const r = await call({ ...valid, polygon: [[29.8, -95.3]] });
  assert.equal(r.status, 400);
  assert.match(r.payload.error, /polygon/);
});

test("a zero or negative lot price is rejected instead of priced as free land", async () => {
  for (const lotPrice of [0, -1]) {
    const r = await call({ ...valid, lotPrice });
    assert.equal(r.status, 400);
    assert.match(r.payload.error, /what the lot costs/);
  }
});

test("a non-positive house size or sale price is rejected", async () => {
  const noSqft = await call({ ...valid, plan: { livingAreaSqft: 0 } });
  assert.equal(noSqft.status, 400);
  assert.match(noSqft.payload.error, /square feet/);

  const badSale = await call({ ...valid, salePrice: -500 });
  assert.equal(badSale.status, 400);
  assert.match(badSale.payload.error, /sale price/);
});

test("a cleared size field is rejected instead of falling back to the default", async () => {
  const r = await call({ ...valid, plan: { livingAreaSqft: null } });
  assert.equal(r.status, 400);
  assert.match(r.payload.error, /square feet/);
});

test("a malformed plan value falls back to the default instead of erroring", async () => {
  const r = await call({ ...valid, plan: "unknown" });
  assert.notEqual(r.status, 500);
});

test("out-of-range percentages are rejected", async () => {
  const r = await call({ ...valid, specCosts: { loanRatePct: 8.5 } }); // sent as 850%, not 0.085
  assert.equal(r.status, 400);
  assert.match(r.payload.error, /loanRatePct/);
});

test("a negative fixed cost is rejected", async () => {
  const r = await call({ ...valid, specCosts: { cityFees: -1000 } });
  assert.equal(r.status, 400);
  assert.match(r.payload.error, /cityFees/);
});
