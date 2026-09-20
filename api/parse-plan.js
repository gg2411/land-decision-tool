const { extractPlan, planProvider } = require("../lib/planParse");
const { createRateLimit, clientKey } = require("../lib/rateLimit");

const limit = createRateLimit({ limit: 10, windowMs: 60_000 });

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.status(200).json({ available: planProvider() !== null });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  const gate = limit(clientKey(req));
  if (!gate.allowed) {
    res.setHeader("Retry-After", String(gate.retryAfterSec));
    res.status(429).json({ error: "Too many plan uploads at once — wait a minute and try again." });
    return;
  }
  try {
    const body = req.body || {};
    const result = await extractPlan({ fileDataUrl: body.file, mimeType: body.mimeType });
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
};
