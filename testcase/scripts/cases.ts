/**
 * cases.ts
 *
 * Ejecuta los casos de uso (`*.case.ts`) sin tocar el repositorio de la persona: arma un espacio de trabajo
 * temporal con su propio package.json y Playwright (desde `assets/workspace`), copia ahí los scripts y corre run.ts.
 * Sin opciones hace todo: pasa los servicios al reporte (--plan), los levanta con su proxy de evidencia y corre
 * todos los casos de `.testcase/cases/`. Los servicios quedan levantados para la próxima corrida.
 *
 * Uso (desde la raíz del proyecto):
 *   bun <skill>/scripts/cases.ts                        # servicios arriba + todos los casos de .testcase/cases/
 *   bun <skill>/scripts/cases.ts --only UC-03           # solo algunos casos
 *   bun <skill>/scripts/cases.ts --only-up-services     # solo levanta los servicios
 *   bun <skill>/scripts/cases.ts --down-services        # apaga los servicios (los proxies escriben el HAR)
 *   bun <skill>/scripts/cases.ts --plan                 # solo escribe el reporte, compose.yaml y local.json
 *   bun <skill>/scripts/cases.ts --typecheck            # revisa los tipos y no corre
 *
 * Opciones:
 *   [archivos o carpetas…]  Scripts a copiar. Por defecto, `<carpeta del reporte>/cases/`. Se copian los `*.ts`
 *                           (casos y módulos que compartan); run.ts corre los `*.case.ts`.
 *   --report <ruta>         Reporte JSON. Por defecto `.testcase/report.json`.
 *   --only-up-services      Pasa los servicios al reporte y los levanta, sin correr los casos.
 *   --down-services         Apaga lo levantado: primero los proxies locales y los procesos (local.ts down),
 *                           después los proxies en contenedor (escriben el HAR al detenerse) y `compose down`.
 *   --skip-services         Corre los casos sin planear ni levantar servicios (ya están arriba).
 *   --plan                  Solo pasa los servicios al reporte y escribe compose.yaml y local.json.
 *   --proxy local|podman    Dónde corren los proxies de evidencia (se pasa a run.ts --plan).
 *   --only | --headed       Se pasan a run.ts.
 *   --typecheck             Corre `tsc --noEmit` en el espacio de trabajo y termina.
 *   --workspace <dir>       Espacio de trabajo. Por defecto uno temporal por proyecto, que se reutiliza entre
 *                           corridas para no reinstalar dependencias. También TESTCASE_WORKSPACE.
 *   --skip-install          No instala dependencias ni el navegador (ya están).
 *   --clean                 Borra el espacio de trabajo al terminar.
 *
 * Los contenedores se levantan con `podman compose` (o `docker compose` si no hay Podman); los procesos locales y
 * los proxies sin contenedor, con scripts/local.ts. Si ya están corriendo con el mismo plan, se reutilizan.
 * Después de correr los casos se reinician los proxies en contenedor para que escriban el HAR; los servicios siguen arriba.
 *
 * Node 22.6+ o bun. Instala con bun si está disponible; si no, con npm.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--report", "--only", "--workspace", "--proxy"]);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));

if (has("--help") || has("-h")) {
  console.log(
    "Uso: bun scripts/cases.ts [--report .testcase/report.json] [archivos o carpetas…] [--only UC-01,UC-02] [--headed] [--proxy local|podman]\n" +
      "                          [--only-up-services | --down-services | --skip-services | --plan | --typecheck] [--workspace dir] [--skip-install] [--clean]",
  );
  process.exit(0);
}
const modes = ["--only-up-services", "--down-services", "--skip-services", "--plan", "--typecheck"].filter(has);
if (modes.length > 1) {
  console.error(`No combines ${modes.join(" y ")}.`);
  process.exit(1);
}
const reportPath = resolve(flag("--report") ?? join(".testcase", "report.json"));
if (!existsSync(reportPath)) {
  console.error(`No existe ${reportPath}. Créalo desde assets/report.empty.json o indica otro con --report.`);
  process.exit(1);
}
const reportDir = dirname(reportPath);
const here = dirname(new URL(import.meta.url).pathname);
const template = join(here, "..", "assets", "workspace");
const composePath = join(reportDir, "compose.yaml");
const localPath = join(reportDir, "local.json");
const pidsPath = join(reportDir, "local.pids.json");

const isBun = !!(process.versions as any).bun;
// .ts con el mismo runtime: bun, o node con type stripping
let runtimeArgs: string[] = [];
if (!isBun) {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 6)) {
    console.error(`Node ${process.versions.node} no ejecuta TypeScript. Usa Node 22.6+ o bun.`);
    process.exit(1);
  }
  if (maj === 22 && min < 18) runtimeArgs = ["--experimental-strip-types", "--no-warnings"];
}
const which = (cmd: string) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
const exec = (cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(cmd, argv, { cwd, stdio: "inherit", env: { ...process.env, TESTCASE_SCRIPTS: here, ...env } });
  if (r.error) {
    console.error(`No pude ejecutar ${cmd}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
};

// Servicios: compose para los contenedores, local.ts para los procesos y proxies sin contenedor
const localTs = (sub: string, extra: string[] = []) => exec(process.execPath, [...runtimeArgs, join(here, "local.ts"), sub, "--report", reportPath, ...extra], reportDir);
let engine: string | null | undefined;
const compose = (argv: string[]): number => {
  engine ??= process.env.TESTCASE_COMPOSE ?? (which("podman") ? "podman" : which("docker") ? "docker" : null);
  if (!engine) {
    console.error(`${composePath} necesita Podman (o Docker) y no encontré ninguno. Instala Podman o usa --proxy local para los proxies.`);
    return 1;
  }
  return exec(engine, ["compose", "-f", composePath, ...argv], reportDir);
};
/** Los proxies mitmdump de compose.yaml: escriben el HAR al detenerse. */
const containerProxies = () => (existsSync(composePath) ? [...readFileSync(composePath, "utf8").matchAll(/^  (proxy-[A-Za-z0-9_.-]+):$/gm)].map((m) => m[1]) : []);

