/**
 * run.ts
 *
 * Ejecuta los casos de uso de `cases/*.case.ts` (escritos con await defineCase(async () => { await title(); await given(); … })) con Playwright y prepara el reporte para importar la evidencia.
 *
 * Uso (desde el espacio de trabajo temporal):
 *   node run.ts --report /ruta/al/proyecto/.testcase/report.json --plan     # servicios: reporte + compose.yaml
 *   node run.ts --report /ruta/al/proyecto/.testcase/report.json [--only UC-01,UC-03] [--headed]
 *
 * --plan: pasa al reporte los servicios declarados con defineService, asigna puertos y proxies de evidencia,
 * y escribe `<carpeta del reporte>/compose.yaml` (servicios + un proxy mitmdump por servicio HTTP).
 * Los servicios `command` (procesos locales) y los proxies sin contenedor (`--proxy local`) van a `<carpeta del reporte>/local.json`,
 * que levanta y detiene `scripts/local.ts`. Imprime cómo levantar y detener todo. No corre los casos.
 *
 * --proxy local|podman: dónde corren los proxies de evidencia de los servicios conectados y de los contenedores.
 * Por defecto, el que ya tenía el servicio, o podman. Los procesos locales siempre usan un proxy local.
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CaseAbort, createContext, declaredServices, isHttpService, serviceKind, maskSensitive, sensitiveValues, takeDefinedCases, type CaseDefinition, type RecordedCheck, type RecordedNotation, type ProcessServiceDefinition, type ProvisionedServiceDefinition, type ServiceDefinition, type ServiceTarget } from "./testcase.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const reportArg = opt("--report");
if (!reportArg) {
  console.log("Uso: node run.ts --report <.testcase/report.json> [--plan [--proxy local|podman]] [--only UC-01,UC-02] [--headed]");
  process.exit(1);
}
const only = opt("--only")?.split(",").map((s) => s.trim());
const headed = args.includes("--headed");
const plan = args.includes("--plan");
const proxyArg = opt("--proxy");
if (proxyArg && !["local", "podman"].includes(proxyArg)) {
  console.error(`--proxy acepta local o podman, no "${proxyArg}".`);
  process.exit(1);
}

const reportPath = resolve(reportArg);
const reportDir = dirname(reportPath);
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const here = dirname(new URL(import.meta.url).pathname);
const casesDir = join(here, "cases");

// Casos
const files = existsSync(casesDir) ? readdirSync(casesDir).filter((f) => f.endsWith(".case.ts")).sort() : [];
if (!files.length) {
  console.error(`No hay casos en ${casesDir}. Escribe archivos *.case.ts con defineCase().`);
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
  let found: CaseDefinition[];
  try {
    found = await takeDefinedCases();
  } catch (e) {
    console.error(`${f}: ${(e as Error).message}`);
    process.exit(1);
  }
  if (!found.length) {
    console.error(`${f} no define ningún caso. Usa: await defineCase(async () => { await title(…); await given(…); await when(…); await then(…); })`);
    process.exit(1);
  }
  // Un caso solo en el archivo puede tomar el id del nombre (UC-03.case.ts). Con varios, cada uno declara id().
  const fromName = found.length === 1 ? /^(UC-\d+)/i.exec(f)?.[1]?.toUpperCase() : undefined;
  for (const def of found) {
    def.id ||= fromName ?? "";
    if (!def.id) {
      console.error(
        found.length > 1
          ? `${f}: define ${found.length} casos y "${def.title}" no tiene id. Declara id("UC-NN") en cada defineCase().`
          : `${f}: no tiene id. Nombra el archivo UC-NN.case.ts o declara id("UC-NN") dentro de defineCase().`,
      );
      process.exit(1);
    }
    defs.push({ def, file: f });
  }
}
const ids = defs.map((d) => d.def.id);
const dup = ids.find((id, i) => ids.indexOf(id) !== i);
if (dup) {
  console.error(`El id ${dup} está repetido en más de un caso.`);
  process.exit(1);
}

// Servicios declarados con defineService → report.services
const PROXY_IMAGE = "docker.io/mitmproxy/mitmproxy:11.0.2";
report.services ??= [];
const declared = declaredServices();
const usedPorts = new Set<number>(report.services.flatMap((s: any) => (s.ports ?? []).map((p: any) => p.host)));
const nextPort = (from: number) => {
  let p = from;
  while (usedPorts.has(p)) p++;
  usedPorts.add(p);
  return p;
};
const isHttp = isHttpService;
const envEntries = (env: Record<string, any> | undefined) =>
  Object.entries(env ?? {}).map(([name, v]) =>
    typeof v === "string" ? { name, source: "manifest", value: v } : { name, source: "manifest", value: "••••", sensitive: true, fromEnv: v.fromEnv },
  );
for (const d of declared) {
  const kind = serviceKind(d);
  let s = report.services.find((x: any) => x.name === d.name);
  if (!s) report.services.push((s = { name: d.name }));
  if (s.mode && s.mode !== (kind === "connected" ? "connected" : kind)) {
    for (const k of ["host", "version", "tls", "image", "build", "ports", "env", "dependsOn", "storage", "readyMs", "artifacts", "command", "cwd", "port", "process"]) delete s[k];
  }
  if (kind === "connected" && "endpoint" in d) {
    Object.assign(s, { mode: "connected", host: new URL(d.endpoint).host, endpoint: d.endpoint });
    if (d.version) s.version = d.version;
  } else if (kind === "process") {
    const p = d as ProcessServiceDefinition;
    Object.assign(s, {
      mode: "process",
      command: p.command,
      cwd: p.cwd ?? ".",
      endpoint: p.port != null ? `http://localhost:${p.port}` : p.name,
      env: envEntries(p.env),
      artifacts: s.artifacts ?? [],
    });
    if (p.port != null) s.port = p.port;
    else delete s.port;
    const deps = (p.dependsOn ?? []).map((x) => (typeof x === "string" ? x : x.name));
    if (deps.length) s.dependsOn = deps;
    else delete s.dependsOn;
  } else {
    const c = d as ProvisionedServiceDefinition;
    const prevPorts: any[] = s.ports ?? [];
    const ports = (c.ports ?? []).map((p) => ({
      host: p.host ?? prevPorts.find((x) => x.container === p.container)?.host ?? nextPort(55000),
      container: p.container,
      ...(p.protocol ? { protocol: p.protocol } : {}),
    }));
    Object.assign(s, {
      mode: "provisioned",
      image: c.image ?? `localhost/testcase-${c.name}:latest`,
      endpoint: ports.length ? `localhost:${ports[0].host}` : c.name,
      ports,
      env: envEntries(c.env),
      artifacts: s.artifacts ?? [],
    });
    const deps = (c.dependsOn ?? []).map((x) => (typeof x === "string" ? x : x.name));
    if (deps.length) s.dependsOn = deps;
    else delete s.dependsOn;
    const storage = c.storage ?? (c.tmpfs?.length ? "tmpfs" : undefined);
    if (storage) s.storage = storage;
    if (c.build) {
      const b = typeof c.build === "string" ? { context: c.build } : c.build;
      s.build = { context: b.context, ...(b.dockerfile ? { dockerfile: b.dockerfile } : {}) };
    } else delete s.build;
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
  const projectRoot = dirname(reportDir);
  const composePath = join(reportDir, "compose.yaml");
  const localPath = join(reportDir, "local.json");
  const scriptsDir = process.env.TESTCASE_SCRIPTS ?? "<skill>/scripts";
  const order: ServiceDefinition[] = [];
  const visit = (d: ServiceDefinition, seen: string[] = []) => {
    if (order.includes(d)) return;
    if (seen.includes(d.name)) {
      console.error(`Dependencia circular: ${[...seen, d.name].join(" → ")}`);
      process.exit(1);
    }
    for (const dep of (d as any).dependsOn ?? []) {
      const dd = declared.find((x) => x.name === (typeof dep === "string" ? dep : dep.name));
      if (dd) visit(dd, [...seen, d.name]);
    }
    order.push(d);
  };
  declared.forEach((d) => visit(d));
  for (const d of declared) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(d.name)) {
      console.error(`El nombre "${d.name}" no sirve como servicio de compose: usa minúsculas, números, - o _.`);
      process.exit(1);
    }
    if (serviceKind(d) === "provisioned") {
      for (const dep of (d as ProvisionedServiceDefinition).dependsOn ?? []) {
        const dd = declared.find((x) => x.name === (typeof dep === "string" ? dep : dep.name));
        if (dd && serviceKind(dd) === "process") {
          console.error(`El contenedor "${d.name}" depende del proceso local "${dd.name}": compose no puede esperarlo. Declara la dependencia al revés o levanta "${dd.name}" como contenedor.`);
          process.exit(1);
        }
      }
    }
  }

  // Ruta del proyecto → ruta relativa a compose.yaml
  const fromCompose = (p: string) => {
    const r = relative(reportDir, resolve(projectRoot, p));
    return r.startsWith(".") ? r : `./${r}`;
  };
  // En compose, `$` interpola variables: un valor literal lo escapa como `$$`.
  const literal = (v: string) => v.replace(/\$/g, "$$$$");

  // Puertos de los proxies: se conservan entre corridas; uno nuevo salta los ocupados en esta máquina.
  const portFree = (port: number) =>
    new Promise<boolean>((ok) => {
      const srv = createServer();
      srv.once("error", () => ok(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => ok(true)));
    });
  const usedProxy = new Set<number>(
    report.services.map((s: any) => s.proxy?.listen).filter(Boolean).map((l: string) => Number(new URL(l).port)),
  );
  const newProxyPort = async () => {
    let p = 18080;
    while (usedProxy.has(p) || !(await portFree(p))) p++;
    usedProxy.add(p);
    return p;
  };

  const services: Record<string, any> = {};
  const containerProxies: string[] = [];
  const local: { projectRoot: string; services: any[]; proxies: any[] } = { projectRoot: relative(reportDir, projectRoot) || ".", services: [], proxies: [] };
  const pending: string[] = [];
  const envVars = new Set<string>();
  let builds = false;

  for (const d of order) {
    const kind = serviceKind(d);
    const s = report.services.find((x: any) => x.name === d.name);
    if (kind === "provisioned") {
      const c = d as ProvisionedServiceDefinition;
      const svc: Record<string, any> = {};
      if (c.image) svc.image = c.image;
      if (c.build) {
        builds = true;
        const b = typeof c.build === "string" ? { context: c.build } : c.build;
        svc.build = {
          context: fromCompose(b.context),
          ...(b.dockerfile ? { dockerfile: b.dockerfile } : {}),
          ...(b.args ? { args: b.args } : {}),
          ...(b.target ? { target: b.target } : {}),
        };
        svc.image ??= s.image;
      }
      svc.container_name = `tc-${c.name}`;
      if (c.command) svc.command = c.command;
      if (s.ports.length) svc.ports = s.ports.map((p: any) => `${p.host}:${p.container}${p.protocol && p.protocol !== "tcp" ? "/" + p.protocol : ""}`);
      const env = Object.entries(c.env ?? {});
      if (env.length) {
        svc.environment = Object.fromEntries(
          env.map(([k, v]) => {
            if (typeof v === "string") return [k, literal(v)];
            envVars.add(v.fromEnv);
            return [k, `\${${v.fromEnv}:?Falta la variable ${v.fromEnv}}`];
          }),
        );
      }
      if (c.tmpfs?.length) svc.tmpfs = c.tmpfs;
      else if (c.storage === "tmpfs") pending.push(`${c.name}: storage tmpfs sin ruta; declara tmpfs: ["<directorio de datos>"] en defineService`);
      const deps = (c.dependsOn ?? []).map((x) => (typeof x === "string" ? x : x.name));
      if (deps.length) svc.depends_on = deps;
      services[c.name] = svc;
      if (isHttp(d) && !s.ports.length) {
        console.error(`El servicio "${d.name}" es http pero no declara ports.`);
        process.exit(1);
      }
    }
    if (kind === "process") {
      const p = d as ProcessServiceDefinition;
      const env = Object.fromEntries(
        Object.entries(p.env ?? {}).map(([k, v]) => {
          if (typeof v === "string") return [k, v];
          envVars.add(v.fromEnv);
          return [k, { fromEnv: v.fromEnv }];
        }),
      );
      const deps = (p.dependsOn ?? []).map((x) => (typeof x === "string" ? x : x.name));
      local.services.push({
        name: p.name,
        command: p.command,
        cwd: p.cwd ?? ".",
        ...(p.port != null ? { port: p.port } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(deps.length ? { dependsOn: deps } : {}),
        ...(p.health ? { health: p.health } : {}),
        log: `logs/${p.name}.log`,
      });
    }
    for (const a of (d as any).artifacts ?? []) pending.push(`${d.name}: aplicar ${a.kind} ${a.source}`);
    if (d.health && kind !== "connected" && !(kind === "process" && /^(GET|HEAD) \//.test(d.health))) pending.push(`${d.name}: healthcheck ${d.health}`);

    if (isHttp(d)) {
      const engine = kind === "process" ? "local" : proxyArg ?? s.proxy?.engine ?? "podman";
      const listenPort = s.proxy?.listen ? Number(new URL(s.proxy.listen).port) : await newProxyPort();
      const upstream =
        kind === "connected"
          ? new URL((d as any).endpoint).origin
          : kind === "process"
            ? `http://localhost:${(d as ProcessServiceDefinition).port}`
            : engine === "local"
              ? `http://localhost:${s.ports[0].host}`
              : `http://${d.name}:${s.ports[0].container}`;
      const evidence = `evidence/${d.name}.har`;
      if (engine === "local") {
        s.proxy = { engine: "local", listen: `http://127.0.0.1:${listenPort}`, upstream, evidence };
        local.proxies.push({ service: d.name, port: listenPort, upstream, har: evidence, log: `logs/proxy-${d.name}.log` });
      } else {
        const proxyName = `proxy-${d.name}`;
        s.proxy = { engine: "podman", image: PROXY_IMAGE, container: `tc-${proxyName}`, listen: `http://localhost:${listenPort}`, upstream, evidence };
        services[proxyName] = {
          image: PROXY_IMAGE,
          container_name: `tc-${proxyName}`,
          command: ["mitmdump", "--mode", `reverse:${upstream}`, "--listen-port", "8080", "--set", `hardump=/evidence/${d.name}.har`],
          ports: [`${listenPort}:8080`],
          volumes: ["./evidence:/evidence:Z"],
          ...(kind === "connected" ? {} : { depends_on: [d.name] }),
        };
        containerProxies.push(proxyName);
      }
      if (kind === "connected" && d.health) pending.push(`${d.name}: healthcheck ${d.health} (a través de ${s.proxy.listen})`);
    } else delete s.proxy;
  }

  const yaml = (v: any, indent = ""): string => {
    if (Array.isArray(v)) return v.map((x) => `\n${indent}- ${typeof x === "object" && x ? yaml(x, indent + "  ").trimStart() : JSON.stringify(x)}`).join("");
    if (v && typeof v === "object")
      return Object.entries(v)
        .map(([k, x]) => {
          const key = /^[A-Za-z0-9_.-]+$/.test(k) ? k : JSON.stringify(k);
          return x && typeof x === "object" ? `\n${indent}${key}:${yaml(x, indent + "  ")}` : `\n${indent}${key}: ${JSON.stringify(x)}`;
        })
        .join("");
    return " " + JSON.stringify(v);
  };
  mkdirSync(join(reportDir, "evidence"), { recursive: true });
  const hasCompose = Object.keys(services).length > 0;
  const hasLocal = local.services.length + local.proxies.length > 0;
  if (hasCompose) {
    const containers = Object.keys(services).filter((n) => !containerProxies.includes(n));
    const compose =
      `# Generado por run.ts --plan desde los defineService de los casos. No lo edites a mano: cambia los scripts y vuelve a generarlo.\n` +
      `# Servicios: ${containers.join(", ") || "ninguno"}. Proxies de evidencia: ${containerProxies.join(", ") || "ninguno"}.\n` +
      `name: testcase` +
      yaml({ services }) +
      "\n";
    writeFileSync(composePath, compose);
  } else rmSync(composePath, { force: true });
  if (hasLocal) {
    mkdirSync(join(reportDir, "logs"), { recursive: true });
    writeFileSync(
      localPath,
      JSON.stringify({ $comment: "Generado por run.ts --plan: procesos locales y proxies sin contenedor. Lo usa scripts/local.ts. No lo edites a mano.", ...local }, null, 2) + "\n",
    );
  } else rmSync(localPath, { force: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

  const c = `podman compose -f ${composePath}`;
  const l = `node ${scriptsDir}/local.ts`;
  if (hasCompose) console.log(`compose.yaml escrito en ${composePath}`);
  if (hasLocal) console.log(`local.json escrito en ${localPath} (${[...local.services.map((x) => x.name), ...local.proxies.map((x) => "proxy-" + x.service)].join(", ")})`);
  if (!hasCompose && !hasLocal) console.log("No hay servicios que levantar: ningún contenedor, proceso local ni proxy.");
  console.log("");
  if (envVars.size) console.log(`# Variables que deben existir en el entorno: ${[...envVars].join(", ")}\n`);
  if (hasCompose || hasLocal) {
    console.log("# Levantar");
    if (hasCompose) console.log(`${c} up -d${builds ? " --build" : ""}`);
    if (hasLocal) console.log(`${l} up --report ${reportPath}`);
    console.log("");
    console.log(`# Detener, después de correr los casos. Primero los proxies, que escriben el HAR al detenerse:`);
    if (hasLocal) console.log(`${l} down --report ${reportPath}`);
    if (containerProxies.length) console.log(`${c} stop ${containerProxies.join(" ")}`);
    if (hasCompose) console.log(`${c} down`);
    console.log("");
  }
  if (pending.length) console.log("# Pendiente para el agente: registra en el reporte el resultado real de cada uno\n" + pending.map((p) => "#   " + p).join("\n"));
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
  const { t, close, lastTag } = createContext({ def, services, newApi, getBrowser, checks, notations, requestTags, runId: report.run.id });
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
  if (error && !requestTags.length) uc.pending = { reason: "skipped", message: maskSensitive(error) };
  results.push({ id: def.id, file, durationMs: Date.now() - t0, error, requestTags, checks, notations });
  const failed = checks.filter((c) => !c.passed).length;
  console.log(`${def.id} ${def.title}: ${checks.length - failed}/${checks.length} aserciones ok${error ? " · " + maskSensitive(error) : ""}`);
}
await browser?.close();

// Las aserciones y anotaciones quedan con sus valores reales (sirven para validar y reproducir): import-har.ts
// las enmascara si se importa con --no-secrets, y el HTML oculta los valores de sensitive() hasta que se pidan.
for (const r of results) if (r.error) r.error = maskSensitive(r.error);
writeFileSync(join(reportDir, "run-assertions.json"), JSON.stringify({ runId: report.run.id, startedAt: report.run.startedAt, finishedAt: new Date().toISOString(), cases: results }, null, 2) + "\n");
// import-har.ts lee este archivo para marcar esos valores como sensibles en la evidencia. Bórralo al terminar.
const sensitiveFile = join(reportDir, "run-sensitive.json");
writeFileSync(sensitiveFile, JSON.stringify({ runId: report.run.id, values: sensitiveValues() }) + "\n", { mode: 0o600 });
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(`\nCorrida ${report.run.id} lista. Ahora: detén los proxies, importa los HAR (import-har.ts), sincroniza y genera el HTML.`);
console.log(`Aserciones en ${join(reportDir, "run-assertions.json")} · scripts copiados a ${join(reportDir, "cases")}/ (${basename(casesDir)})`);
