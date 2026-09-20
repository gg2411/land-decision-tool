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

## Env vars

- `REPLIERS_API_KEY` (or `HAR_API_KEY`) — Repliers API key. Without it the app falls back to generated mock data.
- `REPLIERS_BOARD_ID` — optional Repliers board ID.

## Deploy

Deployed on Vercel: `index.html` is served as a static asset and functions under `api/` (e.g. `api/analyze.js`) become serverless endpoints automatically.
