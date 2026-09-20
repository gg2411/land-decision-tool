const { tavilySearch } = require("../lib/tavily");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }

  const body = req.body || {};
  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (address.length < 3 || address.length > 120) {
    res.status(400).json({ error: "address must be a string of 3–120 characters" });
    return;
  }

  if (typeof body.listingKey === "string" && body.listingKey.startsWith("MOCK")) {
    res.status(400).json({ error: "Deep dive is not available for mock listings" });
    return;
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    res.status(503).json({
      error: "TAVILY_API_KEY is not configured — add it in Vercel → Settings → Environment Variables.",
    });
    return;
  }

  const city = typeof body.city === "string" && body.city.length <= 60
    ? body.city || "Houston"
    : "Houston";
  const q1 = `"${address}" ${city} TX home sold price history`;
  const q2 = `"${address}" ${city} TX listing new construction builder permit`;
  const searchOpts = {
    include_answer: "advanced",
    max_results: 6,
    search_depth: "advanced",
  };

  try {
    const [history, property] = await Promise.all([
      tavilySearch(q1, apiKey, 15000, searchOpts),
      tavilySearch(q2, apiKey, 15000, searchOpts),
    ]);
    const seen = new Set();
    const results = [...(history.results || []), ...(property.results || [])]
      .filter((result) => {
        if (!result.url || seen.has(result.url)) return false;
        seen.add(result.url);
        return true;
      })
      .map((result) => ({
        title: result.title,
        url: result.url,
        content: String(result.content || "").slice(0, 400),
        published_date: result.published_date,
        score: result.score,
      }));

    res.status(200).json({
      address,
      queries: [q1, q2],
      summary: history.answer || property.answer || null,
      results,
      listing: {
        price: body.price,
        sqft: body.sqft,
        beds: body.beds,
        baths: body.baths,
        yearBuilt: body.yearBuilt,
        listPrice: body.listPrice,
        closePrice: body.closePrice,
        lotSizeSqft: body.lotSizeSqft,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
