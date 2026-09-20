// Local dev server. Serves index.html and dispatches /api/* to the same
// handler modules Vercel runs in production, so `npm start` behaves like
// the deployed app.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 20 * 1024 * 1024; // floor-plan uploads arrive as base64 JSON

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.replace("/api/", "").replace(/[^a-z0-9-]/gi, "");
    const file = path.join(__dirname, "api", `${name}.js`);
    if (!fs.existsSync(file)) {
      decorate(res).status(404).json({ error: `No API route ${url.pathname}` });
      return;
    }
    try {
      req.body = req.method === "POST" ? await readBody(req) : {};
      await require(file)(req, decorate(res));
    } catch (err) {
      decorate(res).status(500).json({ error: String(err.message || err) });
    }
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(__dirname, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!full.startsWith(__dirname) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
  res.setHeader("Content-Type", types[path.extname(full)] || "application/octet-stream");
  res.end(fs.readFileSync(full));
});

server.listen(PORT, () => {
  console.log(`land-decision-tool on http://localhost:${PORT}`);
});
