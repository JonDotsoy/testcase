#!/usr/bin/env node
/**
 * proxy.ts
 *
 * Proxy inverso de evidencia que corre como proceso local, sin contenedor. Hace lo mismo que
 * `mitmdump --mode reverse:<upstream> --set hardump=<archivo>`: reenvía cada request al servicio real
 * y guarda request y response en un HAR que import-har.ts entiende.
 *
 * Uso:
 *   node proxy.ts --upstream http://localhost:3000 --listen 18080 --har .testcase/evidence/web.har
 *
 *   --upstream   Servicio real (http o https). Se conserva su ruta base.
 *   --listen     Puerto local donde escucha el proxy (en 127.0.0.1). 0 elige uno libre y lo imprime.
 *   --har        Archivo HAR. Se reescribe después de cada request y al detenerse (SIGTERM o SIGINT),
 *                así que la evidencia no se pierde si el proceso muere.
 *   --insecure   No verifica el certificado del upstream (servicios locales con certificado propio).
 *
 * Normalmente lo levanta scripts/local.ts. Corre con Node 22.6 o superior, o con bun. Sin dependencias.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const upstreamArg = flag("--upstream");
const listenArg = flag("--listen");
const harArg = flag("--har");
if (!upstreamArg || listenArg == null || !harArg) {
  console.log("Uso: node proxy.ts --upstream <url> --listen <puerto> --har <archivo.har> [--insecure]");
  process.exit(1);
}
const upstream = new URL(upstreamArg);
if (!/^https?:$/.test(upstream.protocol)) {
  console.error(`proxy: el upstream debe ser http o https: ${upstreamArg}`);
  process.exit(1);
}
const insecure = args.includes("--insecure");
const harFile = resolve(harArg);
mkdirSync(dirname(harFile), { recursive: true });

const entries: unknown[] = [];
const TEXT = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql)|image\/svg)/i;

function writeHar() {
  const tmp = harFile + ".tmp";
  writeFileSync(tmp, JSON.stringify({ log: { version: "1.2", creator: { name: "testcase-proxy", version: "1.0" }, entries } }));
  renameSync(tmp, harFile);
}

const readAll = (m: IncomingMessage) =>
  new Promise<Buffer>((ok, ko) => {
    const chunks: Buffer[] = [];
    m.on("data", (c: Buffer) => chunks.push(c));
    m.on("end", () => ok(Buffer.concat(chunks)));
    m.on("error", ko);
  });

/** Pares nombre/valor en el orden en que llegaron, como los guarda mitmdump. */
const pairs = (raw: string[]) => {
  const out: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < raw.length; i += 2) out.push({ name: raw[i], value: raw[i + 1] });
  return out;
};

/** El HAR guarda el contenido sin comprimir. */
function decode(body: Buffer, encoding: string | undefined): Buffer {
  try {
    switch ((encoding ?? "").toLowerCase()) {
      case "gzip":
      case "x-gzip":
        return gunzipSync(body);
      case "deflate":
        return inflateSync(body);
      case "br":
        return brotliDecompressSync(body);
      default:
        return body;
    }
  } catch {
    return body;
  }
}

function content(body: Buffer, mime: string) {
  if (!body.length) return { size: 0, mimeType: mime };
  if (TEXT.test(mime) || !mime) return { size: body.length, mimeType: mime, text: body.toString("utf8") };
  return { size: body.length, mimeType: mime, text: body.toString("base64"), encoding: "base64" };
}

const basePath = upstream.pathname.replace(/\/$/, "");

const server = createServer(async (req, res) => {
  const started = new Date();
  const t0 = performance.now();
  let reqBody: Buffer;
  try {
    reqBody = await readAll(req);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const headers: OutgoingHttpHeaders = { ...req.headers, host: upstream.host };
  const target = new URL(basePath + (req.url ?? "/"), upstream.origin);
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const up = send(target, { method: req.method, headers, ...(insecure ? { rejectUnauthorized: false } : {}) }, async (ures) => {
    let resBody: Buffer;
    try {
      resBody = await readAll(ures);
    } catch {
      res.writeHead(502).end();
      return;
    }
    const time = Math.round(performance.now() - t0);
    const resMime = String(ures.headers["content-type"] ?? "");
    const reqMime = String(req.headers["content-type"] ?? "");
    entries.push({
      startedDateTime: started.toISOString(),
      time,
      request: {
        method: req.method,
        url: `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`,
        httpVersion: `HTTP/${req.httpVersion}`,
        headers: pairs(req.rawHeaders),
        queryString: [...new URL(req.url ?? "/", "http://x").searchParams].map(([name, value]) => ({ name, value })),
        ...(reqBody.length ? { postData: { mimeType: reqMime, text: reqBody.toString("utf8") } } : {}),
      },
      response: {
        status: ures.statusCode ?? 0,
        statusText: ures.statusMessage ?? "",
        httpVersion: `HTTP/${ures.httpVersion}`,
        headers: pairs(ures.rawHeaders),
        content: content(decode(resBody, ures.headers["content-encoding"] as string | undefined), resMime),
      },
      timings: { send: 0, wait: time, receive: 0 },
    });
    writeHar();
    res.writeHead(ures.statusCode ?? 502, ures.statusMessage, ures.rawHeaders);
    res.end(resBody);
  });
  up.on("error", (e) => {
    console.error(`proxy: ${req.method} ${target}: ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`testcase proxy: no pude conectar con ${upstream.origin}: ${e.message}\n`);
  });
  up.end(reqBody);
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  writeHar();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

server.on("error", (e) => {
  console.error(`proxy: no pude escuchar en el puerto ${listenArg}: ${e.message}`);
  process.exit(1);
});
server.listen(Number(listenArg), "127.0.0.1", () => {
  writeHar();
  const port = (server.address() as AddressInfo).port;
  console.log(`proxy escuchando en http://localhost:${port} → ${upstream.href} · evidencia en ${harFile}`);
});
