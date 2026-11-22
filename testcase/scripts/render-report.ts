#!/usr/bin/env node
/**
 * render-report.ts
 *
 * Lee un reporte JSON de testmania (schema 1.0, ver schema.md) y genera el reporte HTML.
 * El HTML es un solo archivo, sin dependencias externas salvo las fuentes de Google Fonts.
 *
 * Uso:
 *   node render-report.ts <reporte.json> [-o reporte.html] [--template ruta] [--fragment] [--strip-secrets]
 *
 *   -o, --out          Archivo de salida. Por defecto, el mismo nombre del JSON con extensión .html.
 *   --template         Plantilla HTML. Por defecto, ../assets/report.template.html.
 *   --fragment         Escribe solo el contenido de la página, sin <!doctype>, <html>, <head> ni <body>.
 *   --strip-secrets    Quita el mapa `secrets` antes de generar, aunque el JSON lo traiga.
 *
 * Requiere Node 22.6 o superior (ejecuta TypeScript sin compilar). Con Node más antiguo: npx tsx render-report.ts …
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Protocol = "http" | "grpc" | "graphql" | "ws" | "sql";

interface Report {
  $schema: string;
  reportVersion: "1.0";
  tool: { name: "testmania"; version: string };
  run: { id: string; number: number; status: "passed" | "failed" | "error"; secretsIncluded?: boolean; [k: string]: unknown };
  manifest: { path: string; version: string; suite: string; envFiles?: string[] };
  summary: Record<string, unknown>;
  useCases: Array<{ id: string; status: string; requestIds: number[]; [k: string]: unknown }>;
  requests: Array<{ id: number; useCaseId: string; protocol: Protocol; [k: string]: unknown }>;
  services: Array<{ name: string; mode: "provisioned" | "connected"; [k: string]: unknown }>;
  timeline: Array<{ kind: string; startOffsetMs: number; durationMs: number; [k: string]: unknown }>;
  secrets?: Record<string, string>;
}

interface Options {
  input: string;
  out?: string;
  template: string;
  fragment: boolean;
  stripSecrets: boolean;
}

const SUPPORTED_VERSIONS = ["1.0"];
const PLACEHOLDER_JSON = "/*REPORT_JSON*/";
const PLACEHOLDER_TITLE = "{{TITLE}}";

function parseArgs(argv: string[]): Options {
  const here = dirname(fileURLToPath(import.meta.url));
  const opts: Partial<Options> = { template: join(here, "..", "assets", "report.template.html"), fragment: false, stripSecrets: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") opts.out = argv[++i];
    else if (a === "--template") opts.template = argv[++i];
    else if (a === "--fragment") opts.fragment = true;
    else if (a === "--strip-secrets") opts.stripSecrets = true;
    else if (a === "-h" || a === "--help") usage(0);
    else if (a.startsWith("-")) fail(`Opción desconocida: ${a}`);
    else if (!opts.input) opts.input = a;
    else fail(`Sobra el argumento: ${a}`);
  }
  if (!opts.input) usage(1);
  return opts as Options;
}

function usage(code: number): never {
  console.log("Uso: node render-report.ts <reporte.json> [-o reporte.html] [--template ruta] [--fragment] [--strip-secrets]");
  process.exit(code);
}

function fail(msg: string): never {
  console.error(`render-report: ${msg}`);
  process.exit(1);
}

/** Verificación mínima de estructura. Para validar contra el schema completo usa report.schema.json con un validador JSON Schema 2020-12. */
function check(report: Report): string[] {
  const errors: string[] = [];
  if (!SUPPORTED_VERSIONS.includes(report.reportVersion)) errors.push(`reportVersion "${report.reportVersion}" no soportada (se espera ${SUPPORTED_VERSIONS.join(", ")})`);
  for (const key of ["tool", "run", "manifest", "summary"] as const) if (typeof report[key] !== "object" || report[key] === null) errors.push(`falta el objeto "${key}"`);
  for (const key of ["useCases", "requests", "services", "timeline"] as const) if (!Array.isArray(report[key])) errors.push(`"${key}" debe ser un arreglo`);
  if (errors.length) return errors;

  const ucIds = new Set(report.useCases.map((u) => u.id));
  const reqIds = new Set<number>();
  for (const r of report.requests) {
    if (reqIds.has(r.id)) errors.push(`request ${r.id} está repetido`);
    reqIds.add(r.id);
    if (!ucIds.has(r.useCaseId)) errors.push(`request ${r.id} apunta a un caso de uso que no existe (${r.useCaseId})`);
  }
  for (const u of report.useCases) {
    for (const id of u.requestIds) if (!reqIds.has(id)) errors.push(`${u.id} apunta al request ${id}, que no existe`);
    if (u.status === "failed" && !u.failure) errors.push(`${u.id} está fallido pero no trae "failure"`);
  }
  const serviceNames = new Set(report.services.map((s) => s.name));
  for (const r of report.requests) {
    for (const name of (r.services as string[]) ?? []) if (!serviceNames.has(name)) errors.push(`request ${r.id} usa el servicio "${name}", que no está en "services"`);
  }
  return errors;
}

/** JSON seguro para incrustar dentro de <script type="application/json">. */
function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function render(report: Report, template: string, fragment: boolean): string {
  if (!template.includes(PLACEHOLDER_JSON)) fail(`la plantilla no tiene el marcador ${PLACEHOLDER_JSON}`);
  const title = `Reporte testmania ${report.manifest.suite} #${report.run.number}`;
  const page = template
    .replace(PLACEHOLDER_TITLE, () => escapeHtml(title))
    .replace(PLACEHOLDER_JSON, () => embedJson(report));
  if (fragment) return page;
  return [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="generator" content="testmania render-report">',
    "<style>body{margin:0}[hidden]{display:none!important}</style>",
    "</head>",
    "<body>",
    page,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const inputPath = resolve(opts.input);

  let report: Report;
  try {
    report = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (e) {
    fail(`no pude leer ${opts.input} como JSON: ${(e as Error).message}`);
  }

  const errors = check(report);
  if (errors.length) fail(`el reporte no es válido:\n  - ${errors.join("\n  - ")}`);

  if (opts.stripSecrets && report.secrets) {
    delete report.secrets;
    report.run.secretsIncluded = false;
  }

  let template: string;
  try {
    template = readFileSync(resolve(opts.template), "utf8");
  } catch {
    fail(`no encontré la plantilla en ${opts.template}`);
  }

  const out = resolve(opts.out ?? join(dirname(inputPath), basename(inputPath, extname(inputPath)) + ".html"));
  writeFileSync(out, render(report, template, opts.fragment));

  const s = report.summary as { useCases: { total: number; failed: number }; requests: { total: number } };
  const secrets = report.secrets ? Object.keys(report.secrets).length : 0;
  console.log(
    `Reporte generado: ${out}\n` +
      `  ${s.useCases.total} casos de uso (${s.useCases.failed} fallidos) · ${s.requests.total} requests · ` +
      (secrets ? `${secrets} valores sensibles incluidos` : "sin valores sensibles"),
  );
}

main();
