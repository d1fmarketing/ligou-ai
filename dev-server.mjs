import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { proxySalesSession } from "./src/server/sales-proxy.mjs";
import { publicSiteConfig, publicSiteConfigScript } from "./scripts/public-site-config.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const canonicalRoot = fs.realpathSync(root);
const port = Number(process.env.LIGOU_PREVIEW_PORT || 4174);
const publicConfigScript=publicSiteConfigScript(publicSiteConfig(process.env));
const publicFiles = new Set(['index.html','favicon.svg','favicon.ico','og-card.svg','og-ligou.png','robots.txt','sitemap.xml']);
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

function isPublicPath(relativePath) {
  if(relativePath.split('/').some(part=>part.startsWith('.')) || relativePath.includes('\\'))return false;
  if(['auth.json','secrets.json','credentials.json'].includes(path.basename(relativePath).toLowerCase()))return false;
  return publicFiles.has(relativePath) || /^(?:assets|_ds|comercial|termos|privacidade|output)\//.test(relativePath) || relativePath.startsWith('tests/browser/');
}
function resolveRequestPath(pathname) {
  const relativePath = pathname.endsWith("/") ? `${pathname.replace(/^\/+/, "")}index.html` : pathname.replace(/^\/+/, "");
  if(!isPublicPath(relativePath))return null;
  const filePath = path.resolve(root, relativePath);
  if(!filePath.startsWith(`${root}${path.sep}`))return null;
  try {
    const resolved=fs.realpathSync(filePath);
    return resolved.startsWith(`${canonicalRoot}${path.sep}`) && isPublicPath(path.relative(canonicalRoot,resolved)) ? resolved : null;
  }catch {return null;}
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
  const actualPort=server.address()?.port??port;
  const hosts=[`127.0.0.1:${actualPort}`,`localhost:${actualPort}`,`[::1]:${actualPort}`];
  if(actualPort===80)hosts.push('127.0.0.1','localhost','[::1]');
  if(!hosts.includes((request.headers.host||'').toLowerCase())) {response.writeHead(403).end('Forbidden');return;}
  let url, pathname;
  try {
    url=new URL(request.url || "/", `http://127.0.0.1:${actualPort}`);
    pathname=decodeURIComponent(url.pathname);
    if(pathname.includes('\0'))throw new Error();
  }catch {response.writeHead(400).end('Bad request');return;}
  if(url.pathname!=='/api/sales-session'&&!['GET','HEAD'].includes(request.method)) {response.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
  if (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/")) {
    // Leave Location fragment-free so the browser inherits its original hash.
    response.writeHead(302, {
      Location: `https://client-nine-taupe-24.vercel.app${url.pathname}${url.search}`,
      "Cache-Control": "no-store",
    }).end();
    return;
  }
  if (url.pathname === "/public-config.js") {
    response.writeHead(200, {"Content-Type":"text/javascript; charset=utf-8","Cache-Control":"no-store"}).end(publicConfigScript);
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
  const filePath = resolveRequestPath(pathname);
  let stat;try {if(filePath)stat=fs.statSync(filePath);}catch {}
  if (!stat?.isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }

  const size = stat.size;
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
    else fs.createReadStream(filePath, range).on('error',()=>response.destroy()).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": size });
  if (request.method === "HEAD") response.end();
  else fs.createReadStream(filePath).on('error',()=>response.destroy()).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Ligou preview: http://127.0.0.1:${port}/`);
});
