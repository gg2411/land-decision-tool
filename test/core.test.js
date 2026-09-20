const test = require("node:test");
const assert = require("node:assert/strict");
const {
  pointInPolygon,
  summarizeComps,
  computeMaxLandPrice,
  impliedMargin,
  splitLotScenario,
  mockDataset,
} = require("../lib/core");

const SQUARE = [
  [29.75, -95.4],
  [29.76, -95.4],
  [29.76, -95.39],
  [29.75, -95.39],
];

test("pointInPolygon inside/outside", () => {
  assert.equal(pointInPolygon(29.755, -95.395, SQUARE), true);
  assert.equal(pointInPolygon(29.8, -95.395, SQUARE), false);
  assert.equal(pointInPolygon(29.755, -95.3, SQUARE), false);
});

test("summarizeComps filters and usedKeys", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const listings = [
    { listingKey: "A", price: 400000, livingAreaSqft: 2000, beds: 3, yearBuilt: 2024, soldDate: "2026-06-01" },
    { listingKey: "B", price: 420000, livingAreaSqft: 2100, beds: 4, yearBuilt: 1990, soldDate: "2026-06-01" },
    { listingKey: "C", price: 440000, livingAreaSqft: 2200, beds: 4, yearBuilt: null, soldDate: "2024-01-01" },
    { listingKey: "D", price: 460000, livingAreaSqft: 2300, beds: 4, yearBuilt: 2025, soldDate: null },
    { listingKey: "E", price: 480000, livingAreaSqft: 5000, beds: 4, yearBuilt: 2025, soldDate: "2026-06-01" },
  ];
  const c = summarizeComps(listings, { minSqft: 1800, maxSqft: 2500, minBeds: 4 });
  assert.equal(c.n, 3); // A fails beds, E fails maxSqft
  assert.deepEqual([...c.usedKeys].sort(), ["B", "C", "D"]);

  const c2 = summarizeComps(listings, { minYearBuilt: 2020 });
  assert.deepEqual([...c2.usedKeys].sort(), ["A", "C", "D", "E"]); // B fails year, C null passes

  const c3 = summarizeComps(listings, { soldWithinMonths: 6, now });
  assert.deepEqual([...c3.usedKeys].sort(), ["A", "B", "D", "E"]); // C too old, D null passes

  const none = summarizeComps(listings, { minBeds: 10 });
  assert.equal(none.n, 0);
  assert.deepEqual(none.usedKeys, []);
});

test("computeMaxLandPrice hand-computed", () => {
  const plan = { livingAreaSqft: 2400 };
  const comps = { n: 5, medianPricePerSqft: 400, ppsfLow: 380, ppsfHigh: 420 };
  const costs = { constructionCostPerSqft: 185, sellingCostPct: 0.07, targetMarginPct: 0.15, siteDevCost: 35000 };
  const r = computeMaxLandPrice(plan, comps, costs);
  assert.equal(r.arv, 960000);
  assert.equal(r.constructionCost, 444000);
  assert.equal(r.sellingCost, 67200);
  assert.equal(r.targetProfit, 144000);
  assert.equal(r.maxLandPrice, 269800);
});

test("impliedMargin", () => {
  const plan = { livingAreaSqft: 2400 };
  const comps = { n: 5, medianPricePerSqft: 400 };
  const costs = { constructionCostPerSqft: 185, sellingCostPct: 0.07, targetMarginPct: 0.15, siteDevCost: 35000 };
  const ok = impliedMargin(plan, comps, costs, 269800);
  assert.equal(ok.profit, 144000);
  assert.equal(ok.marginPct, 0.15);
  assert.equal(ok.meetsTarget, true);
  const bad = impliedMargin(plan, comps, costs, 300000);
  assert.equal(bad.meetsTarget, false);
  assert.ok(bad.marginPct < 0.15);
});

test("splitLotScenario", () => {
  const plan = { livingAreaSqft: 2400 };
  const comps = { n: 5, medianPricePerSqft: 400 };
  const costs = { constructionCostPerSqft: 185, sellingCostPct: 0.07, targetMarginPct: 0.15, siteDevCost: 35000 };
  const s = splitLotScenario(500000, 14000, plan, comps, costs, 2);
  assert.equal(s.perLotPrice, 250000);
  assert.equal(s.perLotSqft, 7000);
  assert.equal(s.perLotPricePerSqft, 35.71);
  assert.equal(s.maxLandPricePerLot, 269800);
  assert.equal(s.profitable, true);
  assert.ok(s.impliedMarginPerLot > 0.15);
});

test("mockDataset determinism and dates", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const a = mockDataset(SQUARE, 410, now);
  const b = mockDataset(SQUARE, 410, now);
  assert.deepEqual(a, b);
  for (const l of a.sold) {
    assert.ok(l.soldDate, "sold listing has soldDate");
    assert.ok(new Date(l.soldDate) <= now);
    assert.ok(new Date(l.soldDate) >= new Date(now.getTime() - 720 * 86400000));
    assert.ok(l.address);
  }
  for (const l of a.pending.concat(a.active)) {
    assert.equal(l.soldDate, null);
    assert.ok(l.listDate);
  }
});
