// core.js
// Land residual decision engine + HAR (Repliers API) client, ported from
// the original Python prototype. Kept dependency-free (uses the Node 18+
// global fetch) so it bundles cleanly as a single Vercel function.

// --------------------------------------------------------------------- //
// Point-in-polygon (ray casting) — no geo library needed
// --------------------------------------------------------------------- //
function pointInPolygon(lat, lon, polygon) {
  // polygon: array of [lat, lon] pairs
  let inside = false;
  const x = lon, y = lat;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    const intersects =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-15) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonBbox(polygon) {
  const lats = polygon.map((p) => p[0]);
  const lons = polygon.map((p) => p[1]);
  return {
    minLat: Math.min(...lats),
    minLon: Math.min(...lons),
    maxLat: Math.max(...lats),
    maxLon: Math.max(...lons),
  };
}

function filterToPolygon(listings, polygon) {
  return listings.filter(
    (l) =>
      l.latitude != null &&
      l.longitude != null &&
      pointInPolygon(l.latitude, l.longitude, polygon)
  );
}

// --------------------------------------------------------------------- //
// Comps stats
// --------------------------------------------------------------------- //
function median(sortedArr) {
  const n = sortedArr.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round(p * (sortedArr.length - 1))));
  return sortedArr[idx];
}

function summarizeComps(listings, { minSqft, maxSqft, minBeds, minYearBuilt, soldWithinMonths, now } = {}) {
  const cutoff = soldWithinMonths != null ? new Date((now || new Date()).getTime() - soldWithinMonths * 30.44 * 86400000) : null;
  const filtered = listings.filter((l) => {
    if (!l.price || !l.livingAreaSqft) return false;
    if (minSqft && l.livingAreaSqft < minSqft) return false;
    if (maxSqft && l.livingAreaSqft > maxSqft) return false;
    if (minBeds && (l.beds || 0) < minBeds) return false;
    if (minYearBuilt && typeof l.yearBuilt === "number" && l.yearBuilt < minYearBuilt) return false;
    if (cutoff && l.soldDate != null && new Date(l.soldDate) < cutoff) return false;
    return true;
  });

  if (!filtered.length) {
    return { n: 0, medianPrice: null, medianPricePerSqft: null, medianSqft: null, ppsfLow: null, ppsfHigh: null, usedKeys: [] };
  }

  const prices = filtered.map((l) => l.price).sort((a, b) => a - b);
  const ppsf = filtered
    .map((l) => l.price / l.livingAreaSqft)
    .sort((a, b) => a - b);
  const sqfts = filtered.map((l) => l.livingAreaSqft).sort((a, b) => a - b);

  return {
    n: filtered.length,
    medianPrice: median(prices),
    medianPricePerSqft: median(ppsf),
    medianSqft: median(sqfts),
    ppsfLow: percentile(ppsf, 0.25),
    ppsfHigh: percentile(ppsf, 0.75),
    usedKeys: filtered.map((l) => l.listingKey),
  };
}

// --------------------------------------------------------------------- //
// Land residual math
// --------------------------------------------------------------------- //
function computeMaxLandPrice(plan, comps, costs, arvPpsfOverride) {
  const ppsf = arvPpsfOverride || comps.medianPricePerSqft;
  if (!ppsf) {
    throw new Error("No comps price-per-sqft available — widen the polygon or comps filters.");
  }
  const arv = ppsf * plan.livingAreaSqft;
  const constructionCost = costs.constructionCostPerSqft * plan.livingAreaSqft;
  const sellingCost = arv * costs.sellingCostPct;
  const targetProfit = arv * costs.targetMarginPct;
  const maxLandPrice = arv - constructionCost - sellingCost - targetProfit - costs.siteDevCost;

  return {
    arv: round2(arv),
    constructionCost: round2(constructionCost),
    sellingCost: round2(sellingCost),
    targetProfit: round2(targetProfit),
    siteDevCost: costs.siteDevCost,
    maxLandPrice: round2(maxLandPrice),
    compsUsed: comps.n,
    ppsfUsed: ppsf,
  };
}

