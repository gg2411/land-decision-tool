// proforma.js
// Build-to-sell (spec home) project economics: lot + construction + soft
// costs + carry, against a comp-derived sale price.
//
// The land-residual engine in core.js answers "what can I pay for dirt".
// This answers the other half: "given this lot price and this floor plan,
// do I make money, and how much".

const DEFAULT_COSTS = {
  hardCostPerSqft: 140, // builder contract, $/sf of finished area
  contingencyPct: 0.07, // of hard cost
  softCostPct: 0.12, // architecture + engineering + design, of hard cost
  cityFees: 15000, // permits, survey, utility taps, site dev
  buildersRisk: 6000, // insurance for the build period
  months: 14, // lot purchase -> closing the sale
  loanRatePct: 0.085, // construction loan
  loanToCostPct: 0.75, // share of total cost financed
  propertyTaxPct: 0.0221, // Harris County combined, annual, on land value
  sellingCostPct: 0.07, // commission + seller closing costs
  targetMarginPct: 0.15, // profit / everything spent, selling costs included
};

// A construction loan draws down over the build, so the average outstanding
// balance is well below the committed amount. 55% is the conventional
// approximation used for spec underwriting.
const AVG_DRAW_FACTOR = 0.55;

function withDefaults(costs = {}) {
  const c = { ...DEFAULT_COSTS };
  for (const [k, v] of Object.entries(costs)) {
    if (v != null && !Number.isNaN(Number(v))) c[k] = Number(v);
  }
  return c;
}

// Total cost is linear in the lot price, which lets every question below
// (profit, break-even, max lot price) be answered in closed form:
//
//   base       = lot * (1 + taxRate*years) + fixed
//   interest   = base * ltc * drawFactor * rate * years   =  base * f
//   totalCost  = base * (1 + f)
function costFactors(sqft, costs) {
  const c = withDefaults(costs);
  const years = c.months / 12;
  const hard = sqft * c.hardCostPerSqft;
  const contingency = hard * c.contingencyPct;
  const soft = hard * c.softCostPct;
  const fixed = hard + contingency + soft + c.cityFees + c.buildersRisk;
  const lotMultiple = 1 + c.propertyTaxPct * years;
  const f = c.loanToCostPct * AVG_DRAW_FACTOR * c.loanRatePct * years;
  return { c, years, hard, contingency, soft, fixed, lotMultiple, f };
}

function specProForma({ salePrice, sqft, lotPrice, costs = {} }) {
  const { c, years, hard, contingency, soft, fixed, lotMultiple, f } = costFactors(sqft, costs);

  const propertyTax = lotPrice * c.propertyTaxPct * years;
  const base = lotPrice * lotMultiple + fixed;
  const interest = base * f;
  const totalCost = base + interest;
  const sellingCost = salePrice * c.sellingCostPct;
  const profit = salePrice - totalCost - sellingCost;
  // Commission and closing are money spent on the project like any other cost,
  // so the margin is measured against them too.
  const allInCost = totalCost + sellingCost;
  const marginPct = allInCost > 0 ? profit / allInCost : 0;

  return {
    salePrice: r2(salePrice),
    sqft,
    lineItems: {
      lot: r2(lotPrice),
      hardCost: r2(hard),
      contingency: r2(contingency),
      softCost: r2(soft),
      cityFees: c.cityFees,
      buildersRisk: c.buildersRisk,
      propertyTax: r2(propertyTax),
      loanInterest: r2(interest),
    },
    totalCost: r2(totalCost),
    sellingCost: r2(sellingCost),
    allInCost: r2(allInCost),
    profit: r2(profit),
    marginPct: r4(marginPct),
    allInCostPerSqft: sqft > 0 ? r2(allInCost / sqft) : null,
    salePricePerSqft: sqft > 0 ? r2(salePrice / sqft) : null,
    lotShareOfSalePct: salePrice > 0 ? r4(lotPrice / salePrice) : null,
    monthsToExit: c.months,
    verdict: verdictFor(marginPct, c.targetMarginPct, profit),
  };
}

