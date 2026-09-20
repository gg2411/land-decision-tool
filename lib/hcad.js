// hcad.js
// Harris County Appraisal District public parcel records, queried through the
// county's ArcGIS MapServer. HCAD exposes land/building/market values, lot
// square footage and the last ownership-transfer date — but no building sqft,
// so it produces a land-value benchmark ($/sqft of land) rather than house
// comps. Texas is a non-disclosure state: these are appraisal values, not
// recorded sale prices. Dependency-free (Node 18+ global fetch).

const { pointInPolygon, median, percentile } = require("./core");

const BASE_URL = "https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0/query";
const OUT_FIELDS = [
  "HCAD_NUM",
  "site_str_num",
  "site_str_pfx",
  "site_str_name",
  "site_str_sfx",
  "site_zip",
  "state_class",
  "land_value",
  "bld_value",
  "total_market_val",
  "land_sqft",
  "new_owner_date",
  "dscr",
].join(",");

// polygon: [[lat, lon], ...] → closed Esri ring of [lon, lat] pairs
function polygonToEsriRings(polygon) {
  const ring = polygon.map(([lat, lon]) => [lon, lat]);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return [ring];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseHcadFeature(feature) {
  const a = feature.attributes || {};
  const ring = (feature.geometry && feature.geometry.rings && feature.geometry.rings[0]) || [];
  let lat = null;
  let lon = null;
  if (ring.length) {
    // mean of the first ring's vertices ([lon, lat] pairs) as a cheap centroid
    lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  }
  const landValue = a.land_value != null ? Number(a.land_value) : null;
  const lotSizeSqft = a.land_sqft ? Number(a.land_sqft) : null;
  return {
    acct: a.HCAD_NUM,
    address: [a.site_str_num, a.site_str_pfx, a.site_str_name, a.site_str_sfx].filter(Boolean).join(" "),
    zip: a.site_zip,
    neighborhood: a.dscr,
    stateClass: a.state_class,
    vacant: a.state_class === "C1",
    landValue,
    bldValue: a.bld_value != null ? Number(a.bld_value) : null,
    marketValue: a.total_market_val != null ? Number(a.total_market_val) : null,
    lotSizeSqft,
    landValuePerSqft: landValue > 0 && lotSizeSqft > 0 ? round2(landValue / lotSizeSqft) : null,
    transferDate: a.new_owner_date ? new Date(a.new_owner_date).toISOString().slice(0, 10) : null,
    latitude: lat,
    longitude: lon,
  };
}

async function fetchHcadParcels(polygon, { maxPages = 10, pageSize = 1000, timeoutMs = 20000 } = {}) {
  const geometry = JSON.stringify({
    rings: polygonToEsriRings(polygon),
    spatialReference: { wkid: 4326 },
  });
  const where = "state_class IN ('A1','C1')";
  let parcels = [];
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      geometry,
      geometryType: "esriGeometryPolygon",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      where,
      outFields: OUT_FIELDS,
      returnGeometry: "true",
      resultOffset: String(page * pageSize),
      resultRecordCount: String(pageSize),
      f: "json",
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(`${BASE_URL}?${params}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error(`HCAD query failed ${resp.status}`);
    const payload = await resp.json();
    if (payload.error) throw new Error(`HCAD query failed ${payload.error.code || ""} ${payload.error.message || ""}`.trim());
    parcels = parcels.concat((payload.features || []).map(parseHcadFeature));
    if (!payload.exceededTransferLimit) break;
  }
  // ArcGIS "intersects" includes parcels that merely touch the polygon edge;
  // keep only parcels whose centroid is actually inside.
  return {
    parcels: parcels.filter(
      (p) => p.latitude != null && p.longitude != null && pointInPolygon(p.latitude, p.longitude, polygon)
    ),
    truncated: parcels.length >= maxPages * pageSize,
  };
}

function summarizeLandValues(parcels, { soldWithinMonths, now } = {}) {
  const eligible = parcels.filter(
    (p) => p.landValuePerSqft > 0 && p.lotSizeSqft >= 1000 && p.lotSizeSqft <= 43560
  );
  const empty = {
    n: 0,
    nRecentTransfers: 0,
    nParcels: parcels.length,
    nVacant: parcels.filter((p) => p.vacant).length,
    basis: null,
    medianLandValuePerSqft: null,
    landPpsfLow: null,
    landPpsfHigh: null,
    medianLotSqft: null,
    usedAccts: [],
  };
  if (!eligible.length) return empty;

  const recent =
    soldWithinMonths === null
      ? eligible // explicit no-limit: no recency window
      : eligible.filter(
          (p) =>
            p.transferDate &&
            new Date(p.transferDate) >=
              new Date((now || new Date()).getTime() - (soldWithinMonths || 24) * 30.44 * 86400000)
        );

  const useRecent = soldWithinMonths !== null && recent.length >= 5;
  const used = useRecent ? recent : eligible;
  const basis = useRecent ? "recent-transfers" : "all-parcels";
  const ppsfs = used.map((p) => p.landValuePerSqft).sort((a, b) => a - b);
  const lotSqfts = used.map((p) => p.lotSizeSqft).sort((a, b) => a - b);
  return {
    n: used.length,
    nRecentTransfers: recent.length,
    nParcels: parcels.length,
    nVacant: parcels.filter((p) => p.vacant).length,
    basis,
    medianLandValuePerSqft: median(ppsfs),
    landPpsfLow: percentile(ppsfs, 0.25),
    landPpsfHigh: percentile(ppsfs, 0.75),
    medianLotSqft: median(lotSqfts),
    usedAccts: used.map((p) => p.acct),
  };
}

module.exports = {
  polygonToEsriRings,
  parseHcadFeature,
  fetchHcadParcels,
  summarizeLandValues,
};
