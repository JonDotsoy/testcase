#!/usr/bin/env node
/**
 * local.ts
 *
 * Levanta y detiene lo que corre en esta máquina sin contenedores: los servicios declarados con
 * `defineService({ command, cwd, port })` y los proxies de evidencia locales (scripts/proxy.ts).
 * Lee `<carpeta del reporte>/local.json`, que escribe `cases.ts --plan`.
 *
 * Uso (desde la raíz del proyecto):
 *   node <skill>/scripts/local.ts up --report .testcase/report.json [--timeout 30]
 *   node <skill>/scripts/local.ts status --report .testcase/report.json
 *   node <skill>/scripts/local.ts down --report .testcase/report.json
 *
 * up       Corre cada proceso en su `cwd` (relativo a la raíz del proyecto) con `sh -c <command>`, en orden de
 *          dependencias, y espera a que su puerto acepte conexiones. Después levanta los proxies. Guarda el PID
 *          de cada uno en el reporte (`services[].process.pid`, `services[].proxy.pid`) y en `local.pids.json`.
 *          La salida de cada proceso queda en `.testcase/logs/<nombre>.log`. Si un healthcheck es `GET /ruta`,
 *          lo corre y registra el resultado en `services[].health`. Si algo falla, detiene lo que levantó.
 * status   Muestra cada PID y si sigue vivo. Termina con 1 si alguno se cayó.
 * down     Detiene primero los proxies (escriben el HAR al detenerse) y luego los procesos, en orden inverso.
 *          SIGTERM al grupo del proceso y, si no termina en `--timeout` segundos, SIGKILL.
 *
 * --timeout  Segundos que espera a que un puerto responda o a que un proceso termine. Por defecto 30.
 *
 * Corre con Node 22.6 o superior, o con bun. Sin dependencias.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";

type Json = any;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const command = args[0];
const reportArg = flag("--report");
if (!["up", "down", "status"].includes(command) || !reportArg) {
  console.log("Uso: node local.ts up|status|down --report .testcase/report.json [--timeout 30]");
  process.exit(1);
}
const timeoutMs = Number(flag("--timeout") ?? 30) * 1000;
const reportPath = resolve(reportArg);
const reportDir = dirname(reportPath);
const localPath = join(reportDir, "local.json");
const pidsPath = join(reportDir, "local.pids.json");
const here = dirname(new URL(import.meta.url).pathname);

function fail(msg: string): never {
  console.error(`local: ${msg}`);
  process.exit(1);
}

const readReport = (): Json => JSON.parse(readFileSync(reportPath, "utf8"));
const writeReport = (r: Json) => writeFileSync(reportPath, JSON.stringify(r, null, 2) + "\n");
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

interface Item {
  name: string;
  role: "service" | "proxy";
  pid: number;
  port?: number;
  log: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const socket = connect({ port, host: "localhost", autoSelectFamily: true } as any);
    socket.setTimeout(1000);
    socket.once("connect", () => (socket.destroy(), ok(true)));
    socket.once("error", () => (socket.destroy(), ok(false)));
    socket.once("timeout", () => (socket.destroy(), ok(false)));
  });
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).map((l) => "    " + l).join("\n");
  } catch {
    return "    (sin salida)";
  }
}

/** Corre un comando en su propio grupo de procesos, con la salida en un archivo. */
function start(cmd: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; log: string; shell?: boolean }): number {
  mkdirSync(dirname(opts.log), { recursive: true });
  const fd = openSync(opts.log, "a");
  const child = spawn(cmd, argv, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", fd, fd], shell: opts.shell ?? false });
  closeSync(fd);
  child.unref();
  if (!child.pid) fail(`no pude ejecutar ${cmd}`);
  return child.pid;
}

async function waitReady(item: Item): Promise<string | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!alive(item.pid)) return `${item.name} terminó antes de estar listo. Últimas líneas de ${item.log}:\n${tail(item.log)}`;
    if (item.port == null || (await portOpen(item.port))) return undefined;
    await sleep(150);
  }
  return `${item.name} no abrió el puerto ${item.port} en ${timeoutMs / 1000} s. Últimas líneas de ${item.log}:\n${tail(item.log)}`;
}

