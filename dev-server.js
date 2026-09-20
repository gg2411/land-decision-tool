// Minimal local dev server: serves index.html and /api/analyze without Vercel.
const http = require("http");
const fs = require("fs");
const path = require("path");
const handler = require("./api/analyze");

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if ((url === "/" || url === "/index.html") && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
    return;
  }
  if (url === "/api/analyze") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payload too large" }));
        req.destroy();
      }
    });
    req.on("end", async () => {
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const shim = {
        status(code) {
          this._status = code;
          return this;
        },
        json(obj) {
          res.writeHead(this._status || 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        },
      };
      await handler(req, shim);
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Land decision tool → http://localhost:${PORT}`);
});
