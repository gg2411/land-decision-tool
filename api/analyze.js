const {
  filterToPolygon,
  summarizeComps,
  computeMaxLandPrice,
  impliedMargin,
  splitLotScenario,
  mockDataset,
  fetchAllStatuses,
} = require("../lib/core");

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
    const soldWithinMonths = rawSoldMonths ? Number(rawSoldMonths) : undefined; // 0/blank = no limit
    const compsFilter = {
      minSqft: cf.minSqft ?? plan.livingAreaSqft * 0.8,
      maxSqft: cf.maxSqft ?? plan.livingAreaSqft * 1.2,
      minBeds: cf.minBeds ?? 3,
      minYearBuilt: cf.minYearBuilt ? Number(cf.minYearBuilt) : undefined,
      soldWithinMonths,
    };
    const splitScenario = body.splitScenario; // optional { totalLotPrice, totalLotSqft, nSplits }
    const lotAskingPrice = Number(body.lotAskingPrice) > 0 ? Number(body.lotAskingPrice) : null;

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

    const comps = summarizeComps(soldInPoly, compsFilter);

    let result = null;
    let sensitivity = null;
    let error = null;
    if (comps.n > 0 && comps.medianPricePerSqft) {
      result = computeMaxLandPrice(plan, comps, costs);
      sensitivity = {
        conservative: computeMaxLandPrice(plan, comps, costs, comps.ppsfLow),
        optimistic: computeMaxLandPrice(plan, comps, costs, comps.ppsfHigh),
      };
    } else {
      error = "No comps matched the filters inside this polygon — widen the polygon or the size/bed filters.";
    }

    let asking = null;
    if (lotAskingPrice && result) {
      asking = impliedMargin(plan, comps, costs, lotAskingPrice);
    }

    let split = null;
    if (splitScenario && result) {
      split = splitLotScenario(
        Number(splitScenario.totalLotPrice),
        Number(splitScenario.totalLotSqft),
        plan,
        comps,
        costs,
        Number(splitScenario.nSplits || 2)
      );
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
