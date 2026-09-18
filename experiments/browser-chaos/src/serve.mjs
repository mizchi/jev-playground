/** Static server for app/, so the crawl has something same-origin to walk. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "app");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^\/+/, "");
    try {
      const body = await readFile(join(root, rel));
      const ext = rel.slice(rel.lastIndexOf("."));
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await serve(8901);
  console.log(`serving ${url}`);
}
