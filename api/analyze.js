const {
  filterToPolygon,
  polygonBbox,
  summarizeComps,
  computeMaxLandPrice,
  impliedMargin,
  splitLotScenario,
  mockDataset,
  fetchAllStatuses,
} = require("../lib/core");
const { fetchHcadParcels, summarizeLandValues } = require("../lib/hcad");

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
// Rough bounding box of Harris County, TX — the only area HCAD covers.
const HARRIS_BBOX = { minLat: 29.45, maxLat: 30.2, minLon: -95.98, maxLon: -94.9 };
function withinHarris(polygon) {
  const b = polygonBbox(polygon);
  return (
    b.minLat >= HARRIS_BBOX.minLat &&
    b.maxLat <= HARRIS_BBOX.maxLat &&
    b.minLon >= HARRIS_BBOX.minLon &&
    b.maxLon <= HARRIS_BBOX.maxLon
  );
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  try {
    const body = req.body || {};
    const polygon = body.polygon; // array of [lat, lon]
    const plan = {
      livingAreaSqft: Number(body.plan?.livingAreaSqft ?? 2400),
      beds: Number(body.plan?.beds ?? 4),
      baths: Number(body.plan?.baths ?? 3),
    };
    const costs = {
      constructionCostPerSqft: Number(body.costs?.constructionCostPerSqft ?? 185),
      sellingCostPct: Number(body.costs?.sellingCostPct ?? 0.07),
      targetMarginPct: Number(body.costs?.targetMarginPct ?? 0.15),
      siteDevCost: Number(body.costs?.siteDevCost ?? 35000),
    };
    const cf = body.compsFilter || {};
    const rawSoldMonths = cf.soldWithinMonths ?? 12;
    const soldWithinMonths = rawSoldMonths ? Number(rawSoldMonths) : null; // explicit 0/blank = no limit
    const compsFilter = {
      minSqft: cf.minSqft ?? plan.livingAreaSqft * 0.8,
      maxSqft: cf.maxSqft ?? plan.livingAreaSqft * 1.2,
      minBeds: cf.minBeds ?? 3,
      minYearBuilt: cf.minYearBuilt ? Number(cf.minYearBuilt) : undefined,
      soldWithinMonths,
    };
    const splitScenario = body.splitScenario; // optional { totalLotPrice, totalLotSqft, nSplits }
    const lotAskingPrice = Number(body.lotAskingPrice) > 0 ? Number(body.lotAskingPrice) : null;
    const arvPpsfOverride = Number(body.arvPpsf) > 0 ? Number(body.arvPpsf) : null;
    const lotSqft = Number(body.lotSqft) > 0 ? Number(body.lotSqft) : null;

    if (!polygon || !Array.isArray(polygon) || polygon.length < 3) {
      res.status(400).json({ error: "polygon must be an array of at least 3 [lat, lon] pairs" });
      return;
    }

    const apiKey = process.env.REPLIERS_API_KEY || process.env.HAR_API_KEY;
    const boardId = process.env.REPLIERS_BOARD_ID;
    let dataSource = "mock";
    let data;

    if (apiKey) {
      dataSource = "live";
      // Repliers supports polygon filtering natively, so we pass the exact
      // drawn polygon (not a bounding box) straight through.
      const minSoldDate = soldWithinMonths
        ? new Date(Date.now() - soldWithinMonths * 30.44 * 86400000).toISOString().slice(0, 10)
        : undefined;
      data = await fetchAllStatuses(apiKey, null, polygon, {
        resultsPerPage: 200,
        maxPages: 5,
        boardId,
        minSoldDate,
      });
    } else {
      data = mockDataset(polygon);
    }

    const soldInPoly = filterToPolygon(data.sold, polygon);
    const pendingInPoly = filterToPolygon(data.pending, polygon);
    const activeInPoly = filterToPolygon(data.active, polygon);

    // The connected Repliers feed has multi-state sample coverage with almost
    // no Houston listings; when it comes back empty we try HCAD public
    // records (land-value benchmark) as the real data source.
    const liveEmpty =
      dataSource === "live" && !soldInPoly.length && !pendingInPoly.length && !activeInPoly.length;

    const comps = summarizeComps(soldInPoly, compsFilter);
    const ppsfOverride = arvPpsfOverride || undefined;

    let result = null;
    let sensitivity = null;
    if (comps.n > 0 || ppsfOverride) {
      result = computeMaxLandPrice(plan, comps, costs, ppsfOverride);
      sensitivity = ppsfOverride
        ? {
            conservative: computeMaxLandPrice(plan, comps, costs, ppsfOverride * 0.9),
            optimistic: computeMaxLandPrice(plan, comps, costs, ppsfOverride * 1.1),
          }
        : {
            conservative: computeMaxLandPrice(plan, comps, costs, comps.ppsfLow),
            optimistic: computeMaxLandPrice(plan, comps, costs, comps.ppsfHigh),
          };
    }

    let asking = null;
    if (lotAskingPrice && result) {
      asking = impliedMargin(plan, comps, costs, lotAskingPrice, ppsfOverride);
    }

    let split = null;
    if (splitScenario && result) {
      split = splitLotScenario(
        Number(splitScenario.totalLotPrice),
        Number(splitScenario.totalLotSqft),
        plan,
        comps,
        costs,
        Number(splitScenario.nSplits || 2),
        ppsfOverride
      );
    }

    let hcad = null;
    let hcadPoints = [];
    if (!process.env.LDT_SKIP_HCAD && withinHarris(polygon)) {
      try {
        const { parcels, truncated } = await fetchHcadParcels(polygon);
        const summary = summarizeLandValues(parcels, { soldWithinMonths });
        hcad = { ...summary, truncated };
        if (lotAskingPrice && lotSqft && summary.medianLandValuePerSqft) {
          hcad.asking = {
            askingPerSqft: round2(lotAskingPrice / lotSqft),
            hcadLandValue: Math.round(summary.medianLandValuePerSqft * lotSqft),
            premiumPct: round4(lotAskingPrice / (summary.medianLandValuePerSqft * lotSqft) - 1),
          };
        }
        const recent = parcels.filter((p) => summary.usedAccts.includes(p.acct) && p.transferDate);
        const pointsSource = recent.length ? recent : parcels.filter((p) => p.vacant);
        hcadPoints = pointsSource.slice(0, 400).map((p) => ({
          lat: p.latitude,
          lon: p.longitude,
          acct: p.acct,
          address: p.address,
          neighborhood: p.neighborhood,
          vacant: p.vacant,
          landValue: p.landValue,
          marketValue: p.marketValue,
          lotSqft: p.lotSizeSqft,
          landPpsf: p.landValuePerSqft,
          transferDate: p.transferDate,
        }));
      } catch (err) {
        hcad = { error: String(err.message || err) };
      }
    }

    if (liveEmpty) dataSource = hcad && !hcad.error ? "hcad" : "live-empty";
    let error = null;
    if (!result) {
      error =
        dataSource === "hcad"
          ? "No MLS listings in this polygon from the connected Repliers feed. Showing HCAD public records instead — enter an ARV $/sqft override to run the residual."
          : dataSource === "live-empty"
            ? "No MLS listings in this polygon from the connected Repliers feed (and no HCAD coverage here)."
            : "No comps matched the filters inside this polygon — widen the polygon or the size/bed filters.";
    }

    const usedSet = new Set(comps.usedKeys || []);
    const toPoint = (l, status) => ({
      lat: l.latitude,
      lon: l.longitude,
      price: l.price,
      sqft: l.livingAreaSqft,
      ppsf: l.livingAreaSqft ? Math.round(l.price / l.livingAreaSqft) : null,
      beds: l.beds,
      baths: l.baths,
      yearBuilt: l.yearBuilt,
      address: l.address,
      status,
      soldDate: l.soldDate,
      listDate: l.listDate,
      listingKey: l.listingKey,
      used: status === "sold" && usedSet.has(l.listingKey),
    });

    res.status(200).json({
      dataSource,
      counts: { sold: soldInPoly.length, pending: pendingInPoly.length, active: activeInPoly.length },
      comps,
      result,
      sensitivity,
      asking,
      split,
      hcad,
      hcadPoints,
      arvSource: ppsfOverride ? "override" : "comps",
      error,
      compsPoints: [
        ...soldInPoly.map((l) => toPoint(l, "sold")),
        ...pendingInPoly.map((l) => toPoint(l, "pending")),
        ...activeInPoly.map((l) => toPoint(l, "active")),
      ],
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
