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
 *   x-testcase-annotations: {"usuario":"…","paso":"when"}   (opcional: anotaciones, en JSON o b64:<base64url del JSON>)
 * Los casos escritos con el espacio de trabajo de Playwright (run.ts) agregan además x-testcase-step y x-testcase-request,
 * que sirven para unir cada request con las aserciones de `run-assertions.json`, y x-testcase-run con el id de la corrida.
 *
 * Uso:
 *   node import-har.ts <reporte.json> <evidencia.har> --service <nombre> [--assertions run-assertions.json] [--include-secrets]
 *
 *   --service          Servicio `connected` del reporte al que apunta el proxy. Su `endpoint` es la URL real.
 *   --assertions       Aserciones que escribió run.ts. Por defecto, run-assertions.json junto al reporte, si existe.
 *   --include-secrets  Guarda los valores sensibles en `secrets`. Por defecto solo se guardan enmascarados.
 *
 * Se omiten las entradas de otras corridas (por x-testcase-run o, sin ese header, por ser anteriores a run.startedAt) y los archivos estáticos del navegador
 * (CSS, JavaScript, imágenes y fuentes).
 *
 * Las entradas ya importadas (mismo archivo y mismo índice) se omiten, así que se puede correr más de una vez.
 * Las aserciones no se importan: el agente las agrega después y corre sync-report.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, dirname } from "node:path";

type Json = any;

const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-service-token", "x-auth-token"]);
const SENSITIVE_FIELD = /^(password|pass|passwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key)$/i;
const HOP_HEADERS = new Set(["x-testcase-run", "x-testcase-uc", "x-testcase-annotations", "x-testcase-step", "x-testcase-request"]);
const STATIC_MIME = /(text\/css|javascript|^image\/|^font\/|x-icon|wasm)/i;
const STATIC_EXT = /\.(css|m?js|map|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf)(\?|$)/i;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--service", "--assertions"].includes(args[i - 1])));
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

// Valores declarados con sensitive() en los casos (run-sensitive.json, de la misma corrida).
let sensitiveList: string[] = [];
try {
  const rs = JSON.parse(readFileSync(resolve(dirname(reportPath), "run-sensitive.json"), "utf8"));
  if (rs.runId === report.run.id) sensitiveList = (rs.values as string[]).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
} catch {
  /* sin valores sensibles declarados */
}
const hasSensitive = (t: string) => sensitiveList.some((v) => t.includes(v));
const maskText = (t: string) => sensitiveList.reduce((acc, v) => acc.split(v).join("••••"), t);

function maskHeader(name: string, value: string) {
  if (!SENSITIVE_HEADERS.has(name)) {
    if (typeof value === "string" && hasSensitive(value)) return { name, value: maskText(value), sensitive: true, secretRef: secretRef(value) };
    return { name, value };
  }
  const masked = /^bearer /i.test(value) ? "Bearer ••••" : name === "set-cookie" ? value.replace(/=([^;]*)/, "=••••") : "••••";
  return { name, value: masked, sensitive: true, secretRef: secretRef(value) };
}

