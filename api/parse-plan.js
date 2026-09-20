const { extractPlan, planProvider } = require("../lib/planParse");

module.exports = async (req, res) => {
  if (req.method === "GET") {
    res.status(200).json({ available: planProvider() !== null });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
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
