const test = require("node:test");
const assert = require("node:assert");
const { specProForma, maxLotPrice, breakEvenSalePrice, evaluateDeal, DEFAULT_COSTS } = require("../lib/proforma");

const base = { salePrice: 1000000, sqft: 3000, lotPrice: 439000 };

test("pro forma sums its line items into total cost", () => {
  const p = specProForma(base);
  const sum = Object.values(p.lineItems).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - p.totalCost) < 1, `${sum} vs ${p.totalCost}`);
  assert.equal(p.lineItems.hardCost, 3000 * 140);
  assert.equal(p.profit, Math.round((p.salePrice - p.totalCost - p.sellingCost) * 100) / 100);
});

test("margin is profit over everything spent, commission included", () => {
  const p = specProForma(base);
  assert.equal(p.allInCost, Math.round((p.totalCost + p.sellingCost) * 100) / 100);
  assert.ok(Math.abs(p.marginPct - p.profit / p.allInCost) < 1e-4, `margin ${p.marginPct}`);
  assert.ok(Math.abs(p.allInCostPerSqft - p.allInCost / p.sqft) < 0.01, `per sqft ${p.allInCostPerSqft}`);
});

test("the Houston base case does not pencil at the median 77009 lot price", () => {
  const p = specProForma(base);
  assert.ok(p.profit < 0, `expected a loss, got ${p.profit}`);
  assert.equal(p.verdict, "no");
});

test("maxLotPrice is the lot price that lands exactly on the target margin", () => {
  const lot = maxLotPrice({ salePrice: 1000000, sqft: 3000 });
  const p = specProForma({ ...base, lotPrice: lot });
  assert.ok(Math.abs(p.marginPct - DEFAULT_COSTS.targetMarginPct) < 1e-6, `margin ${p.marginPct}`);
  assert.equal(p.verdict, "go");
});

test("breakEvenSalePrice produces zero profit", () => {
  const sale = breakEvenSalePrice({ sqft: 3000, lotPrice: 439000 });
  const p = specProForma({ ...base, salePrice: sale });
  assert.ok(Math.abs(p.profit) < 1, `profit ${p.profit}`);
});

test("cheaper land and more sale price flip the verdict to go", () => {
  const p = specProForma({ salePrice: 1000000, sqft: 3000, lotPrice: 200000 });
  assert.equal(p.verdict, "go");
  assert.ok(p.profit > 0);
});

test("overrides replace the defaults", () => {
  const cheap = specProForma({ ...base, costs: { hardCostPerSqft: 100 } });
  const dear = specProForma({ ...base, costs: { hardCostPerSqft: 200 } });
  assert.equal(dear.lineItems.hardCost - cheap.lineItems.hardCost, 3000 * 100);
  const noCarry = specProForma({ ...base, costs: { months: 0 } });
  assert.equal(noCarry.lineItems.loanInterest, 0);
  assert.equal(noCarry.lineItems.propertyTax, 0);
});

test("evaluateDeal flags a price above what comps support", () => {
  const comps = { n: 12, medianPricePerSqft: 276, ppsfLow: 262, ppsfHigh: 290 };
  const d = evaluateDeal({ ...base, comps });
  assert.equal(d.compSupport.valueHigh, 290 * 3000);
  assert.ok(d.warnings.some((w) => w.includes("appraisal")));
  assert.ok(d.warnings.some((w) => w.includes("$150")), "should flag a sub-$150/sf build cost");
  assert.ok(d.lotOverpayBy > 0);
});

test("evaluateDeal stays quiet when the deal is inside every guardrail", () => {
  const comps = { n: 20, medianPricePerSqft: 330, ppsfLow: 300, ppsfHigh: 360 };
  const d = evaluateDeal({ salePrice: 1000000, sqft: 3000, lotPrice: 150000, costs: { hardCostPerSqft: 160 }, comps });
  assert.deepEqual(d.warnings, []);
  assert.equal(d.verdict, "go");
});
