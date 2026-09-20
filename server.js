// Local dev server. Serves index.html and dispatches /api/* to the same
// handler modules Vercel runs in production, so `npm start` behaves like
// the deployed app.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 20 * 1024 * 1024; // floor-plan uploads arrive as base64 JSON
const PUBLIC_FILES = new Map([
  ["index.html", "text/html"],
  ["favicon.ico", "image/x-icon"],
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on("data", (c) => {
      if (over) return; // keep draining: destroying the socket kills the 413 too
      size += c.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        const tooBig = new Error("Request body too large");
        tooBig.statusCode = 413;
        reject(tooBig);
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
        const bad = new Error("Invalid JSON body");
        bad.statusCode = 400;
        reject(bad);
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
      // A body the client sent wrong is the client's error, not a server fault.
      decorate(res)
        .status(err.statusCode || 500)
        .json({ error: String(err.message || err) });
    }
    return;
  }

  // The app is one page; serving the rest of the checkout (source, .git) would
  // hand the whole repository to anyone who can reach this port.
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(__dirname, file);
  if (!PUBLIC_FILES.has(file) || !fs.existsSync(full)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  res.setHeader("Content-Type", PUBLIC_FILES.get(file));
  res.end(fs.readFileSync(full));
});

server.listen(PORT, () => {
  console.log(`land-decision-tool on http://localhost:${PORT}`);
});
