// Yerel geliştirme sunucusu: siteyi sunar ve /api isteklerini Supabase fonksiyonundaki handler'a verir.
// Çalıştır: node dev.mjs  →  http://localhost:8787
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { handler } from "./supabase/functions/temettu/index.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 8787;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/api") {
    const r = await handler(new Request(url, { method: req.method, headers: { Origin: `http://localhost:${port}` } }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const path = normalize(join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("bulunamadı"); }
}).listen(port, () => console.log(`http://localhost:${port}`));
