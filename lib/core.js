// core.js
// Land residual decision engine + HAR (Bridge Interactive RESO Web API) client,
// ported from the original Python prototype. Kept dependency-free (uses the
// Node 18+ global fetch) so it bundles cleanly as a single Vercel function.

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

function summarizeComps(listings, { minSqft, maxSqft, minBeds } = {}) {
  const filtered = listings.filter((l) => {
    if (!l.price || !l.livingAreaSqft) return false;
    if (minSqft && l.livingAreaSqft < minSqft) return false;
    if (maxSqft && l.livingAreaSqft > maxSqft) return false;
    if (minBeds && (l.beds || 0) < minBeds) return false;
    return true;
  });

  if (!filtered.length) {
    return { n: 0, medianPrice: null, medianPricePerSqft: null, medianSqft: null, ppsfLow: null, ppsfHigh: null };
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

function splitLotScenario(totalLotPrice, totalLotSqft, plan, comps, costs, nSplits = 2) {
  const perLotPrice = totalLotPrice / nSplits;
  const perLotSqft = totalLotSqft / nSplits;
  const result = computeMaxLandPrice(plan, comps, costs);
  return {
    nSplits,
    perLotPrice: round2(perLotPrice),
    perLotSqft,
    maxLandPricePerLot: result.maxLandPrice,
    profitable: perLotPrice <= result.maxLandPrice,
    marginVsMax: round2(result.maxLandPrice - perLotPrice),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
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

function mockDataset(polygon, basePpsf = 410) {
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
    return {
      listingKey: `MOCK${i}`,
      status,
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
// Live HAR fetch (Bridge Interactive RESO Web API)
// --------------------------------------------------------------------- //
const BASE_URL = "https://api.bridgedataoutput.com/api/v2/OData";

async function fetchHarStatus(apiKey, dataset, status, bbox, { top = 200, maxPages = 5, propertyType = "Residential" } = {}) {
  const filters = [
    `StandardStatus eq '${status}'`,
    `PropertyType eq '${propertyType}'`,
    `Latitude ge ${bbox.minLat}`,
    `Latitude le ${bbox.maxLat}`,
    `Longitude ge ${bbox.minLon}`,
    `Longitude le ${bbox.maxLon}`,
  ];
  if (status === "Closed") {
    const cutoff = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
    filters.push(`CloseDate ge ${cutoff}`);
  }
  const selectFields =
    "ListingKey,StandardStatus,ListPrice,ClosePrice,CloseDate,BedroomsTotal,BathroomsTotalInteger," +
    "LivingArea,LotSizeSquareFeet,YearBuilt,Latitude,Longitude,UnparsedAddress,City";

  let listings = [];
  let skip = 0;
  for (let page = 0; page < maxPages; page++) {
    const baseParams = {
      $filter: filters.join(" and "),
      $select: selectFields,
      $top: String(top),
      $skip: String(skip),
    };
    const payload = await fetchWithAuthFallback(dataset, apiKey, baseParams, status);
    const batch = payload.value || [];
    listings = listings.concat(batch.map(parseListing));
    if (batch.length < top) break;
    skip += top;
  }
  return listings;
}

// Bridge Interactive's RESO Web API primarily expects the key as a Bearer
// token in the Authorization header. Some legacy/sandbox datasets instead
// expect `?access_token=` in the query string, and Bearer auth against those
// fails with 403 "Invalid access_token format". Try header auth first, and
// fall back to the query-param form on that specific error so this works
// against either dataset shape without needing to know which one in advance.
async function fetchWithAuthFallback(dataset, apiKey, baseParams, status) {
  const headerUrl = `${BASE_URL}/${dataset}/Property?${new URLSearchParams(baseParams).toString()}`;
  const headerResp = await fetch(headerUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (headerResp.ok) return headerResp.json();

  const headerErrText = await headerResp.text();
  const looksLikeTokenFormatIssue = headerResp.status === 403 && /access_token/i.test(headerErrText);

  if (!looksLikeTokenFormatIssue) {
    throw new Error(`HAR API error ${headerResp.status} for status=${status}: ${headerErrText.slice(0, 300)}`);
  }

  // Fall back: same request, key as a query param instead of a header.
  const fallbackParams = { ...baseParams, access_token: apiKey };
  const fallbackUrl = `${BASE_URL}/${dataset}/Property?${new URLSearchParams(fallbackParams).toString()}`;
  const fallbackResp = await fetch(fallbackUrl);
  if (!fallbackResp.ok) {
    const fallbackErrText = await fallbackResp.text();
    throw new Error(
      `HAR API error ${fallbackResp.status} for status=${status} (tried both Bearer header and access_token query param): ${fallbackErrText.slice(0, 300)}`
    );
  }
  return fallbackResp.json();
}

function parseListing(rec) {
  const closePrice = rec.ClosePrice || null;
  const listPrice = rec.ListPrice || null;
  return {
    listingKey: rec.ListingKey,
    status: rec.StandardStatus,
    listPrice,
    closePrice,
    price: closePrice || listPrice,
    beds: rec.BedroomsTotal,
    baths: rec.BathroomsTotalInteger,
    livingAreaSqft: rec.LivingArea,
    lotSizeSqft: rec.LotSizeSquareFeet,
    yearBuilt: rec.YearBuilt,
    latitude: rec.Latitude,
    longitude: rec.Longitude,
    address: rec.UnparsedAddress,
    city: rec.City,
  };
}

async function fetchAllStatuses(apiKey, dataset, bbox, opts) {
  const [sold, pending, active] = await Promise.all([
    fetchHarStatus(apiKey, dataset, "Closed", bbox, opts),
    fetchHarStatus(apiKey, dataset, "Pending", bbox, opts),
    fetchHarStatus(apiKey, dataset, "Active", bbox, opts),
  ]);
  return { sold, pending, active };
}

module.exports = {
  pointInPolygon,
  polygonBbox,
  filterToPolygon,
  summarizeComps,
  computeMaxLandPrice,
  splitLotScenario,
  mockDataset,
  fetchAllStatuses,
};
