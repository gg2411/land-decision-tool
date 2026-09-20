const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

process.env.LDT_SKIP_HCAD = "1";
process.env.LDT_SKIP_WEB = "1";

function startServer(port) {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    proc.stdout.on("data", (b) => String(b).includes("land-decision-tool on") && resolve(proc));
    proc.on("error", reject);
    setTimeout(() => reject(new Error("server did not start")), 5000).unref();
  });
}

test("the dev server answers a bad request as a bad request", async (t) => {
  const port = 39117;
  const proc = await startServer(port);
  t.after(() => proc.kill());

  const bad = await fetch(`http://127.0.0.1:${port}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Invalid JSON/);

  const missing = await fetch(`http://127.0.0.1:${port}/api/nope`, { method: "POST", body: "{}" });
  assert.equal(missing.status, 404);

  const source = await fetch(`http://127.0.0.1:${port}/server.js`);
  assert.equal(source.status, 404);
});
