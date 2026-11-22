#!/usr/bin/env node
/**
 * import-har.ts
 *
 * Importa al reporte la evidencia que capturó el proxy de un servicio URL (un HAR escrito por mitmdump).
 * Cada request que pasó por el proxy queda en `requests[]` con sus headers, bodies, estado y tiempos reales,
 * y con `evidence` apuntando a la entrada del HAR.
 *
 * El agente marca cada request que envía con dos headers, que el import lee y luego quita de la evidencia:
 *   x-testcase-uc: UC-03                                    (obligatorio: caso de uso)
 *   x-testcase-annotations: {"usuario":"…","paso":"when"}   (opcional: anotaciones, en JSON)
 *
 * Uso:
 *   node import-har.ts <reporte.json> <evidencia.har> --service <nombre> [--include-secrets]
 *
 *   --service          Servicio `connected` del reporte al que apunta el proxy. Su `endpoint` es la URL real.
 *   --include-secrets  Guarda los valores sensibles en `secrets`. Por defecto solo se guardan enmascarados.
 *
 * Las entradas ya importadas (mismo archivo y mismo índice) se omiten, así que se puede correr más de una vez.
 * Las aserciones no se importan: el agente las agrega después y corre sync-report.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, dirname } from "node:path";

type Json = any;

const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-service-token", "x-auth-token"]);
const SENSITIVE_FIELD = /^(password|pass|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key)$/i;
const HOP_HEADERS = new Set(["x-testcase-uc", "x-testcase-annotations"]);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1] === "--service"));
const [reportFile, harFile] = positional;
const serviceName = flag("--service");
const includeSecrets = args.includes("--include-secrets");
if (!reportFile || !harFile || !serviceName) {
  console.log("Uso: node import-har.ts <reporte.json> <evidencia.har> --service <nombre> [--include-secrets]");
  process.exit(1);
}

const reportPath = resolve(reportFile);
const report: Json = JSON.parse(readFileSync(reportPath, "utf8"));
const har: Json = JSON.parse(readFileSync(resolve(harFile), "utf8"));
const evidenceFile = relative(dirname(reportPath), resolve(harFile));

const service = (report.services ?? []).find((s: Json) => s.name === serviceName);
if (!service) fail(`el reporte no tiene un servicio "${serviceName}"`);
const upstream = new URL(service.endpoint);
const runStart = Date.parse(report.run.startedAt);
if (Number.isNaN(runStart)) fail("run.startedAt no es una fecha válida");

report.requests = report.requests ?? [];
report.secrets = report.secrets ?? {};
const ucIds = new Set((report.useCases ?? []).map((u: Json) => u.id));
const already = new Set(report.requests.filter((r: Json) => r.evidence?.file === evidenceFile).map((r: Json) => r.evidence.entry));

let nextId = Math.max(0, ...report.requests.map((r: Json) => r.id)) + 1;
let nextSecret = Math.max(0, ...Object.keys(report.secrets).map((k) => Number(k.slice(4))), ...collectRefs(report)) + 1;
const secretByValue = new Map<string, string>(Object.entries(report.secrets as Record<string, string>).map(([k, v]) => [v, k]));

function fail(msg: string): never {
  console.error(`import-har: ${msg}`);
  process.exit(1);
}

function collectRefs(o: Json): number[] {
  const out: number[] = [];
  JSON.stringify(o, (k, v) => {
    if (k === "secretRef" && typeof v === "string") out.push(Number(v.slice(4)));
    return v;
  });
  return out;
}

function secretRef(value: string): string {
  const known = secretByValue.get(value);
  if (known) return known;
  const ref = `sec_${nextSecret++}`;
  secretByValue.set(value, ref);
  if (includeSecrets) report.secrets[ref] = value;
  return ref;
}

function maskHeader(name: string, value: string) {
  if (!SENSITIVE_HEADERS.has(name)) return { name, value };
  const masked = /^bearer /i.test(value) ? "Bearer ••••" : name === "set-cookie" ? value.replace(/=([^;]*)/, "=••••") : "••••";
  return { name, value: masked, sensitive: true, secretRef: secretRef(value) };
}

function redact(value: Json, path = "$", out: Json[] = []): Json {
  if (Array.isArray(value)) return value.map((v, i) => redact(v, `${path}[${i}]`, out));
  if (value && typeof value === "object") {
    const o: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_FIELD.test(k) && typeof v === "string") {
        out.push({ path: `${path}.${k}`, secretRef: secretRef(v) });
        o[k] = "••••";
      } else o[k] = redact(v, `${path}.${k}`, out);
    }
    return o;
  }
  return value;
}

function parseBody(text: string | undefined, mime: string | undefined, encoding?: string) {
  if (text == null || text === "") return { encoding: "none", value: null };
  const raw = encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text;
  if (/json/i.test(mime ?? "")) {
    try {
      const redactions: Json[] = [];
      const value = redact(JSON.parse(raw), "$", redactions);
      return { encoding: "json", contentType: mime, value, ...(redactions.length ? { redactions } : {}) };
    } catch {
      /* cae a texto */
    }
  }
  return { encoding: "text", contentType: mime, value: raw };
}

