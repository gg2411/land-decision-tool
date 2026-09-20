const test = require("node:test");
const assert = require("node:assert");
const { decodeUpload, normalizePlan, parseModelJson, planProvider, extractPlan } = require("../lib/planParse");

const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("decodeUpload reads a data URL and rejects other file types", () => {
  const u = decodeUpload(tinyPng);
  assert.equal(u.mimeType, "image/png");
  assert.equal(u.isImage, true);
  assert.throws(() => decodeUpload("data:text/csv;base64,YQ=="), /JPG, PNG or PDF/);
  assert.throws(() => decodeUpload(""), /No file/);
});

test("parseModelJson survives markdown fences and surrounding prose", () => {
  assert.deepEqual(parseModelJson('```json\n{"beds": 4}\n```'), { beds: 4 });
  assert.deepEqual(parseModelJson('Here you go: {"beds": 3} — hope that helps'), { beds: 3 });
  assert.throws(() => parseModelJson("I cannot read this plan."), /did not return JSON/);
});

test("normalizePlan drops junk values and implausible areas", () => {
  const p = normalizePlan({ livingAreaSqft: "3120.4", beds: 4, baths: 3.5, stories: 0, garageSpaces: -1, confidence: "wild" });
  assert.equal(p.livingAreaSqft, 3120);
  assert.equal(p.baths, 3.5);
  assert.equal(p.stories, null);
  assert.equal(p.garageSpaces, null);
  assert.equal(p.confidence, "low");

  const huge = normalizePlan({ livingAreaSqft: 43560, confidence: "high" });
  assert.equal(huge.livingAreaSqft, null);
  assert.equal(huge.confidence, "low");
  assert.match(huge.notes, /outside the plausible range/);
});

test("planProvider prefers OpenAI and reports when nothing is configured", () => {
  assert.equal(planProvider({ OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" }), "openai");
  assert.equal(planProvider({ ANTHROPIC_API_KEY: "b" }), "anthropic");
  assert.equal(planProvider({}), null);
});

test("extractPlan explains itself when no model is configured", async () => {
  await assert.rejects(() => extractPlan({ fileDataUrl: tinyPng }, {}), /No vision model is configured/);
});

test("extractPlan posts the image to the model and normalizes the answer", async () => {
  let seen = null;
  const fakeFetch = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"livingAreaSqft":3210,"beds":4,"baths":3.5,"confidence":"high","notes":"Area schedule."}' } }] }),
    };
  };
  const out = await extractPlan({ fileDataUrl: tinyPng }, { OPENAI_API_KEY: "k" }, fakeFetch);
  assert.equal(out.provider, "openai");
  assert.equal(out.plan.livingAreaSqft, 3210);
  assert.match(seen.url, /chat\/completions$/);
  assert.match(seen.body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test("extractPlan surfaces model HTTP errors", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  await assert.rejects(() => extractPlan({ fileDataUrl: tinyPng }, { OPENAI_API_KEY: "k" }, fakeFetch), /429/);
});
