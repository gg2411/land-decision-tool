// tavily.js
// Web-sourced "sold $/sqft" signal via Tavily search — a rough ARV check for
// polygons where we have no MLS comps. Dependency-free (Node 18+ global
// fetch). Never log or interpolate the API key into errors.

const { median, percentile } = require("./core");

const BASE_URL = "https://api.tavily.com/search";
const PPSF_RE =
  /\$\s?(\d{1,3}(?:,\d{3})+|\d{2,4})(?:\.\d+)?\s*(?:\/|per)\s*(?:sq\.?\s?ft|square\s?foot|sqft)/gi;

// Extract plausible $/sqft figures (50–2000) from a text snippet. Deduped.
function extractPpsf(text) {
  const out = new Set();
  let m;
  const re = new RegExp(PPSF_RE);
  while ((m = re.exec(text || "")) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 50 && n <= 2000) out.add(n);
  }
  return [...out];
}

// Pure summarizer (testable without network): results = [{ title, url, content }]
function summarizeWebResults(results) {
  const sources = [];
  const all = [];
  for (const r of results || []) {
    const ppsf = extractPpsf(`${r.title || ""} ${r.content || ""}`);
    if (ppsf.length) {
      sources.push({ title: r.title, url: r.url, ppsf });
      all.push(...ppsf);
    }
    if (sources.length >= 8) break;
  }
  const sorted = all.slice().sort((a, b) => a - b);
  return {
    n: all.length,
    medianPpsf: median(sorted),
    ppsfLow: percentile(sorted, 0.25),
    ppsfHigh: percentile(sorted, 0.75),
    sources,
  };
}

async function fetchWebPpsf({ zips, place = "Houston, TX", apiKey, timeoutMs = 15000 } = {}) {
  if (!apiKey) return null;
  const zipPart = (zips || []).slice(0, 3).join(" ");
  const query = `recently sold homes price per square foot${zipPart ? " " + zipPart : ""} ${place}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 8, include_answer: false }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`Tavily query failed ${resp.status}`);
  const payload = await resp.json();
  return { ...summarizeWebResults(payload.results), query };
}

module.exports = { fetchWebPpsf, extractPpsf, summarizeWebResults };