function upServices(): number {
  if (existsSync(composePath)) {
    const build = /^ {4}build:/m.test(readFileSync(composePath, "utf8"));
    const code = compose(["up", "-d", ...(build ? ["--build"] : [])]);
    if (code !== 0) return code;
  }
  if (existsSync(localPath)) return localTs("up", ["--restart"]);
  if (existsSync(pidsPath)) return localTs("down"); // el plan ya no tiene procesos locales
  return 0;
}

function downServices(): number {
  if (!existsSync(pidsPath) && !existsSync(composePath)) {
    console.log("No hay servicios levantados.");
    return 0;
  }
  let code = 0;
  if (existsSync(pidsPath)) code = localTs("down") || code;
  if (existsSync(composePath)) {
    const proxies = containerProxies();
    if (proxies.length) code = compose(["stop", ...proxies]) || code;
    code = compose(["down"]) || code;
  }
  return code;
}

if (has("--down-services")) process.exit(downServices());

// Scripts de origen
const sources = positional.length ? positional.map((p) => resolve(p)) : [join(reportDir, "cases")];
const files: string[] = [];
for (const src of sources) {
  if (!existsSync(src)) {
    console.error(`No existe ${src}.`);
    process.exit(1);
  }
  if (statSync(src).isDirectory()) {
    for (const f of readdirSync(src).sort()) if (f.endsWith(".ts") && !f.endsWith(".d.ts")) files.push(join(src, f));
  } else files.push(src);
}
const reserved = new Set(["testcase.ts", "run.ts"]);
const bad = files.filter((f) => reserved.has(basename(f)));
if (bad.length) {
  console.error(`Estos nombres los usa el espacio de trabajo; renómbralos: ${bad.join(", ")}`);
  process.exit(1);
}
if (!files.some((f) => f.endsWith(".case.ts"))) {
  console.error(`No hay archivos *.case.ts en ${sources.join(", ")}.`);
  process.exit(1);
}

