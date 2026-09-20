const {
  filterToPolygon,
  summarizeComps,
  computeMaxLandPrice,
  splitLotScenario,
  mockDataset,
  fetchAllStatuses,
} = require("../lib/core");
const { evaluateDeal, DEFAULT_COSTS } = require("../lib/proforma");

// Percentages arrive as fractions; anything outside these bands is a typo or a
// broken client, and a pro forma built on it would look authoritative while
// being meaningless.
const PCT_RANGE = {
  sellingCostPct: [0, 0.5],
  targetMarginPct: [0, 1],
  softCostPct: [0, 1],
  contingencyPct: [0, 1],
  loanRatePct: [0, 0.5],
  loanToCostPct: [0, 1],
  propertyTaxPct: [0, 0.2],
};

function validationError({ plan, costs, specCosts, lotPrice, salePrice }) {
  if (!Number.isFinite(plan.livingAreaSqft) || plan.livingAreaSqft <= 0) {
    return "Enter the size of the house in square feet.";
  }
  if (lotPrice != null && (!Number.isFinite(lotPrice) || lotPrice <= 0)) {
    return "Enter what the lot costs.";
  }
  if (salePrice != null && (!Number.isFinite(salePrice) || salePrice <= 0)) {
    return "Enter a sale price above zero, or leave it blank to use the comps.";
  }
  if (!Number.isFinite(costs.constructionCostPerSqft) || costs.constructionCostPerSqft <= 0) {
    return "Enter a build cost per square foot above zero.";
  }
  for (const key of ["cityFees", "buildersRisk", "months"]) {
    if (!Number.isFinite(specCosts[key]) || specCosts[key] < 0) {
      return `${key} must be zero or more.`;
    }
  }
  for (const [key, [lo, hi]] of Object.entries(PCT_RANGE)) {
    const v = specCosts[key];
    if (!Number.isFinite(v) || v < lo || v > hi) {
      return `${key} must be between ${lo * 100}% and ${hi * 100}%.`;
    }
  }
  return null;
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
      // Only an absent key falls back to the default; an explicit null or blank
      // means the caller cleared a required field and must be told so.
      livingAreaSqft: "livingAreaSqft" in (body.plan || {}) ? Number(body.plan.livingAreaSqft) : 2400,
      beds: Number(body.plan?.beds ?? 4),
      baths: Number(body.plan?.baths ?? 3),
    };
    const costs = {
      constructionCostPerSqft: Number(body.costs?.constructionCostPerSqft ?? DEFAULT_COSTS.hardCostPerSqft),
      sellingCostPct: Number(body.costs?.sellingCostPct ?? DEFAULT_COSTS.sellingCostPct),
      targetMarginPct: Number(body.costs?.targetMarginPct ?? DEFAULT_COSTS.targetMarginPct),
      siteDevCost: Number(body.costs?.siteDevCost ?? 35000),
    };
    // Full build-to-sell economics (soft costs, carry, financing, selling).
    const specCosts = {
      ...DEFAULT_COSTS,
      ...(body.specCosts || {}),
      hardCostPerSqft: costs.constructionCostPerSqft,
      sellingCostPct: costs.sellingCostPct,
      targetMarginPct: costs.targetMarginPct,
    };
    const lotPrice = body.lotPrice != null ? Number(body.lotPrice) : null;
    const salePrice = body.salePrice != null ? Number(body.salePrice) : null;
    const compsFilter = {
      minSqft: body.compsFilter?.minSqft ?? plan.livingAreaSqft * 0.8,
      maxSqft: body.compsFilter?.maxSqft ?? plan.livingAreaSqft * 1.2,
      minBeds: body.compsFilter?.minBeds ?? 3,
    };
    const splitScenario = body.splitScenario; // optional { totalLotPrice, totalLotSqft, nSplits }

    if (!polygon || !Array.isArray(polygon) || polygon.length < 3) {
      res.status(400).json({ error: "polygon must be an array of at least 3 [lat, lon] pairs" });
      return;
    }

    const invalid = validationError({ plan, costs, specCosts, lotPrice, salePrice });
    if (invalid) {
      res.status(400).json({ error: invalid });
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
      data = await fetchAllStatuses(apiKey, null, polygon, {
        resultsPerPage: 200,
        maxPages: 5,
        boardId,
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

    // Build-to-sell verdict. Falls back to the comp median value of the plan
    // when the user has not typed a target sale price.
    let deal = null;
    if (lotPrice != null && plan.livingAreaSqft > 0) {
      const compSale = comps.medianPricePerSqft ? comps.medianPricePerSqft * plan.livingAreaSqft : null;
      const effectiveSale = salePrice || compSale;
      if (effectiveSale) {
        deal = evaluateDeal({
          salePrice: effectiveSale,
          sqft: plan.livingAreaSqft,
          lotPrice,
          costs: specCosts,
          comps: comps.n > 0 ? comps : null,
        });
        deal.salePriceSource = salePrice ? "user" : "comps";
      }
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

    res.status(200).json({
      dataSource,
      counts: { sold: soldInPoly.length, pending: pendingInPoly.length, active: activeInPoly.length },
      comps,
      result,
      deal,
      sensitivity,
      split,
      error,
      compsPoints: soldInPoly.map((l) => ({
        lat: l.latitude,
        lon: l.longitude,
        price: l.price,
        sqft: l.livingAreaSqft,
        ppsf: l.livingAreaSqft ? Math.round(l.price / l.livingAreaSqft) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