function parseAnnotations(v: string | undefined): Record<string, string> {
  if (!v) return {};
  try {
    return JSON.parse(v);
  } catch {
    // Formato alternativo: clave=valor; clave=valor
    return Object.fromEntries(v.split(";").map((p) => p.split("=").map((s) => s.trim())).filter((p) => p[0]));
  }
}

let imported = 0;
const skipped: string[] = [];
(har.log?.entries ?? []).forEach((e: Json, index: number) => {
  if (already.has(index)) return;
  const reqHeaders: Json[] = e.request.headers.map((h: Json) => ({ name: h.name.toLowerCase(), value: h.value }));
  const uc = reqHeaders.find((h) => h.name === "x-testcase-uc")?.value;
  if (!uc) return void skipped.push(`entrada ${index}: sin header x-testcase-uc`);
  if (!ucIds.has(uc)) return void skipped.push(`entrada ${index}: el caso ${uc} no existe en el reporte`);
  const annotations = parseAnnotations(reqHeaders.find((h) => h.name === "x-testcase-annotations")?.value);

  const proxied = new URL(e.request.url);
  const target = proxied.pathname + proxied.search;
  const url = new URL(target, upstream).toString();
  const reqBody = parseBody(e.request.postData?.text, e.request.postData?.mimeType);
  const resBody = parseBody(e.response.content?.text, e.response.content?.mimeType, e.response.content?.encoding);

  const isGraphql = reqBody.encoding === "json" && typeof reqBody.value?.query === "string";
  const protocol = isGraphql ? "graphql" : "http";
  let method = e.request.method;
  let status: Json = { kind: "http", label: `${e.response.status} ${e.response.statusText}`.trim(), code: e.response.status, reason: e.response.statusText || "" };
  let shownTarget = target;
  if (isGraphql) {
    const q: string = reqBody.value.query;
    method = (q.trim().match(/^(query|mutation|subscription)\b/i)?.[1] ?? "query").toUpperCase();
    shownTarget = reqBody.value.operationName ?? q.trim().match(/^(?:query|mutation|subscription)\s+(\w+)/i)?.[1] ?? "anónima";
    (reqBody as Json).encoding = "graphql";
    const v = resBody.value ?? {};
    const errorCount = Array.isArray(v.errors) ? v.errors.length : 0;
    status = { kind: "graphql", label: `${e.response.status} ${e.response.statusText} · ${errorCount ? "errors" : "data"}`, httpCode: e.response.status, hasData: v.data != null, errorCount };
  }

  const headersOut = reqHeaders.filter((h) => !HOP_HEADERS.has(h.name) && h.name !== "host").map((h) => maskHeader(h.name, h.value));
  const curlHeaders = headersOut
    .filter((h) => !["content-length", "accept-encoding", "user-agent", "connection"].includes(h.name))
    .map((h) => `  -H '${h.name}: ${h.sensitive ? (/^bearer /i.test(h.value) ? "Bearer $TOKEN" : "$SECRET") : h.value}'`);
  const curlBody = e.request.postData?.text ? ` \\\n  -d '${JSON.stringify(reqBody.value).replace(/'/g, "'\\''")}'` : "";

  report.requests.push({
    id: nextId++,
    useCaseId: uc,
    protocol,
    transport: `${e.response.httpVersion || "HTTP/1.1"} vía proxy`,
    method,
    target: shownTarget,
    url,
    services: [serviceName],
    startOffsetMs: Math.max(0, Math.round(Date.parse(e.startedDateTime) - runStart)),
    durationMs: Math.max(0, Math.round(e.time)),
    passed: true,
    handler: { file: "agente" },
    annotations,
    request: { headers: headersOut, body: reqBody },
    response: {
      status,
      headers: e.response.headers.map((h: Json) => maskHeader(h.name.toLowerCase(), h.value)),
      body: resBody,
      ...(e.response.content?.size != null && e.response.content.size >= 0 ? { sizeBytes: e.response.content.size } : {}),
    },
    assertions: [],
    reproduce: { tool: "curl", command: `curl -X ${e.request.method} '${url}' \\\n${curlHeaders.join(" \\\n")}${curlBody}`, env: curlHeaders.some((h) => h.includes("$TOKEN")) ? ["TOKEN"] : [] },
    evidence: { source: "proxy", file: evidenceFile, entry: index },
  });
  imported++;
});

if (!includeSecrets && Object.keys(report.secrets).length === 0) delete report.secrets;
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Importados ${imported} requests desde ${harFile} al servicio ${serviceName}.`);
if (skipped.length) console.log(`Omitidas ${skipped.length} entradas:\n  - ${skipped.join("\n  - ")}`);
console.log("Agrega las aserciones de cada request y corre sync-report.ts.");
