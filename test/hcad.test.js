const test = require("node:test");
const assert = require("node:assert/strict");
const { parseHcadFeature, summarizeLandValues } = require("../lib/hcad");

function makeFeature(attrs, ring) {
  return {
    attributes: attrs,
    geometry: { rings: [ring || [[-95.4, 29.7], [-95.39, 29.7], [-95.39, 29.71], [-95.4, 29.71], [-95.4, 29.7]]] },
  };
}

const BASE_ATTRS = {
  HCAD_NUM: "001234",
  site_str_num: "3001",
  site_str_pfx: "W",
  site_str_name: "MAIN",
  site_str_sfx: "ST",
  site_zip: "77005",
  state_class: "A1",
  land_value: 600000,
  bld_value: 400000,
  total_market_val: 1000000,
  land_sqft: 6000,
  new_owner_date: Date.UTC(2026, 5, 15),
  dscr: "WEST U SEC 1",
};

test("parseHcadFeature parses fields, centroid, and flags", () => {
  const p = parseHcadFeature(makeFeature(BASE_ATTRS));
  assert.equal(p.acct, "001234");
  assert.equal(p.address, "3001 W MAIN ST");
  assert.equal(p.zip, "77005");
  assert.equal(p.neighborhood, "WEST U SEC 1");
  assert.equal(p.vacant, false);
  assert.equal(p.landValue, 600000);
  assert.equal(p.lotSizeSqft, 6000);
  assert.equal(p.landValuePerSqft, 100);
  assert.equal(p.transferDate, "2026-06-15");
  // closing vertex repeats the first point, skewing the mean slightly
  assert.ok(Math.abs(p.latitude - 29.704) < 1e-9);
  assert.ok(Math.abs(p.longitude + 95.396) < 1e-9);
});

test("parseHcadFeature handles vacant, nulls, and zero lot", () => {
  const vacant = parseHcadFeature(
    makeFeature({ ...BASE_ATTRS, state_class: "C1", land_value: null, bld_value: null, new_owner_date: null })
  );
  assert.equal(vacant.vacant, true);
  assert.equal(vacant.landValue, null);
  assert.equal(vacant.landValuePerSqft, null);
  assert.equal(vacant.transferDate, null);

  const zeroLot = parseHcadFeature(makeFeature({ ...BASE_ATTRS, land_sqft: 0 }));
  assert.equal(zeroLot.lotSizeSqft, null);
  assert.equal(zeroLot.landValuePerSqft, null);
});

function parcel(over = {}) {
  return {
    acct: over.acct || "X",
    vacant: !!over.vacant,
    landValue: 300000,
    landValuePerSqft: "landValuePerSqft" in over ? over.landValuePerSqft : 100,
    lotSizeSqft: "lotSizeSqft" in over ? over.lotSizeSqft : 5000,
    transferDate: over.transferDate ?? null,
  };
}

test("summarizeLandValues uses recent transfers when >= 5", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const recent = Array.from({ length: 5 }, (_, i) =>
    parcel({ acct: `R${i}`, landValuePerSqft: 200 + i, transferDate: "2026-06-01" })
  );
  const old = Array.from({ length: 4 }, (_, i) =>
    parcel({ acct: `O${i}`, landValuePerSqft: 10 + i, transferDate: "2020-01-01" })
  );
  const s = summarizeLandValues(recent.concat(old), { soldWithinMonths: 12, now });
  assert.equal(s.basis, "recent-transfers");
  assert.equal(s.n, 5);
  assert.equal(s.nRecentTransfers, 5);
  assert.equal(s.nParcels, 9);
  assert.equal(s.medianLandValuePerSqft, 202);
  assert.equal(s.landPpsfLow, 201);
  assert.equal(s.landPpsfHigh, 203);
  assert.equal(s.medianLotSqft, 5000);
  assert.equal(s.usedAccts.length, 5);
});

test("summarizeLandValues falls back to all parcels and excludes bad lots", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const parcels = [
    parcel({ acct: "a", landValuePerSqft: 50, lotSizeSqft: 500 }),
    parcel({ acct: "b", landValuePerSqft: null, lotSizeSqft: 5000 }),
    parcel({ acct: "c", landValuePerSqft: 80, lotSizeSqft: 6000 }),
    parcel({ acct: "d", landValuePerSqft: 120, lotSizeSqft: 7000, vacant: true }),
    parcel({ acct: "e", landValuePerSqft: 200, lotSizeSqft: 50000 }),
    parcel({ acct: "f", landValuePerSqft: 90, lotSizeSqft: 4000, transferDate: "2026-05-01" }),
  ];
  const s = summarizeLandValues(parcels, { soldWithinMonths: 12, now });
  assert.equal(s.basis, "all-parcels"); // only 1 recent transfer
  assert.equal(s.n, 3); // c, d, f
  assert.equal(s.nRecentTransfers, 1);
  assert.equal(s.nVacant, 1);
  assert.equal(s.medianLandValuePerSqft, 90);
  assert.deepEqual(s.usedAccts.sort(), ["c", "d", "f"]);
});

test("summarizeLandValues soldWithinMonths null = no window", () => {
  const now = new Date("2026-09-01T00:00:00Z");
  const parcels = Array.from({ length: 6 }, (_, i) =>
    parcel({ acct: `P${i}`, landValuePerSqft: 100 + i, transferDate: i < 5 ? "2026-06-01" : "2010-01-01" })
  );
  const s = summarizeLandValues(parcels, { soldWithinMonths: null, now });
  assert.equal(s.basis, "all-parcels");
  assert.equal(s.n, 6);
  // no-limit still only counts parcels that have a transfer date
  assert.equal(s.nRecentTransfers, 6);
  parcels.push(parcel({ acct: "P6", landValuePerSqft: 90, transferDate: null }));
  const s2 = summarizeLandValues(parcels, { soldWithinMonths: null, now });
  assert.equal(s2.n, 7);
  assert.equal(s2.nRecentTransfers, 6);
});

test("summarizeLandValues n=0 when nothing eligible", () => {
  const s = summarizeLandValues([parcel({ landValuePerSqft: null }), parcel({ lotSizeSqft: 100 })], {});
  assert.equal(s.n, 0);
  assert.equal(s.nParcels, 2);
  assert.equal(s.medianLandValuePerSqft, null);
});
