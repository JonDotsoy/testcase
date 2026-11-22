/**
 * run.ts
 *
 * Ejecuta los casos de uso de `cases/*.case.ts` (escritos con defineCase(() => { title(); given(); when(); then(); })) con Playwright y prepara el reporte para importar la evidencia.
 *
 * Uso (desde el espacio de trabajo temporal):
 *   node run.ts --report /ruta/al/proyecto/.testcase/report.json [--only UC-01,UC-03] [--headed]
 *
 * Qué hace:
 *   1. Abre una corrida nueva en el reporte: incrementa run.number, fija run.startedAt y vacía los requests.
 *   2. Crea o actualiza cada caso de uso en `useCases` a partir de su script.
 *   3. Copia los scripts a `<carpeta del reporte>/cases/` para que el reporte apunte a ellos.
 *   4. Corre cada caso. Los requests salen por el proxy del servicio (`services[].proxy.listen`).
 *   5. Escribe las aserciones en `<carpeta del reporte>/run-assertions.json`.
 *
 * Después: detén los proxies (escriben el HAR), corre import-har.ts, sync-report.ts y render-report.ts.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CaseAbort, createContext, type CaseDefinition, type RecordedCheck, type ServiceTarget } from "./testcase.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const reportArg = opt("--report");
if (!reportArg) {
  console.log("Uso: node run.ts --report <.testcase/report.json> [--only UC-01,UC-02] [--headed]");
  process.exit(1);
}
const only = opt("--only")?.split(",").map((s) => s.trim());
const headed = args.includes("--headed");

const reportPath = resolve(reportArg);
const reportDir = dirname(reportPath);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const here = dirname(new URL(import.meta.url).pathname);
const casesDir = join(here, "cases");

let playwright: typeof import("playwright");
try {
  playwright = await import("playwright");
} catch {
  console.error("No encontré Playwright. En el espacio de trabajo corre: bun install (o npm install) y luego bunx playwright install chromium");
  process.exit(1);
}

// Servicios: siempre a través del proxy si existe.
const services = new Map<string, ServiceTarget>();
for (const s of report.services ?? []) {
  const listen = s.proxy?.listen;
  const base = listen ?? s.endpoint;
  if (!listen && s.mode === "connected") console.warn(`Aviso: el servicio "${s.name}" no tiene proxy. Sus requests no quedarán como evidencia.`);
  services.set(s.name, { name: s.name, baseURL: /^https?:\/\//.test(base) ? base.replace(/\/?$/, "/") : `http://${base}/`, viaProxy: !!listen });
}

// Casos
const files = existsSync(casesDir) ? readdirSync(casesDir).filter((f) => f.endsWith(".case.ts")).sort() : [];
if (!files.length) {
  console.error(`No hay casos en ${casesDir}. Escribe un archivo <UC-NN>.case.ts por caso de uso.`);
  process.exit(1);
}
const defs: Array<{ def: CaseDefinition; file: string }> = [];
for (const f of files) {
  let mod: any;
  try {
    mod = await import(pathToFileURL(join(casesDir, f)).href);
  } catch (e) {
    console.error(`${f}: ${(e as Error).message}`);
    process.exit(1);
  }
  const def: CaseDefinition = mod.default;
  if (!def || typeof def.run !== "function" || !Array.isArray(def.steps)) {
    console.error(`${f} no exporta un caso válido. Usa: export default defineCase(() => { title(…); given(…, async (t) => …); when(…); then(…); })`);
    process.exit(1);
  }
  def.id ||= /^(UC-\d+)/i.exec(f)?.[1]?.toUpperCase() ?? "";
  if (!def.id) {
    console.error(`${f}: no tiene id. Nombra el archivo UC-NN.case.ts o declara id("UC-NN") dentro de defineCase().`);
    process.exit(1);
  }
  defs.push({ def, file: f });
}
const ids = defs.map((d) => d.def.id);
const dup = ids.find((id, i) => ids.indexOf(id) !== i);
if (dup) {
  console.error(`El id ${dup} está repetido en más de un caso.`);
  process.exit(1);
}

// Nueva corrida
const startedAt = new Date();
report.run.number = (report.run.number ?? 0) + 1;
report.run.id = `run_${report.run.number}`;
report.run.startedAt = startedAt.toISOString();
report.run.command = `testcase run.ts${only ? " --only " + only.join(",") : ""}`;
report.requests = [];
report.timeline = (report.timeline ?? []).filter((t: any) => t.kind !== "request");
mkdirSync(join(reportDir, "cases"), { recursive: true });

for (const { def, file } of defs) {
  copyFileSync(join(casesDir, file), join(reportDir, "cases", file));
  const uc = (report.useCases ??= []).find((u: any) => u.id === def.id) ?? (report.useCases.push({ id: def.id }), report.useCases.at(-1));
  Object.assign(uc, {
    title: def.title,
    given: def.given,
    when: def.when,
    then: def.then,
    handler: { file: `cases/${file}` },
    requestIds: uc.requestIds ?? [],
    invocations: uc.invocations ?? [],
    status: uc.status ?? "pending",
  });
  delete uc.failure;
  delete uc.pending;
}
report.useCases.sort((a: any, b: any) => a.id.localeCompare(b.id, "es", { numeric: true }));

let browser: import("playwright").Browser | undefined;
const getBrowser = async () => (browser ??= await playwright.chromium.launch({ headless: !headed }));
const newApi = (baseURL: string) => playwright.request.newContext({ baseURL, ignoreHTTPSErrors: true });

const results: Array<{ id: string; file: string; durationMs: number; error?: string; requestTags: string[]; checks: RecordedCheck[] }> = [];
for (const { def, file } of defs) {
  if (only && !only.includes(def.id)) continue;
  const checks: RecordedCheck[] = [];
  const requestTags: string[] = [];
  const { t, close, lastTag } = createContext({ def, services, newApi, getBrowser, checks, requestTags });
  const t0 = Date.now();
  let error: string | undefined;
  try {
    await def.run(t);
  } catch (e) {
    error = e instanceof CaseAbort ? e.message : `El caso terminó con un error: ${(e as Error).message}`;
    if (!(e instanceof CaseAbort)) {
      checks.push({ tag: lastTag(), tagKind: requestTags.length ? "request" : "step", expression: "el caso termina sin errores", passed: false, expected: "sin errores", actual: (e as Error).message });
    }
  } finally {
    await close();
  }
  const uc = report.useCases.find((u: any) => u.id === def.id);
  if (error && !requestTags.length) uc.pending = { reason: "skipped", message: error };
  results.push({ id: def.id, file, durationMs: Date.now() - t0, error, requestTags, checks });
  const failed = checks.filter((c) => !c.passed).length;
  console.log(`${def.id} ${def.title}: ${checks.length - failed}/${checks.length} aserciones ok${error ? " · " + error : ""}`);
}
await browser?.close();

writeFileSync(join(reportDir, "run-assertions.json"), JSON.stringify({ runId: report.run.id, startedAt: report.run.startedAt, finishedAt: new Date().toISOString(), cases: results }, null, 2) + "\n");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`\nCorrida ${report.run.id} lista. Ahora: detén los proxies, importa los HAR (import-har.ts), sincroniza y genera el HTML.`);
console.log(`Aserciones en ${join(reportDir, "run-assertions.json")} · scripts copiados a ${join(reportDir, "cases")}/ (${basename(casesDir)})`);