async function stopItem(item: Item): Promise<"SIGTERM" | "SIGKILL" | null> {
  if (!alive(item.pid)) return null;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-item.pid, sig); // todo el grupo: sh -c y sus hijos
    } catch {
      try {
        process.kill(item.pid, sig);
      } catch {
        /* ya terminó */
      }
    }
  };
  signal("SIGTERM");
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!alive(item.pid)) return "SIGTERM";
    await sleep(100);
  }
  signal("SIGKILL");
  await sleep(200);
  return "SIGKILL";
}

function healthCheck(port: number, check: string): Promise<Json> {
  const [method, path] = check.split(" ");
  const t0 = performance.now();
  return new Promise((ok) => {
    const req = request({ host: "localhost", port, method, path, timeout: 5000 }, (res) => {
      res.resume();
      res.on("end", () =>
        ok({ check, status: (res.statusCode ?? 500) < 400 ? "healthy" : "unhealthy", durationMs: Math.round(performance.now() - t0) }),
      );
    });
    req.on("timeout", () => (req.destroy(), ok({ check, status: "timeout", durationMs: Math.round(performance.now() - t0) })));
    req.on("error", () => ok({ check, status: "unhealthy", durationMs: Math.round(performance.now() - t0) }));
    req.end();
  });
}

/** Argumentos para correr un .ts con este mismo runtime. */
function tsRuntimeArgs(): string[] {
  if ((process.versions as any).bun) return [];
  const [maj, min] = process.versions.node.split(".").map(Number);
  return maj === 22 && min < 18 ? ["--experimental-strip-types", "--no-warnings"] : [];
}