function impliedMargin(plan, comps, costs, landPrice, arvPpsfOverride) {
  const ppsf = arvPpsfOverride || comps.medianPricePerSqft;
  if (!ppsf) {
    throw new Error("No comps price-per-sqft available — widen the polygon or comps filters.");
  }
  const arv = ppsf * plan.livingAreaSqft;
  const constructionCost = costs.constructionCostPerSqft * plan.livingAreaSqft;
  const sellingCost = arv * costs.sellingCostPct;
  const profit = arv - constructionCost - sellingCost - costs.siteDevCost - landPrice;
  return {
    landPrice,
    profit: round2(profit),
    marginPct: round4(profit / arv),
    meetsTarget: profit / arv >= costs.targetMarginPct,
  };
}

function splitLotScenario(totalLotPrice, totalLotSqft, plan, comps, costs, nSplits = 2, arvPpsfOverride) {
  const perLotPrice = totalLotPrice / nSplits;
  const perLotSqft = totalLotSqft / nSplits;
  const result = computeMaxLandPrice(plan, comps, costs, arvPpsfOverride);
  return {
    nSplits,
    perLotPrice: round2(perLotPrice),
    perLotSqft,
    perLotPricePerSqft: perLotSqft > 0 ? round2(perLotPrice / perLotSqft) : null,
    impliedMarginPerLot: impliedMargin(plan, comps, costs, perLotPrice, arvPpsfOverride).marginPct,
    maxLandPricePerLot: result.maxLandPrice,
    profitable: perLotPrice <= result.maxLandPrice,
    marginVsMax: round2(result.maxLandPrice - perLotPrice),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// --------------------------------------------------------------------- //
// Mock data (used when no HAR_API_KEY is configured)
// --------------------------------------------------------------------- //
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mockDataset(polygon, basePpsf = 410, now = new Date()) {
  const rand = mulberry32(7);
  const bbox = polygonBbox(polygon);
  const latC = (bbox.minLat + bbox.maxLat) / 2;
  const lonC = (bbox.minLon + bbox.maxLon) / 2;
  const spreadLat = (bbox.maxLat - bbox.minLat) / 2 || 0.01;
  const spreadLon = (bbox.maxLon - bbox.minLon) / 2 || 0.01;

  const between = (a, b) => a + rand() * (b - a);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  function makeListing(i, status, basePpsfLocal) {
    const sqft = Math.round(between(1600, 3400));
    const ppsf = basePpsfLocal * between(0.85, 1.15);
    const price = Math.round((sqft * ppsf) / 1000) * 1000;
    const daysAgo = (d) => new Date(now.getTime() - d * 86400000).toISOString();
    return {
      listingKey: `MOCK${i}`,
      status,
      address: `${1000 + i * 7} Mock St`,
      soldDate: status === "Closed" ? daysAgo(between(0, 720)) : null,
      listDate: status !== "Closed" ? daysAgo(between(0, 90)) : null,
      listPrice: status !== "Closed" ? price : Math.round((price * between(0.97, 1.03)) / 1000) * 1000,
      closePrice: status === "Closed" ? price : null,
      price: status === "Closed" ? price : price,
      beds: pick([3, 3, 4, 4, 5]),
      baths: pick([2, 2.5, 3, 3.5]),
      livingAreaSqft: sqft,
      lotSizeSqft: Math.round(between(5000, 9000)),
      yearBuilt: pick([2022, 2023, 2024, 2025, 2026]),
      latitude: latC + between(-spreadLat, spreadLat) * 0.8,
      longitude: lonC + between(-spreadLon, spreadLon) * 0.8,
      city: "Houston",
    };
  }

  const sold = Array.from({ length: 40 }, (_, i) => makeListing(i, "Closed", basePpsf));
  const pending = Array.from({ length: 8 }, (_, i) => makeListing(100 + i, "Pending", basePpsf * 1.02));
  const active = Array.from({ length: 15 }, (_, i) => makeListing(200 + i, "Active", basePpsf * 1.05));
  return { sold, pending, active };
}

// --------------------------------------------------------------------- //
// Live HAR fetch (Repliers API — api.repliers.io)
// --------------------------------------------------------------------- //
// Repliers uses a REPLIERS-API-KEY header (not OAuth/Bearer), a POST body
// (not OData query params), and it natively supports polygon geo-filtering
// via a "map" field — so unlike the old Bridge/RESO integration we no longer
// need a bounding-box approximation; the exact drawn polygon is sent to the
// server and only matching listings come back.
const BASE_URL = "https://api.repliers.io";

// polygon: array of [lat, lon] pairs (our internal convention throughout
// this file). Repliers/GeoJSON wants [lon, lat] rings, closed (first point
// repeated at the end).
function polygonToRepliersMap(polygon) {
  const ring = polygon.map(([lat, lon]) => [lon, lat]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push(first);
  }
  return [ring];
}

async function fetchRepliersStatus(apiKey, standardStatus, polygon, { resultsPerPage = 200, maxPages = 5, boardId, minSoldDate } = {}) {
  // Repliers only accepts the polygon in the POST body; every other filter
  // must be a query parameter (body filters come back as unrecognizedParams).
  const map = polygonToRepliersMap(polygon);
  let listings = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      standardStatus,
      type: "Sale",
      resultsPerPage: String(resultsPerPage),
      pageNum: String(page),
    });
    if (boardId) params.set("boardId", String(boardId));
    if (standardStatus === "Closed" && minSoldDate) params.set("minSoldDate", minSoldDate);

    const resp = await fetch(`${BASE_URL}/listings?${params}`, {
      method: "POST",
      headers: {
        "REPLIERS-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ map }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Repliers API error ${resp.status} for standardStatus=${standardStatus}: ${errText.slice(0, 300)}`);
    }
    const payload = await resp.json();
    if (payload.unrecognizedParams?.length) {
      throw new Error(`Repliers rejected params: ${payload.unrecognizedParams.join(", ")}`);
    }
    const batch = (payload.listings || []).map(parseListing);
    listings = listings.concat(batch);
    if (batch.length === 0 || page >= (payload.numPages || 1)) break;
  }
  return listings;
}

function parseListing(rec) {
  const listPrice = rec.listPrice != null ? Number(rec.listPrice) : null;
  const closePrice = rec.soldPrice != null ? Number(rec.soldPrice) : null;
  const details = rec.details || {};
  const addr = rec.address || {};
  const geo = rec.map || {};
  const lot = rec.lot || {};
  const sqft = details.sqft ? parseFloat(details.sqft) : null;
  const price = closePrice || listPrice;
  return {
    listingKey: rec.mlsNumber || rec.listingKey,
    status: rec.standardStatus || rec.lastStatus || rec.status,
    listPrice,
    closePrice,
    price,
    beds: details.numBedrooms,
    baths: details.numBathrooms,
    livingAreaSqft: sqft,
    lotSizeSqft: lot.squareFeet || null,
    yearBuilt: /^\d{4}$/.test(String(details.yearBuilt ?? "").trim()) ? Number(details.yearBuilt) : details.yearBuilt || null,
    soldDate: rec.soldDate || null,
    listDate: rec.listDate || null,
    daysOnMarket: rec.daysOnMarket ?? null,
    pricePerSqft: sqft && price ? round2(price / sqft) : null,
    latitude: geo.latitude,
    longitude: geo.longitude,
    address: [addr.streetNumber, addr.streetDirectionPrefix, addr.streetName, addr.streetSuffix].filter(Boolean).join(" "),
    city: addr.city,
  };
}

// `dataset` is kept as a parameter for backward compatibility with callers
// but is unused by Repliers (no dataset concept); `boundsOrPolygon` is the
// actual drawn polygon ([lat, lon] pairs) — not a bbox — now that Repliers
// can filter on it directly.
async function fetchAllStatuses(apiKey, dataset, boundsOrPolygon, opts) {
  const [sold, pending, active] = await Promise.all([
    fetchRepliersStatus(apiKey, "Closed", boundsOrPolygon, opts),
    fetchRepliersStatus(apiKey, "Pending", boundsOrPolygon, opts),
    fetchRepliersStatus(apiKey, "Active", boundsOrPolygon, opts),
  ]);
  return { sold, pending, active };
}

module.exports = {
  pointInPolygon,
  polygonBbox,
  filterToPolygon,
  median,
  percentile,
  summarizeComps,
  computeMaxLandPrice,
  impliedMargin,
  splitLotScenario,
  mockDataset,
  fetchAllStatuses,
};
