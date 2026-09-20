const test = require("node:test");
const assert = require("node:assert/strict");
const { extractPpsf, summarizeWebResults } = require("../lib/tavily");

test("extractPpsf pulls $/sqft figures", () => {
  assert.deepEqual(extractPpsf("Homes average $312/sq ft here."), [312]);
  assert.deepEqual(extractPpsf("Sold at $1,050 per square foot"), [1050]);
  assert.deepEqual(extractPpsf("median of $430 per sqft"), [430]);
  assert.deepEqual(extractPpsf("sold for $450,000, 2,000 sqft"), []);
  // value-after-unit phrasing seen in real Tavily results
  assert.deepEqual(extractPpsf("median price per square foot of $513"), [513]);
  assert.deepEqual(extractPpsf("price per square foot was $556.75"), [556]);
  assert.deepEqual(extractPpsf("sold homes per sq ft: $400"), [400]);
  assert.deepEqual(extractPpsf("median price per square foot of sold homes was $513."), [513]);
  assert.deepEqual(extractPpsf("price per square foot for homes sold in 77005, Houston, TX, is $513"), [513]);
  assert.deepEqual(extractPpsf("price per square foot in Houston is $250"), [250]);
  assert.deepEqual(extractPpsf("Price per square foot rose. The HOA fee is $500 monthly"), []);
  assert.deepEqual(extractPpsf("median price per square foot $513"), [513]);
  assert.deepEqual(extractPpsf("median price per square foot for Houston homes: $513"), [513]);
  assert.deepEqual(extractPpsf("Price per square foot rose, but the monthly HOA fee is $500"), []);
  // a dollar figure not linked to the sqft phrase must not match
  assert.deepEqual(extractPpsf("Price per square foot increased last year; HOA fee $500 monthly"), []);
});

test("summarizeWebResults dedupes by hostname and folds in the answer", () => {
  const s = summarizeWebResults(
    [
      { title: "A0", url: "https://orchard.com/empty", content: "no figures here" },
      { title: "A1", url: "https://orchard.com/x", content: "$300/sq ft" },
      { title: "A2", url: "https://orchard.com/y", content: "$310/sqft" },
      { title: "B", url: "https://har.com/z", content: "$400 per square foot" },
    ],
    "The median price per square foot was $513."
  );
  assert.equal(s.sources.length, 3); // figure-less A0 doesn't block A1; A2 deduped; +1 Tavily summary
  assert.equal(s.sources[0].title, "A1");
  assert.equal(s.sources[2].title, "Tavily summary");
  assert.equal(s.sources[2].url, null);
  assert.deepEqual(s.sources[2].ppsf, [513]);
  assert.equal(s.answer, "The median price per square foot was $513.");
  // answer values display as a source but are excluded from stats when results exist
  assert.equal(s.n, 2);
  assert.equal(s.medianPpsf, 350);
});

test("summarizeWebResults uses the answer for stats only when results are empty", () => {
  const s = summarizeWebResults([], "median sold $/sqft: $400");
  assert.equal(s.n, 1);
  assert.equal(s.medianPpsf, 400);
  assert.equal(s.sources.length, 1);
  assert.equal(s.sources[0].title, "Tavily summary");
});

test("extractPpsf filters out-of-range values and dedupes", () => {
  assert.deepEqual(extractPpsf("$12 per square foot and $5000/sqft"), []);
  assert.deepEqual(extractPpsf("$200/sqft, again $200 per square foot"), [200]);
});

test("summarizeWebResults aggregates per-source values", () => {
  const s = summarizeWebResults([
    { title: "A", url: "https://a", content: "$300/sq ft and $320/sqft" },
    { title: "B", url: "https://b", content: "no numbers" },
    { title: "C", url: "https://c", content: "about $400 per square foot" },
  ]);
  assert.equal(s.n, 3);
  assert.equal(s.medianPpsf, 320);
  assert.equal(s.ppsfLow, 320); // percentile rounds idx 0.25*2 -> 1
  assert.equal(s.ppsfHigh, 400);
  assert.equal(s.sources.length, 2);
  assert.deepEqual(s.sources[0].ppsf, [300, 320]);
  assert.equal(s.sources[1].title, "C");
});

test("summarizeWebResults empty input gives nulls", () => {
  const s = summarizeWebResults([]);
  assert.equal(s.n, 0);
  assert.equal(s.medianPpsf, null);
  assert.deepEqual(s.sources, []);
});
