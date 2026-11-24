/**
 * Utilidades compartidas por las pruebas de la skill.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL = join(ROOT, "testcase");
/** Paquete @jondotsoy/testcase: el código vive en src/ y la skill lleva una copia (scripts/sync-skill.ts). */
export const PKG = join(ROOT, "packages", "testcase");
export const SRC = join(PKG, "src");
/** Scripts del paquete (proxy, local, import-har, sync-report, render-report): las pruebas corren estos. */
export const SCRIPTS = join(SRC, "scripts");
/** Scripts de la skill: cases.ts y las copias de los del paquete. */
export const SKILL_SCRIPTS = join(SKILL, "scripts");
export const ASSETS = join(SKILL, "assets");
export const WORKSPACE = join(ASSETS, "workspace");

/** Carpeta temporal que se borra con `cleanup()`. */
export function tempDir(prefix = "tc-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  out: string;
}

/** Corre un script TypeScript con el mismo Node de las pruebas. */
export function runScript(script: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {}): RunResult {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...(opts.env ?? {}) },
    encoding: "utf8",
    timeout: opts.timeout ?? 120_000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
export const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

/** Reporte vacío (assets/report.empty.json) con un caso y un servicio conectado. */
export function baseReport(overrides: { startedAt?: string; runId?: string } = {}): any {
  const r = readJson(join(ASSETS, "report.empty.json"));
  r.manifest.suite = "pruebas";
  r.run.id = overrides.runId ?? "run_1";
  r.run.number = 1;
  r.run.startedAt = overrides.startedAt ?? new Date(Date.now() - 5_000).toISOString();
  r.useCases = [
    { id: "UC-01", title: "Cliente no puede cancelar un pedido ajeno", given: "un pedido de María", when: "Pedro intenta cancelarlo", then: "la API responde 403", handler: { file: "cases/UC-01.case.ts" }, requestIds: [], invocations: [], status: "pending" },
  ];
  r.services = [
    {
      name: "api",
      mode: "connected",
      host: "api.example.com",
      endpoint: "https://api.example.com",
      health: { check: "GET /healthz", status: "healthy", durationMs: 80 },
      requestCount: 0,
      proxy: { engine: "podman", image: "docker.io/mitmproxy/mitmproxy:11.0.2", listen: "http://localhost:18080", upstream: "https://api.example.com", evidence: "evidence/api.har" },
    },
  ];
  return r;
}

/** Codifica anotaciones como lo hace testcase.ts. */
export const b64 = (v: unknown) => "b64:" + Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

/** Entrada HAR con la forma que escribe mitmdump. */
export function harEntry(e: {
  method?: string;
  url: string;
  started: Date | string;
  headers?: Record<string, string>;
  body?: string;
  mime?: string;
  status?: number;
  statusText?: string;
  resHeaders?: Record<string, string>;
  resBody?: string;
  resMime?: string;
  time?: number;
}): any {
  const h = (o: Record<string, string> = {}) => Object.entries(o).map(([name, value]) => ({ name, value }));
  return {
    startedDateTime: typeof e.started === "string" ? e.started : e.started.toISOString(),
    time: e.time ?? 12,
    request: {
      method: e.method ?? "GET",
      url: e.url,
      httpVersion: "HTTP/1.1",
      headers: h(e.headers),
      queryString: [],
      ...(e.body != null ? { postData: { mimeType: e.mime ?? "application/json", text: e.body } } : {}),
    },
    response: {
      status: e.status ?? 200,
      statusText: e.statusText ?? "OK",
      httpVersion: "HTTP/1.1",
      headers: h(e.resHeaders ?? { "content-type": e.resMime ?? "application/json" }),
      content: { size: (e.resBody ?? "").length, mimeType: e.resMime ?? "application/json", ...(e.resBody != null ? { text: e.resBody } : {}) },
    },
    timings: { send: 0, wait: e.time ?? 12, receive: 0 },
  };
}

export const har = (entries: any[]) => ({ log: { version: "1.2", creator: { name: "mitmproxy", version: "11.0.2" }, entries } });

/** Valida un reporte contra el schema de la skill (references/report-schema.md). */
export async function validateReport(report: unknown): Promise<string[]> {
  const md = readFileSync(join(SKILL, "references", "report-schema.md"), "utf8");
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const schema = JSON.parse(blocks[blocks.length - 1]);
  const { default: Ajv2020 } = (await import("ajv/dist/2020.js")) as any;
  const { default: addFormats } = (await import("ajv-formats")) as any;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return validate(report) ? [] : validate.errors.map((e: any) => `${e.instancePath} ${e.message}`);
}

export const CASES = join(SKILL_SCRIPTS, "cases.ts");
const CASE_MODES = ["--plan", "--typecheck", "--only-up-services", "--down-services", "--skip-services"];

/**
 * Proyecto de prueba: `<dir>/.testcase/report.json` (vacío) y `<dir>/.testcase/cases/` con los scripts dados,
 * más un espacio de trabajo cuyo node_modules apunta al de este repositorio (Playwright y TypeScript ya instalados).
 */
export function project(cases: Record<string, string>, opts: { report?: any } = {}) {
  const { dir, cleanup } = tempDir("tc-proj-");
  const tc = join(dir, ".testcase");
  mkdirSync(join(tc, "cases"), { recursive: true });
  const report = opts.report ?? readJson(join(ASSETS, "report.empty.json"));
  writeJson(join(tc, "report.json"), report);
  for (const [name, src] of Object.entries(cases)) writeFileSync(join(tc, "cases", name), src);
  const ws = join(dir, "ws");
  mkdirSync(ws);
  symlinkSync(join(ROOT, "node_modules"), join(ws, "node_modules"), "dir");
  const reportFile = join(tc, "report.json");
  return {
    dir,
    tc,
    ws,
    reportFile,
    cleanup,
    /**
     * Corre scripts/cases.ts con el espacio de trabajo del proyecto, sin instalar. Sin una opción de modo
     * (--plan, --only-up-services…) agrega --skip-services: las pruebas unitarias no levantan contenedores.
     */
    cases: (args: string[], env: Record<string, string | undefined> = {}) =>
      runScript(CASES, ["--report", reportFile, "--workspace", ws, "--skip-install", ...(args.some((a) => CASE_MODES.includes(a)) ? [] : ["--skip-services"]), ...args], { cwd: dir, env }),
    report: () => readJson(reportFile),
  };
}

/** Script de caso mínimo. */
export const caseSource = (body: string, header = "") =>
  `import { defineCase, defineService, fromEnv, fromEnvFile, sensitive, id, title, given, when, then, notation, check, ensure, page, vars } from "../testcase.ts";\n${header}\n${body}\n`;

export function hasCommand(cmd: string, args = ["--version"]): boolean {
  return spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
}
