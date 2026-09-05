import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proxySalesSession } from "./src/server/sales-proxy.mjs";

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
  const relativePath = pathname.endsWith("/") ? `${pathname.replace(/^\/+/, "")}index.html` : pathname.replace(/^\/+/, "");
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

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
    // Leave Location fragment-free so the browser inherits its original hash.
    response.writeHead(302, {
      Location: `https://client-nine-taupe-24.vercel.app${url.pathname}${url.search}`,
      "Cache-Control": "no-store",
    }).end();
    return;
  }
  if (url.pathname === "/public-config.js") {
    const supabaseUrl = process.env.LIGOU_PUBLIC_SUPABASE_URL || "";
    const supabaseKey = process.env.LIGOU_PUBLIC_SUPABASE_KEY || "";
    let publicKey = supabaseKey.startsWith("sb_publishable_");
    try { publicKey ||= JSON.parse(Buffer.from(supabaseKey.split(".")[1], "base64url").toString()).role === "anon"; } catch {}
    const config = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) && publicKey ? {supabaseUrl, supabaseKey} : {};
    response.writeHead(200, {"Content-Type":"text/javascript; charset=utf-8","Cache-Control":"no-store"}).end(`window.LIGOU_PUBLIC_CONFIG=Object.freeze(${JSON.stringify(config)});`);
    return;
  }
  if (url.pathname === "/api/sales-session") {
    try {
      const chunks=[]; let bytes=0;
      for await (const chunk of request) {
        bytes+=chunk.length;
        if(bytes>98304){response.writeHead(413).end();return;}
        chunks.push(chunk);
      }
      const incoming=new Request(url,{method:request.method,headers:request.headers,...(request.method==='POST'?{body:Buffer.concat(chunks)}:{})});
      const upstream=await proxySalesSession(incoming,{
        edgeUrl:process.env.LIGOU_SALES_EDGE_URL,
        proxySecret:process.env.LIGOU_SALES_PROXY_SECRET,
        allowedOrigins:[`http://127.0.0.1:${port}`,`http://localhost:${port}`],
        networkIp:request.socket.remoteAddress?.replace(/^::ffff:/,''),
      });
      response.writeHead(upstream.status,Object.fromEntries(upstream.headers));response.end(await upstream.text());
    } catch {response.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:'service_unavailable'}));}
    return;
  }
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
