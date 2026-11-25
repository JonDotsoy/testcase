/**
 * @jondotsoy/testcase-report-dto
 *
 * Esquema del reporte de testcase (report.json) en zod, sus tipos y la validación completa: estructura más
 * referencias entre secciones (cada request apunta a un caso que existe, cada caso a requests que existen, etc.).
 *
 *   import { validateReport, type Report } from "@jondotsoy/testcase-report-dto";
 *   const result = validateReport(JSON.parse(text));
 *   if (!result.success) console.error(result.issues.join("\n"));
 */
import { z } from "zod";
import { reportSchema, type Report } from "./schema.ts";

export * from "./schema.ts";

export type ValidationResult = { success: true; report: Report } | { success: false; issues: string[] };

/** Error con la lista de problemas del reporte. Lo lanza {@link parseReport}. */
export class ReportValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`El reporte no es válido:\n  - ${issues.join("\n  - ")}`);
    this.name = "ReportValidationError";
    this.issues = issues;
  }
}

const pathOf = (path: PropertyKey[]) => (path.length ? path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") : "(raíz)");

/** Referencias entre secciones que el esquema por sí solo no puede revisar. */
export function checkReferences(report: Report): string[] {
  const issues: string[] = [];
  const ucIds = new Set(report.useCases.map((u) => u.id));
  const reqIds = new Set<number>();
  const services = new Set(report.services.map((s) => s.name));
  for (const r of report.requests) {
    if (reqIds.has(r.id)) issues.push(`request ${r.id} está repetido`);
    reqIds.add(r.id);
    if (!ucIds.has(r.useCaseId)) issues.push(`request ${r.id} apunta a un caso de uso que no existe (${r.useCaseId})`);
    for (const name of r.services) if (!services.has(name)) issues.push(`request ${r.id} usa el servicio "${name}", que no está en "services"`);
  }
  const seenUc = new Set<string>();
  for (const u of report.useCases) {
    if (seenUc.has(u.id)) issues.push(`${u.id} está repetido`);
    seenUc.add(u.id);
    for (const id of u.requestIds) if (!reqIds.has(id)) issues.push(`${u.id} apunta al request ${id}, que no existe`);
    for (const id of u.failure?.requestIds ?? []) if (!reqIds.has(id)) issues.push(`${u.id}: failure apunta al request ${id}, que no existe`);
  }
  return issues;
}

/** Valida estructura y referencias. No lanza: devuelve el reporte tipado o la lista de problemas. */
export function validateReport(data: unknown): ValidationResult {
  const parsed = reportSchema.safeParse(data);
  if (!parsed.success) return { success: false, issues: parsed.error.issues.map((i) => `${pathOf(i.path)}: ${i.message}`) };
  const issues = checkReferences(parsed.data);
  return issues.length ? { success: false, issues } : { success: true, report: parsed.data };
}

/** Como {@link validateReport}, pero devuelve el reporte o lanza {@link ReportValidationError}. */
export function parseReport(data: unknown): Report {
  const result = validateReport(data);
  if (!result.success) throw new ReportValidationError(result.issues);
  return result.report;
}

/** El esquema como JSON Schema (draft 2020-12), para editores y validadores que no usan zod. */
export function reportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(reportSchema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
}
