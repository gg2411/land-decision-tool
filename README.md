# land-decision-tool
Houston land-buying decision tool: HAR MLS comps + land residual analysis

## Run locally

```
npm start        # http://localhost:3000
```

## Test

```
npm test
```

## Houston public-records fallback (HCAD)

The connected Repliers feed has little to no Houston coverage. When a live query returns zero MLS listings inside the drawn polygon, the app falls back to Harris County Appraisal District (HCAD) public parcel records: a land-value benchmark ($/sqft of land) plus parcel markers on the map, and an optional asking-price-vs-HCAD premium check when you enter a lot sqft. Because Texas is a non-disclosure state, HCAD values are appraisal-based, not recorded sale prices — and HCAD has no building sqft, so type an **ARV $/sqft override** (Comp filters section) to run the residual math without comps.

## Env vars

- `REPLIERS_API_KEY` (or `HAR_API_KEY`) — Repliers API key. Without it the app falls back to generated mock data.
- `REPLIERS_BOARD_ID` — optional Repliers board ID.
- `LDT_SKIP_HCAD` — set to disable the HCAD parcel lookup (used by the offline test suite).

## Deploy

Deployed on Vercel: `index.html` is served as a static asset and functions under `api/` (e.g. `api/analyze.js`) become serverless endpoints automatically.
