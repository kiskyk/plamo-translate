// Serves this checkout over http with the cross-origin isolation headers the in-browser engine needs
// (SharedArrayBuffer for wasm threads). Usage: node tools/serve.mjs [port]  → http://127.0.0.1:8765/test/engine.html
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || 8765);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css" };

createServer((req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  let st;
  try { st = statSync(path); } catch { res.writeHead(404).end(); return; }
  if (!st.isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    "Content-Type": TYPES[extname(path)] || "application/octet-stream",
    "Content-Length": st.size,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  createReadStream(path).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/test/engine.html`));