// A lot price is quoted in whole dollars, so maxLotPrice lands a hair under the
// target; a 0.0001 percentage point tolerance keeps that from reading as a miss.
const MARGIN_EPS = 1e-6;

function verdictFor(marginPct, targetMarginPct, profit) {
  if (marginPct >= targetMarginPct - MARGIN_EPS) return "go";
  if (profit > 0) return "thin";
  return "no";
}

// Highest lot price that still hits the target margin, given this sale price.
function maxLotPrice({ salePrice, sqft, costs = {} }) {
  const { c, fixed, lotMultiple, f } = costFactors(sqft, costs);
  // profit = targetMargin * (totalCost + sale*sell)  and  profit = sale*(1-sell) - totalCost
  const totalCost =
    (salePrice * (1 - c.sellingCostPct - c.targetMarginPct * c.sellingCostPct)) /
    (1 + c.targetMarginPct);
  const base = totalCost / (1 + f);
  return r2((base - fixed) / lotMultiple);
}

// Sale price at which profit is exactly zero.
function breakEvenSalePrice({ sqft, lotPrice, costs = {} }) {
  const { c, fixed, lotMultiple, f } = costFactors(sqft, costs);
  const totalCost = (lotPrice * lotMultiple + fixed) * (1 + f);
  return r2(totalCost / (1 - c.sellingCostPct));
}

// One call, everything the UI needs: the deal as underwritten, the two
// levers (lot price / sale price) and a comps-based sanity check.
function evaluateDeal({ salePrice, sqft, lotPrice, costs = {}, comps = null }) {
  const deal = specProForma({ salePrice, sqft, lotPrice, costs });
  const out = {
    ...deal,
    maxLotPrice: maxLotPrice({ salePrice, sqft, costs }),
    breakEvenSalePrice: breakEvenSalePrice({ sqft, lotPrice, costs }),
    compSupport: null,
    warnings: [],
  };
  out.lotOverpayBy = r2(lotPrice - out.maxLotPrice);

  if (comps && comps.medianPricePerSqft) {
    const low = (comps.ppsfLow || comps.medianPricePerSqft) * sqft;
    const high = (comps.ppsfHigh || comps.medianPricePerSqft) * sqft;
    out.compSupport = {
      n: comps.n,
      ppsfLow: r2(comps.ppsfLow),
      ppsfMedian: r2(comps.medianPricePerSqft),
      ppsfHigh: r2(comps.ppsfHigh),
      valueLow: r2(low),
      valueMedian: r2(comps.medianPricePerSqft * sqft),
      valueHigh: r2(high),
      sqftNeededForSalePrice: comps.medianPricePerSqft
        ? Math.round(salePrice / comps.medianPricePerSqft)
        : null,
    };
    if (salePrice > high * 1.02) {
      out.warnings.push(
        `Your ${money(salePrice)} price is ${money(deal.salePricePerSqft)}/sf. Sold comps here top out near ` +
          `${money(comps.ppsfHigh)}/sf, which supports about ${money(high)} for ${sqft.toLocaleString()} sf — expect appraisal trouble.`
      );
    }
  }

  const c = withDefaults(costs);
  if (c.hardCostPerSqft < 150) {
    out.warnings.push(
      `${money(c.hardCostPerSqft)}/sf is below the $150–$350/sf Houston builders quote for 2026 custom work. ` +
        `It only holds with a repeatable plan and volume pricing — get it in a signed contract before you close on the lot.`
    );
  }
  if (out.lotShareOfSalePct > 0.33) {
    out.warnings.push(
      `The lot is ${Math.round(out.lotShareOfSalePct * 100)}% of the sale price; spec builders normally keep land at 20–33%.`
    );
  }
  return out;
}

function money(n) {
  return "$" + Math.round(Number(n) || 0).toLocaleString();
}
function r2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function r4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

module.exports = {
  DEFAULT_COSTS,
  specProForma,
  maxLotPrice,
  breakEvenSalePrice,
  evaluateDeal,
};
