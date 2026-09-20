// tavily.js
// Web-sourced "sold $/sqft" signal via Tavily search — a rough ARV check for
// polygons where we have no MLS comps. Dependency-free (Node 18+ global
// fetch). Never log or interpolate the API key into errors.

const { median, percentile } = require("./core");

const BASE_URL = "https://api.tavily.com/search";
const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d{2,4})(?:\\.\\d+)?";
// "$312/sq ft" style: dollar value first
const PPSF_BEFORE_RE = new RegExp(
  `\\$\\s?${NUM}\\s*(?:/|per)\\s*(?:sq\\.?\\s?ft|square\\s?foot|sqft)`,
  "gi"
);
// "median price per square foot of $513" / "per square foot was $556.75"
const PPSF_AFTER_RE = new RegExp(
  `(?:per|/)\\s*(?:sq\\.?\\s?ft|square\\s?foot|sqft)[^$\\d]{0,40}\\$\\s?${NUM}`,
  "gi"
);

// Extract plausible $/sqft figures (50–2000) from a text snippet. Deduped.
function extractPpsf(text) {
  const out = new Set();
  for (const re of [new RegExp(PPSF_BEFORE_RE), new RegExp(PPSF_AFTER_RE)]) {
    let m;
    while ((m = re.exec(text || "")) !== null) {
      const n = Number(m[1].replace(/,/g, ""));
      if (n >= 50 && n <= 2000) out.add(n);
    }
  }
  return [...out];
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "unknown";
  }
}

// Pure summarizer (testable without network): results = [{ title, url, content }]
function summarizeWebResults(results, answer) {
  const sources = [];
  const seenHosts = new Set();
  const all = [];
  for (const r of results || []) {
    const host = hostname(r.url);
    if (seenHosts.has(host)) continue;
    const ppsf = extractPpsf(`${r.title || ""} ${r.content || ""}`);
    seenHosts.add(host);
    if (ppsf.length) {
      sources.push({ title: r.title, url: r.url, ppsf });
      all.push(...ppsf);
    }
    if (sources.length >= 8) break;
  }
  const answerPpsf = extractPpsf(answer);
  if (answerPpsf.length) {
    sources.push({ title: "Tavily summary", url: null, ppsf: answerPpsf });
    all.push(...answerPpsf);
  }
  const sorted = all.slice().sort((a, b) => a - b);
  return {
    n: all.length,
    medianPpsf: median(sorted),
    ppsfLow: percentile(sorted, 0.25),
    ppsfHigh: percentile(sorted, 0.75),
    sources,
    answer: typeof answer === "string" ? answer : null,
  };
}

async function tavilySearch(query, apiKey, timeoutMs) {
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
      body: JSON.stringify({ query, search_depth: "advanced", max_results: 8, include_answer: true }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`Tavily query failed ${resp.status}`);
  return resp.json();
}

async function fetchWebPpsf({ zips, apiKey, timeoutMs = 15000 } = {}) {
  if (!apiKey) return null;
  // Dominant ZIP only: blending neighbouring ZIPs (e.g. 77005 + 77030) dilutes the signal.
  const zipList = (zips || []).slice(0, 1);
  if (!zipList.length) return null; // no location → no signal
  const query = (zip) => `${zip} Houston TX homes sold median price per square foot`;
  const payloads = await Promise.all(zipList.map((zip) => tavilySearch(query(zip), apiKey, timeoutMs)));
  const results = payloads.flatMap((p) => p.results || []);
  const answer = payloads.map((p) => p.answer).find((a) => extractPpsf(a).length) || payloads[0]?.answer;
  return { ...summarizeWebResults(results, answer), query: zipList.map(query).join(" | ") };
}

module.exports = { fetchWebPpsf, extractPpsf, summarizeWebResults };
