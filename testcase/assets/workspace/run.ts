/**
 * run.ts
 *
 * Ejecuta los casos de uso de `cases/*.case.ts` (escritos con defineCase(() => { title(); given(); when(); then(); })) con Playwright y prepara el reporte para importar la evidencia.
 *
 * Uso (desde el espacio de trabajo temporal):
 *   node run.ts --report /ruta/al/proyecto/.testcase/report.json --plan     # servicios: reporte + comandos de Podman
 *   node run.ts --report /ruta/al/proyecto/.testcase/report.json [--only UC-01,UC-03] [--headed]
 *
 * --plan: pasa al reporte los servicios declarados con defineService, asigna puertos y proxies de evidencia,
 * e imprime un script de Podman para levantarlos y otro para detenerlos. No corre los casos.
 *
 * Sin --plan:
 *   0. Pasa al reporte los servicios declarados con defineService (sin tocar health, proxy ni artefactos aplicados).
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
import { CaseAbort, createContext, declaredServices, type CaseDefinition, type RecordedCheck, type RecordedNotation, type ServiceDefinition, type ServiceTarget } from "./testcase.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const reportArg = opt("--report");
if (!reportArg) {
  console.log("Uso: node run.ts --report <.testcase/report.json> [--plan] [--only UC-01,UC-02] [--headed]");
  process.exit(1);
}
const only = opt("--only")?.split(",").map((s) => s.trim());
const headed = args.includes("--headed");
const plan = args.includes("--plan");

const reportPath = resolve(reportArg);
const reportDir = dirname(reportPath);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const here = dirname(new URL(import.meta.url).pathname);
const casesDir = join(here, "cases");

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

// Servicios declarados con defineService → report.services
const PROXY_IMAGE = "docker.io/mitmproxy/mitmproxy:11.0.2";
const NETWORK = "testcase";
report.services ??= [];
const declared = declaredServices();
const usedPorts = new Set<number>(report.services.flatMap((s: any) => (s.ports ?? []).map((p: any) => p.host)));
const nextPort = (from: number) => {
  let p = from;
  while (usedPorts.has(p)) p++;
  usedPorts.add(p);
  return p;
};
const isHttp = (d: ServiceDefinition) => "endpoint" in d || !!(d as any).http;
for (const d of declared) {
  let s = report.services.find((x: any) => x.name === d.name);
  if (!s) report.services.push((s = { name: d.name }));
  if ("endpoint" in d) {
    if (s.mode === "provisioned") for (const k of ["image", "ports", "env", "dependsOn", "storage", "readyMs", "artifacts"]) delete s[k];
    Object.assign(s, { mode: "connected", host: new URL(d.endpoint).host, endpoint: d.endpoint });
    if (d.version) s.version = d.version;
  } else {
    if (s.mode === "connected") for (const k of ["host", "version", "tls"]) delete s[k];
    const prevPorts: any[] = s.ports ?? [];
    const ports = (d.ports ?? []).map((p) => ({
      host: p.host ?? prevPorts.find((x) => x.container === p.container)?.host ?? nextPort(55000),
      container: p.container,
      ...(p.protocol ? { protocol: p.protocol } : {}),
    }));
    Object.assign(s, {
      mode: "provisioned",
      image: d.image,
      endpoint: ports.length ? `localhost:${ports[0].host}` : d.name,
      ports,
      env: Object.entries(d.env ?? {}).map(([name, v]) =>
        typeof v === "string" ? { name, source: "manifest", value: v } : { name, source: "manifest", value: "••••", sensitive: true },
      ),
      artifacts: s.artifacts ?? [],
    });
    const deps = (d.dependsOn ?? []).map((x) => (typeof x === "string" ? x : x.name));
    if (deps.length) s.dependsOn = deps;
    else delete s.dependsOn;
    if (d.storage) s.storage = d.storage;
  }
  s.requestCount ??= 0;
}
for (const d of declared) {
  for (const dep of (d as any).dependsOn ?? []) {
    const name = typeof dep === "string" ? dep : dep.name;
    if (!report.services.some((x: any) => x.name === name)) {
      console.error(`El servicio "${d.name}" depende de "${name}", que no está declarado.`);
      process.exit(1);
    }
  }
}

if (plan) {
  const sh = (v: string) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  const evidenceDir = join(reportDir, "evidence");
  const usedProxy = new Set<number>(
    report.services.map((s: any) => s.proxy?.listen).filter(Boolean).map((l: string) => Number(new URL(l).port)),
  );
  const order: ServiceDefinition[] = [];
  const visit = (d: ServiceDefinition, seen: string[] = []) => {
    if (order.includes(d)) return;
    if (seen.includes(d.name)) throw new Error(`Dependencia circular: ${[...seen, d.name].join(" → ")}`);
    for (const dep of (d as any).dependsOn ?? []) {
      const dd = declared.find((x) => x.name === (typeof dep === "string" ? dep : dep.name));
      if (dd) visit(dd, [...seen, d.name]);
    }
    order.push(d);
  };
  declared.forEach((d) => visit(d));

  const up: string[] = ["set -eu", `mkdir -p ${sh(evidenceDir)}`, `podman network exists ${NETWORK} || podman network create ${NETWORK}`];
  const down: string[] = [];
  const downServices: string[] = [];
  const pending: string[] = [];
  for (const d of order) {
    const s = report.services.find((x: any) => x.name === d.name);
    if (!("endpoint" in d)) {
      const env = Object.entries(d.env ?? {}).flatMap(([k, v]) => ["-e", typeof v === "string" ? sh(`${k}=${v}`) : `${k}="$${v.fromEnv}"`]);
      const ports = s.ports.flatMap((p: any) => ["-p", `${p.host}:${p.container}`]);
      up.push("", `# ${d.name}`, ["podman run -d --rm", `--name tc-${d.name}`, `--network ${NETWORK}`, `--network-alias ${d.name}`, ...ports, ...env, sh(d.image)].join(" "));
      downServices.unshift(`podman stop tc-${d.name}`);
      if (d.storage === "tmpfs") pending.push(`${d.name}: storage tmpfs, agrega --tmpfs <directorio de datos de la imagen> al podman run`);
      for (const a of d.artifacts ?? []) pending.push(`${d.name}: aplicar ${a.kind} ${a.source}`);
      if (d.health) pending.push(`${d.name}: healthcheck ${d.health}`);
      if (isHttp(d) && !s.ports.length) throw new Error(`El servicio "${d.name}" es http pero no declara ports.`);
    }
    if (isHttp(d)) {
      let listenPort = s.proxy?.listen ? Number(new URL(s.proxy.listen).port) : 18080;
      if (!s.proxy?.listen) {
        while (usedProxy.has(listenPort)) listenPort++;
        usedProxy.add(listenPort);
      }
      const upstream = "endpoint" in d ? new URL(d.endpoint).origin : `http://${d.name}:${s.ports[0].container}`;
      s.proxy = {
        engine: "podman",
        image: PROXY_IMAGE,
        container: `tc-proxy-${d.name}`,
        listen: `http://localhost:${listenPort}`,
        upstream,
        evidence: `evidence/${d.name}.har`,
      };
      up.push(
        "",
        `# proxy de evidencia de ${d.name}`,
        [
          "podman run -d --rm",
          `--name tc-proxy-${d.name}`,
          `--network ${NETWORK}`,
          `-p ${listenPort}:8080`,
          `-v ${sh(evidenceDir + ":/evidence:Z")}`,
          PROXY_IMAGE,
          `mitmdump --mode reverse:${upstream} --listen-port 8080 --set hardump=/evidence/${d.name}.har`,
        ].join(" "),
      );
      down.push(`podman stop tc-proxy-${d.name}   # escribe evidence/${d.name}.har`);
      if ("endpoint" in d && d.health) pending.push(`${d.name}: healthcheck ${d.health} (a través del proxy)`);
    }
  }
  down.push(...downServices, `podman network ${"rm"} ${NETWORK}`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log("# Levantar servicios y proxies");
  console.log(up.join("\n"));
  console.log("\n# Detener (después de correr los casos; los proxies primero, así escriben el HAR)");
  console.log(down.join("\n"));
  if (pending.length) console.log("\n# Pendiente para el agente: registra en el reporte el resultado real de cada uno\n" + pending.map((p) => "#   " + p).join("\n"));
  process.exit(0);
}

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
  const listen: string | undefined = s.proxy?.listen;
  // Un servicio conectado con ruta base (https://x.example.com/sandbox) conserva esa ruta detrás del proxy.
  const basePath = s.mode === "connected" && /^https?:\/\//.test(s.endpoint) ? new URL(s.endpoint).pathname : "/";
  const base = listen ? new URL(basePath, listen).toString() : s.endpoint;
  if (!listen && (s.mode === "connected" || declared.some((d) => d.name === s.name && isHttp(d)))) {
    console.warn(`Aviso: el servicio "${s.name}" no tiene proxy. Sus requests no quedarán como evidencia. Corre antes run.ts --plan.`);
  }
  services.set(s.name, { name: s.name, baseURL: /^https?:\/\//.test(base) ? base.replace(/\/?$/, "/") : `http://${base}/`, viaProxy: !!listen });
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

const results: Array<{ id: string; file: string; durationMs: number; error?: string; requestTags: string[]; checks: RecordedCheck[]; notations: RecordedNotation[] }> = [];
for (const { def, file } of defs) {
  if (only && !only.includes(def.id)) continue;
  const checks: RecordedCheck[] = [];
  const notations: RecordedNotation[] = [];
  const requestTags: string[] = [];
  const { t, close, lastTag } = createContext({ def, services, newApi, getBrowser, checks, notations, requestTags });
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
  results.push({ id: def.id, file, durationMs: Date.now() - t0, error, requestTags, checks, notations });
  const failed = checks.filter((c) => !c.passed).length;
  console.log(`${def.id} ${def.title}: ${checks.length - failed}/${checks.length} aserciones ok${error ? " · " + error : ""}`);
}
await browser?.close();

writeFileSync(join(reportDir, "run-assertions.json"), JSON.stringify({ runId: report.run.id, startedAt: report.run.startedAt, finishedAt: new Date().toISOString(), cases: results }, null, 2) + "\n");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`\nCorrida ${report.run.id} lista. Ahora: detén los proxies, importa los HAR (import-har.ts), sincroniza y genera el HTML.`);
console.log(`Aserciones en ${join(reportDir, "run-assertions.json")} · scripts copiados a ${join(reportDir, "cases")}/ (${basename(casesDir)})`);
