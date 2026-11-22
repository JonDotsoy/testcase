/**
 * cases.ts
 *
 * Ejecuta los casos de uso (`*.case.ts`) sin tocar el repositorio de la persona: arma un espacio de trabajo
 * temporal con su propio package.json y Playwright (desde `assets/workspace`), copia ahí los scripts y corre run.ts.
 *
 * Uso (desde la raíz del proyecto):
 *   bun <skill>/scripts/cases.ts --report .testcase/report.json --plan          # servicios → reporte + compose.yaml
 *   bun <skill>/scripts/cases.ts --report .testcase/report.json                 # corre todos los casos
 *   bun <skill>/scripts/cases.ts --report .testcase/report.json --only UC-03    # solo algunos
 *   bun <skill>/scripts/cases.ts --report .testcase/report.json --typecheck     # revisa los tipos y no corre
 *
 * Opciones:
 *   [archivos o carpetas…]  Scripts a copiar. Por defecto, `<carpeta del reporte>/cases/`. Se copian los `*.ts`
 *                           (casos y módulos que compartan); run.ts corre los `*.case.ts`.
 *   --report <ruta>         Reporte JSON (obligatorio).
 *   --plan | --only | --headed   Se pasan a run.ts.
 *   --typecheck             Corre `tsc --noEmit` en el espacio de trabajo y termina.
 *   --workspace <dir>       Espacio de trabajo. Por defecto uno temporal por proyecto, que se reutiliza entre
 *                           corridas para no reinstalar dependencias. También TESTCASE_WORKSPACE.
 *   --skip-install          No instala dependencias ni el navegador (ya están).
 *   --clean                 Borra el espacio de trabajo al terminar.
 *
 * Node 22.6+ o bun. Instala con bun si está disponible; si no, con npm.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--report", "--only", "--workspace"]);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(args[i - 1])));

const reportArg = flag("--report");
if (!reportArg) {
  console.log("Uso: bun scripts/cases.ts --report .testcase/report.json [archivos o carpetas…] [--plan] [--only UC-01,UC-02] [--headed] [--typecheck] [--workspace dir] [--skip-install] [--clean]");
  process.exit(1);
}
const reportPath = resolve(reportArg);
if (!existsSync(reportPath)) {
  console.error(`No existe ${reportPath}. Créalo desde assets/report.empty.json.`);
  process.exit(1);
}
const reportDir = dirname(reportPath);
const here = dirname(new URL(import.meta.url).pathname);
const template = join(here, "..", "assets", "workspace");

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

const isBun = !!(process.versions as any).bun;
const which = (cmd: string) => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
const run = (cmd: string, argv: string[]) => {
  const r = spawnSync(cmd, argv, { cwd: ws, stdio: "inherit", env: process.env });
  if (r.error) {
    console.error(`No pude ejecutar ${cmd}: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
};

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

// run.ts con el mismo runtime: bun, o node con type stripping
const passthrough: string[] = ["--report", reportPath];
if (has("--plan")) passthrough.push("--plan");
if (has("--headed")) passthrough.push("--headed");
const only = flag("--only");
if (only) passthrough.push("--only", only);

let runtimeArgs: string[] = [];
if (!isBun) {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 6)) {
    console.error(`Node ${process.versions.node} no ejecuta TypeScript. Usa Node 22.6+ o bun.`);
    process.exit(1);
  }
  if (maj === 22 && min < 18) runtimeArgs = ["--experimental-strip-types", "--no-warnings"];
}
const code = run(process.execPath, [...runtimeArgs, "run.ts", ...passthrough]);

if (has("--clean")) rmSync(ws, { recursive: true, force: true });
else if (code === 0 && !has("--plan")) console.log(`Espacio de trabajo: ${ws} (se reutiliza en la próxima corrida; --clean lo borra)`);
process.exit(code);
