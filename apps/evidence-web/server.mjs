import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("./dist/", import.meta.url)));
const fallbackRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const defaultApiBase = "http://localhost:8787";
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

export function startEvidenceWeb(port = Number(process.env.PORT || "8788"), options = {}) {
  const apiBase = normalizeApiBase(options.apiBase || process.env.FIBER_MPP_EVIDENCE_API_BASE || defaultApiBase);
  const headers = securityHeaders(apiBase);
  const server = createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {
        "allow": "GET, HEAD",
        ...headers
      });
      res.end();
      return;
    }

    const pathname = safePathname(req);
    if (!pathname) {
      res.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        ...headers
      });
      res.end("bad request");
      return;
    }

    const file = resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
    const fallbackFile = resolve(fallbackRoot, pathname === "/" ? "index.html" : pathname.slice(1));
    const servingFile = types.has(extname(file)) ? file : fallbackFile;
    const servingRoot = servingFile === file ? root : fallbackRoot;
    if (!isInsideRoot(servingFile, servingRoot)) {
      res.writeHead(403, {
        "content-type": "text/plain; charset=utf-8",
        ...headers
      });
      res.end("forbidden");
      return;
    }
    const ext = extname(servingFile);
    if (!types.has(ext)) {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        ...headers
      });
      res.end("not found");
      return;
    }

    try {
      const body = await readStaticFile(servingFile, apiBase);
      res.writeHead(200, {
        "content-type": types.get(ext) || "application/octet-stream",
        "cache-control": "no-store",
        ...headers
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        ...headers
      });
      res.end("not found");
    }
  });
  server.listen(port, () => {
    console.log(`FiberMPP evidence console listening on http://localhost:${port}`);
    console.log(`FiberMPP evidence console API base ${apiBase}`);
  });
  return server;
}

if (isMainModule()) {
  startEvidenceWeb();
}

async function readStaticFile(file, apiBase) {
  const body = await readFile(file);
  if (extname(file) !== ".html" || apiBase === defaultApiBase) {
    return body;
  }
  return body.toString("utf8").replaceAll(defaultApiBase, apiBase);
}

function safePathname(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

function isInsideRoot(file, base = root) {
  const distance = relative(base, file);
  return distance === "" || (!distance.startsWith("..") && !isAbsolute(distance));
}

function securityHeaders(apiBase = defaultApiBase) {
  const apiOrigin = apiOriginForCsp(apiBase);
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": `default-src 'self'; connect-src 'self' ${apiOrigin}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`,
    "cross-origin-resource-policy": "same-origin"
  };
}

function normalizeApiBase(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return defaultApiBase;
  }
}

function apiOriginForCsp(apiBase) {
  try {
    const url = new URL(apiBase);
    return url.origin;
  } catch {
    return new URL(defaultApiBase).origin;
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
