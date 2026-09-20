// planParse.js
// Reads an uploaded floor plan with a vision model and returns the handful
// of numbers the pro forma needs. Everything it returns is editable in the
// UI — the model is a typing shortcut, not an authority.

const PROMPT = `You are reading an architectural floor plan for a single-family spec home.

Return ONLY a JSON object, no prose, no markdown fence, with these keys:
{
  "livingAreaSqft": number|null,   // total finished/conditioned area, all floors. Exclude garage, porches, patios.
  "beds": number|null,
  "baths": number|null,            // count half baths as 0.5
  "stories": number|null,
  "garageSpaces": number|null,
  "lotWidthFt": number|null,       // only if the plan shows the lot
  "lotDepthFt": number|null,
  "confidence": "high"|"medium"|"low",
  "notes": string                  // one short sentence: what you read it off (a printed area schedule, summed room dimensions, etc.) and anything ambiguous
}

Rules:
- Prefer a printed area schedule or title-block square footage over your own arithmetic.
- If the plan prints separate floor areas, sum them.
- Never guess a number that is not supported by the drawing; use null instead.
- "low" confidence if you had to infer the area from room dimensions or scale.`;

const MAX_BYTES = 12 * 1024 * 1024;

// OpenAI is preferred for images, but it cannot take a PDF, so a PDF goes to
// Anthropic whenever that key exists.
function planProvider(env = process.env, isPdf = false) {
  if (isPdf && env.ANTHROPIC_API_KEY) return "anthropic";
  if (env.OPENAI_API_KEY) return "openai";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

// The declared mime type is a claim by the caller, so the real type is read off
// the file's own magic bytes and everything downstream uses that instead.
const SIGNATURES = [
  { mimeType: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { mimeType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mimeType: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

function sniffMimeType(head) {
  for (const sig of SIGNATURES) {
    const start = sig.bytes.every((b, i) => head[i] === b);
    const tail = !sig.at8 || sig.at8.every((b, i) => head[8 + i] === b);
    if (start && tail) return sig.mimeType;
  }
  return null;
}

// Accepts either a data: URL or raw base64 plus a mime type.
function decodeUpload(fileDataUrl, mimeTypeHint) {
  if (typeof fileDataUrl !== "string" || !fileDataUrl.length) {
    throw new Error("No file was uploaded.");
  }
  let base64 = fileDataUrl;
  let mimeType = mimeTypeHint || null;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(fileDataUrl);
  if (m) {
    mimeType = m[1];
    base64 = m[2];
  }
  if (!mimeType) throw new Error("Could not determine the file type of the upload.");
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES) {
    throw new Error("That file is larger than 12 MB — export the plan as a smaller JPG or PNG.");
  }
  const sniffed = sniffMimeType(Buffer.from(base64.slice(0, 64), "base64"));
  if (!sniffed) {
    throw new Error("That file is not a readable JPG, PNG or PDF of a floor plan.");
  }
  mimeType = sniffed;
  const isPdf = mimeType === "application/pdf";
  return { base64, mimeType, isPdf, isImage: !isPdf };
}

function normalizePlan(raw) {
  const out = {
    livingAreaSqft: posInt(raw?.livingAreaSqft),
    beds: posNum(raw?.beds),
    baths: posNum(raw?.baths),
    stories: posNum(raw?.stories),
    garageSpaces: posNum(raw?.garageSpaces),
    lotWidthFt: posNum(raw?.lotWidthFt),
    lotDepthFt: posNum(raw?.lotDepthFt),
    confidence: ["high", "medium", "low"].includes(raw?.confidence) ? raw.confidence : "low",
    notes: typeof raw?.notes === "string" ? raw.notes.slice(0, 400) : "",
  };
  // A plan reading outside this band is far more likely a misread scale or a
  // lot-area number than a real house; surface it instead of silently using it.
  if (out.livingAreaSqft != null && (out.livingAreaSqft < 400 || out.livingAreaSqft > 20000)) {
    out.notes = `Read ${out.livingAreaSqft} sq ft, which is outside the plausible range — enter the size by hand. ${out.notes}`;
    out.livingAreaSqft = null;
    out.confidence = "low";
  }
  return out;
}

function parseModelJson(text) {
  if (typeof text !== "string") throw new Error("The model returned no text.");
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Could not read the plan — the model did not return JSON.");
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callOpenAI({ base64, mimeType, isPdf }, env, fetchImpl) {
  if (isPdf) {
    throw new Error("PDF plans need an Anthropic key; with OpenAI, upload a JPG or PNG of the plan page.");
  }
  const model = env.OPENAI_VISION_MODEL || "gpt-4o-mini";
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Vision model error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const payload = await resp.json();
  return { text: payload.choices?.[0]?.message?.content, model };
}

async function callAnthropic({ base64, mimeType, isPdf }, env, fetchImpl) {
  const model = env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } };
  const resp = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Vision model error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  }
  const payload = await resp.json();
  const text = (payload.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, model };
}

async function extractPlan({ fileDataUrl, mimeType }, env = process.env, fetchImpl = fetch) {
  // Reject an unreadable file before talking about models: what the user
  // uploaded is wrong either way.
  const upload = decodeUpload(fileDataUrl, mimeType);
  if (!planProvider(env)) {
    throw new Error(
      "No vision model is configured. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY) to read plans automatically — you can still type the numbers in by hand."
    );
  }
  const provider = planProvider(env, upload.isPdf);
  const { text, model } =
    provider === "openai"
      ? await callOpenAI(upload, env, fetchImpl)
      : await callAnthropic(upload, env, fetchImpl);
  return { plan: normalizePlan(parseModelJson(text)), provider, model };
}

function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function posInt(v) {
  const n = posNum(v);
  return n == null ? null : Math.round(n);
}

module.exports = { PROMPT, planProvider, decodeUpload, normalizePlan, parseModelJson, extractPlan };