function redact(value: Json, path = "$", out: Json[] = []): Json {
  if (Array.isArray(value)) return value.map((v, i) => redact(v, `${path}.${i}`, out));
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
  if (typeof value === "string" && hasSensitive(value)) {
    out.push({ path, secretRef: secretRef(value) });
    return maskText(value);
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
  if (hasSensitive(raw)) return { encoding: "text", contentType: mime, value: maskText(raw), redactions: [{ path: "$", secretRef: secretRef(raw) }] };
  return { encoding: "text", contentType: mime, value: raw };
}

function parseAnnotations(v: string | undefined): Record<string, string> {
  if (!v) return {};
  if (v.startsWith("b64:")) v = Buffer.from(v.slice(4), "base64url").toString("utf8");
  try {
    return JSON.parse(v);
  } catch {
    // Formato alternativo: clave=valor; clave=valor
    return Object.fromEntries(v.split(";").map((p) => p.split("=").map((s) => s.trim())).filter((p) => p[0]));
  }
}

// Aserciones de run.ts
const assertionsPath = resolve(flag("--assertions") ?? resolve(dirname(reportPath), "run-assertions.json"));
let runChecks: Json[] = [];
let runNotations: Json[] = [];
try {
  const ra = JSON.parse(readFileSync(assertionsPath, "utf8"));
  if (ra.runId === report.run.id) {
    runChecks = ra.cases.flatMap((c: Json) => c.checks.map((k: Json) => ({ ...k, uc: c.id })));
    runNotations = ra.cases.flatMap((c: Json) => (c.notations ?? []).map((n: Json) => ({ ...n, uc: c.id })));
  }
  else console.log(`Aviso: ${assertionsPath} es de la corrida ${ra.runId} y el reporte está en ${report.run.id}. No se importan aserciones.`);
} catch {
  /* sin aserciones de run.ts */
}
const byRequestTag = new Map<string, Json>();
const lastByStepTag = new Map<string, Json>();

let imported = 0;
const skipped: string[] = [];
(har.log?.entries ?? []).forEach((e: Json, index: number) => {
  if (already.has(index)) return;
  const reqHeaders: Json[] = e.request.headers.map((h: Json) => ({ name: h.name.toLowerCase(), value: h.value }));
  const uc = reqHeaders.find((h) => h.name === "x-testcase-uc")?.value;
  if (!uc) return void skipped.push(`entrada ${index}: sin header x-testcase-uc`);
  if (!ucIds.has(uc)) return void skipped.push(`entrada ${index}: el caso ${uc} no existe en el reporte`);
  const entryRun = reqHeaders.find((h) => h.name === "x-testcase-run")?.value;
  if (entryRun ? entryRun !== report.run.id : Date.parse(e.startedDateTime) < runStart - 1000) return void skipped.push(`entrada ${index}: es de una corrida anterior`);
  if (STATIC_MIME.test(e.response.content?.mimeType ?? "") || STATIC_EXT.test(new URL(e.request.url).pathname)) return void skipped.push(`entrada ${index}: archivo estático`);
  const requestTag = reqHeaders.find((h) => h.name === "x-testcase-request")?.value;
  const stepTag = reqHeaders.find((h) => h.name === "x-testcase-step")?.value;
  const annotations = Object.fromEntries(
    Object.entries(parseAnnotations(reqHeaders.find((h) => h.name === "x-testcase-annotations")?.value)).map(([k, v]) => [k, typeof v === "string" ? maskText(v) : v]),
  );

  const proxied = new URL(e.request.url);
  const target = maskText(proxied.pathname + proxied.search);
  const url = maskText(new URL(proxied.pathname + proxied.search, upstream).toString());
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
  const curlBody = e.request.postData?.text ? ` \\\n  -d '${maskText(typeof reqBody.value === "string" ? reqBody.value : JSON.stringify(reqBody.value)).replace(/'/g, "'\\''")}'` : "";

  const record: Json = {
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
  };
  report.requests.push(record);
  if (requestTag) byRequestTag.set(requestTag, record);
  if (stepTag) lastByStepTag.set(stepTag, record);
  imported++;
});

// Une las aserciones con los requests importados
let attached = 0;
const orphan: string[] = [];
for (const c of runChecks) {
  const target = c.tagKind === "request" ? byRequestTag.get(c.tag) ?? lastByStepTag.get(c.tag) : lastByStepTag.get(c.tag);
  if (!target) {
    orphan.push(`${c.uc}: ${c.expression}`);
    continue;
  }
  const a: Json = { id: `r${target.id}.a${target.assertions.length + 1}`, expression: c.expression, passed: c.passed };
  if (c.expectedFailure) a.expectedFailure = true;
  if (!c.passed) {
    a.expected = c.expected;
    a.actual = c.actual;
  }
  target.assertions.push(a);
  attached++;
}

// Anotaciones definidas con notation() después de un request: se suman a ese request
let notationsAttached = 0;
for (const n of runNotations) {
  const target = byRequestTag.get(n.tag);
  if (!target) {
    orphan.push(`${n.uc}: notation("${n.name}")`);
    continue;
  }
  target.annotations = { ...(target.annotations ?? {}), [n.name]: n.value };
  notationsAttached++;
}

if (!includeSecrets && Object.keys(report.secrets).length === 0) delete report.secrets;
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`Importados ${imported} requests desde ${harFile} al servicio ${serviceName}.`);
if (skipped.length) console.log(`Omitidas ${skipped.length} entradas:\n  - ${skipped.join("\n  - ")}`);
if (runChecks.length) console.log(`Aserciones unidas a sus requests: ${attached} de ${runChecks.length}.`);
if (runNotations.length) console.log(`Anotaciones unidas a sus requests: ${notationsAttached} de ${runNotations.length}.`);
if (orphan.length) console.log(`Aserciones o anotaciones sin request en esta evidencia (¿otro servicio o el proxy no las capturó?):\n  - ${orphan.join("\n  - ")}`);
console.log(runChecks.length ? "Ahora corre sync-report.ts." : "Agrega las aserciones de cada request y corre sync-report.ts.");
