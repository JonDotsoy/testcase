/**
 * @jondotsoy/testcase-view-report
 *
 * Genera el reporte HTML de testcase a partir de un report.json. El HTML es un solo archivo, con los datos del
 * reporte incrustados y sin dependencias externas salvo las fuentes de Google Fonts.
 *
 *   import { renderHTML } from "@jondotsoy/testcase-view-report";
 *   const html = await renderHTML(report);
 */
import { readFile } from "node:fs/promises";
import { parseReport, type Report } from "@jondotsoy/testcase-report-dto";

export type { Report } from "@jondotsoy/testcase-report-dto";
export { ReportValidationError } from "@jondotsoy/testcase-report-dto";

export interface RenderOptions {
  /**
   * Solo el contenido de la página, sin `<!doctype>`, `<html>`, `<head>` ni `<body>`, para incrustarlo en otra página.
   * Por defecto, `false`.
   */
  fragment?: boolean;
  /**
   * Copia para compartir: quita el mapa `secrets` y oculta sus valores en todo el reporte (URL, anotaciones,
   * aserciones). Sin esta opción, el HTML trae los valores reales ocultos tras el botón "Mostrar valores sensibles".
   * Por defecto, `false`.
   */
  stripSecrets?: boolean;
  /** Título de la página. Por defecto, `Reporte testmania <suite> #<número>`. */
  title?: string;
}

const PLACEHOLDER_JSON = "/*REPORT_JSON*/";
const PLACEHOLDER_TITLE = "{{TITLE}}";
const TEMPLATE_URL = new URL("./assets/report.template.html", import.meta.url);

let templateCache: Promise<string> | undefined;
const loadTemplate = () => (templateCache ??= readFile(TEMPLATE_URL, "utf8"));

/** JSON seguro para incrustar dentro de `<script type="application/json">`. */
function embedJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Quita `secrets` y reemplaza sus valores por "••••" en todo el reporte. No modifica el reporte original. */
export function stripSecrets(report: Report): Report {
  const values = Object.values(report.secrets ?? {}).filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
  const mask = (v: unknown): unknown =>
    typeof v === "string"
      ? values.reduce((acc, x) => acc.split(x).join("••••"), v)
      : Array.isArray(v)
        ? v.map(mask)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]))
          : v;
  const { secrets: _secrets, ...rest } = report;
  const out = mask(rest) as Report;
  out.run = { ...out.run, secretsIncluded: false };
  return out;
}

/**
 * Genera el reporte HTML. Valida el reporte antes (estructura y referencias) y lanza
 * {@link ReportValidationError} con la lista de problemas si no es válido.
 */
export async function renderHTML(report: Report, options: RenderOptions = {}): Promise<string> {
  let data = parseReport(report);
  if (options.stripSecrets) data = stripSecrets(data);
  const template = await loadTemplate();
  if (!template.includes(PLACEHOLDER_JSON)) throw new Error(`La plantilla no tiene el marcador ${PLACEHOLDER_JSON}`);
  const title = options.title ?? `Reporte testmania ${data.manifest.suite} #${data.run.number}`;
  const page = template.replace(PLACEHOLDER_TITLE, () => escapeHtml(title)).replace(PLACEHOLDER_JSON, () => embedJson(data));
  if (options.fragment) return page;
  return [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="generator" content="@jondotsoy/testcase-view-report">',
    "<style>body{margin:0}[hidden]{display:none!important}</style>",
    "</head>",
    "<body>",
    page,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
