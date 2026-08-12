import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.LIGOU_PREVIEW_PORT || 4174);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/jsx; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, relativePath);
  return filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
}

function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader || "");
  if (!match) return null;

  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    return null;
  }

  return { start, end };
}

const server = http.createServer((request, response) => {
  const filePath = resolveRequestPath(request.url || "/");
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  const size = fs.statSync(filePath).size;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
  };
  const range = request.headers.range ? parseRange(request.headers.range, size) : null;

  if (request.headers.range && !range) {
    response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();
    return;
  }

  if (range) {
    response.writeHead(206, {
      ...headers,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
    });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(filePath, range).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": size });
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Ligou preview: http://127.0.0.1:${port}/`);
});