async function up() {
  if (!existsSync(localPath)) fail(`no existe ${localPath}. Corre antes cases.ts --plan.`);
  if (existsSync(pidsPath)) {
    const prev: Item[] = JSON.parse(readFileSync(pidsPath, "utf8")).items ?? [];
    const running = prev.filter((i) => alive(i.pid));
    if (running.length) fail(`ya hay procesos corriendo (${running.map((i) => `${i.name} pid ${i.pid}`).join(", ")}). Corre antes local.ts down.`);
  }
  const plan = JSON.parse(readFileSync(localPath, "utf8"));
  const projectRoot = resolve(reportDir, plan.projectRoot ?? "..");

  // Variables: se revisan todas antes de levantar nada
  const missing = new Set<string>();
  for (const s of plan.services) for (const v of Object.values<any>(s.env ?? {})) if (typeof v === "object" && process.env[v.fromEnv] == null) missing.add(v.fromEnv);
  if (missing.size) fail(`faltan variables de entorno: ${[...missing].join(", ")}`);

  for (const p of plan.proxies) if (await portOpen(p.port)) fail(`el puerto ${p.port} del proxy de ${p.service} ya está en uso. Libéralo o corre cases.ts --plan otra vez.`);

  const items: Item[] = [];
  const startedAt = new Date().toISOString();
  const report = readReport();
  const svc = (name: string) => report.services.find((s: Json) => s.name === name);
  const abort = async (msg: string) => {
    for (const i of [...items].reverse()) await stopItem(i);
    rmSync(pidsPath, { force: true });
    fail(msg);
  };

  for (const s of plan.services) {
    const cwd = resolve(projectRoot, s.cwd ?? ".");
    if (!existsSync(cwd)) await abort(`la carpeta de ${s.name} no existe: ${cwd}`);
    const env = { ...process.env, ...Object.fromEntries(Object.entries<any>(s.env ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : process.env[v.fromEnv]])) };
    const log = join(reportDir, s.log);
    const t0 = Date.now();
    const pid = start(s.command, [], { cwd, env, log, shell: true });
    const item: Item = { name: s.name, role: "service", pid, port: s.port, log };
    items.push(item);
    writeFileSync(pidsPath, JSON.stringify({ startedAt, items }, null, 2) + "\n");
    const err = await waitReady(item);
    if (err) await abort(err);
    const entry = svc(s.name);
    if (entry) {
      entry.process = { pid, startedAt: new Date(t0).toISOString(), log: s.log };
      entry.readyMs = Date.now() - t0;
      if (s.port != null && /^(GET|HEAD) \//.test(s.health ?? "")) {
        entry.health = await healthCheck(s.port, s.health);
        if (entry.health.status !== "healthy") await abort(`el healthcheck de ${s.name} (${s.health}) respondió ${entry.health.status}.`);
      }
    }
    console.log(`${s.name}: pid ${pid}${s.port != null ? ` · http://localhost:${s.port}` : ""} · listo en ${Date.now() - t0} ms`);
  }

  for (const p of plan.proxies) {
    const log = join(reportDir, p.log);
    const pid = start(process.execPath, [...tsRuntimeArgs(), join(here, "proxy.ts"), "--upstream", p.upstream, "--listen", String(p.port), "--har", join(reportDir, p.har), ...(p.insecure ? ["--insecure"] : []), ...(p.ca ? ["--ca", resolve(projectRoot, p.ca)] : [])], {
      cwd: reportDir,
      env: process.env,
      log,
    });
    const item: Item = { name: `proxy-${p.service}`, role: "proxy", pid, port: p.port, log };
    items.push(item);
    writeFileSync(pidsPath, JSON.stringify({ startedAt, items }, null, 2) + "\n");
    const err = await waitReady(item);
    if (err) await abort(err);
    const entry = svc(p.service);
    if (entry?.proxy) entry.proxy.pid = pid;
    console.log(`proxy-${p.service}: pid ${pid} · http://127.0.0.1:${p.port} → ${p.upstream} · ${p.har}`);
  }

  writeReport(report);
  console.log(`\nPIDs en ${pidsPath}. Para detener: local.ts down --report ${reportArg}`);
}

async function down() {
  if (!existsSync(pidsPath)) {
    console.log("No hay procesos locales levantados.");
    return;
  }
  const { items } = JSON.parse(readFileSync(pidsPath, "utf8")) as { items: Item[] };
  const ordered = [...items.filter((i) => i.role === "proxy"), ...items.filter((i) => i.role === "service").reverse()];
  const report = readReport();
  for (const item of ordered) {
    const how = await stopItem(item);
    console.log(`${item.name}: pid ${item.pid} ${how ? `detenido (${how})` : "ya había terminado"}`);
    if (item.role === "service") {
      const s = report.services.find((x: Json) => x.name === item.name);
      if (s?.process?.pid === item.pid) Object.assign(s.process, { stoppedAt: new Date().toISOString(), exitCode: null, signal: how });
    } else {
      const s = report.services.find((x: Json) => `proxy-${x.name}` === item.name);
      if (s?.proxy) delete s.proxy.pid;
    }
  }
  writeReport(report);
  rmSync(pidsPath, { force: true });
}

function status() {
  if (!existsSync(pidsPath)) {
    console.log("No hay procesos locales levantados.");
    return;
  }
  const { items } = JSON.parse(readFileSync(pidsPath, "utf8")) as { items: Item[] };
  let dead = 0;
  for (const i of items) {
    const ok = alive(i.pid);
    if (!ok) dead++;
    console.log(`${i.name}: pid ${i.pid} ${ok ? "corriendo" : "terminó"}${i.port != null ? ` · puerto ${i.port}` : ""}`);
    if (!ok) console.log(tail(i.log, 5));
  }
  if (dead) process.exit(1);
}

if (command === "up") await up();
else if (command === "down") await down();
else status();
