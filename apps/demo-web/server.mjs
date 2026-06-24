import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const port = Number(process.env.PORT || "8788");
const root = new URL(".", import.meta.url).pathname;
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"]
]);

createServer(async (req, res) => {
  const pathname = req.url === "/" ? "/index.html" : (req.url || "/index.html");
  try {
    const file = join(root, pathname);
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types.get(extname(file)) || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}).listen(port, () => {
  console.log(`FiberMPP demo web listening on http://localhost:${port}`);
});