// Espacio de trabajo: uno por proyecto, reutilizable
const projectKey = createHash("sha256").update(dirname(reportDir)).digest("hex").slice(0, 10);
const ws = resolve(flag("--workspace") ?? process.env.TESTCASE_WORKSPACE ?? join(tmpdir(), `testcase-ws-${projectKey}`));
mkdirSync(ws, { recursive: true });
for (const f of ["package.json", "tsconfig.json", "testcase.ts", "run.ts", ".gitignore"]) copyFileSync(join(template, f), join(ws, f));
rmSync(join(ws, "cases"), { recursive: true, force: true });
mkdirSync(join(ws, "cases"), { recursive: true });
for (const f of files) copyFileSync(f, join(ws, "cases", basename(f)));
if (existsSync(join(template, "examples"))) cpSync(join(template, "examples"), join(ws, "examples"), { recursive: true });

const run = (cmd: string, argv: string[], env: NodeJS.ProcessEnv = {}) => exec(cmd, argv, ws, env);

// Dependencias: se reinstalan solo si cambia package.json
if (!has("--skip-install")) {
  const pkgHash = createHash("sha256").update(readFileSync(join(ws, "package.json"))).digest("hex");
  const stamp = join(ws, "node_modules", ".testcase-install");
  const installed = existsSync(stamp) && readFileSync(stamp, "utf8").trim() === pkgHash;
  if (!installed) {
    const useBun = isBun || which("bun");
    console.log(`Instalando dependencias en ${ws} con ${useBun ? "bun" : "npm"}…`);
    const code = useBun ? run(isBun ? process.execPath : "bun", ["install"]) : run("npm", ["install", "--no-audit", "--no-fund"]);
    if (code !== 0) process.exit(code);
    const pw = useBun ? run(isBun ? process.execPath : "bun", ["x", "playwright", "install", "chromium"]) : run("npx", ["playwright", "install", "chromium"]);
    if (pw !== 0) process.exit(pw);
    writeFileSync(stamp, pkgHash + "\n");
  }
}

if (has("--typecheck")) {
  const tsc = join(ws, "node_modules", "typescript", "bin", "tsc");
  const code = run(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json"]);
  console.log(code === 0 ? "Tipos correctos." : "Hay errores de tipos: corrígelos en los scripts de origen.");
  process.exit(code);
}

const runTs = (argv: string[], env: NodeJS.ProcessEnv = {}) => run(process.execPath, [...runtimeArgs, "run.ts", "--report", reportPath, ...argv], env);
const proxy = flag("--proxy");
const planArgs = ["--plan", ...(proxy ? ["--proxy", proxy] : [])];
const finish = (code: number): never => {
  if (has("--clean")) rmSync(ws, { recursive: true, force: true });
  process.exit(code);
};

if (has("--plan")) finish(runTs(planArgs));

const withServices = !has("--skip-services");
if (withServices) {
  // Los servicios salen de los scripts: se planean siempre, así compose.yaml y local.json siguen a los casos
  const planned = runTs(planArgs, { TESTCASE_AUTO_UP: "1" });
  if (planned !== 0) finish(planned);
  const up = upServices();
  if (up !== 0) {
    console.error("\nNo pude levantar los servicios. Revisa la salida de arriba (y .testcase/logs/ para los procesos locales).");
    finish(up);
  }
  if (has("--only-up-services")) {
    console.log(`\nServicios levantados. Corre los casos con cases.ts; --down-services los apaga.`);
    finish(0);
  }
}

const caseArgs: string[] = [];
if (has("--headed")) caseArgs.push("--headed");
const only = flag("--only");
if (only) caseArgs.push("--only", only);
const code = runTs(caseArgs);

if (withServices) {
  // mitmdump escribe el HAR al detenerse: se reinician sus proxies y los servicios siguen arriba
  const proxies = containerProxies();
  if (proxies.length) {
    const stopped = compose(["stop", ...proxies]);
    if (stopped === 0) compose(["start", ...proxies]);
  }
  console.log(`\nLos servicios siguen levantados para la próxima corrida. Para apagarlos: cases.ts --down-services`);
}
if (!has("--clean") && code === 0) console.log(`Espacio de trabajo: ${ws} (se reutiliza en la próxima corrida; --clean lo borra)`);
finish(code);
