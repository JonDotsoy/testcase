/**
 * Paquetes @jondotsoy/testcase-report-dto (esquema zod del reporte) y @jondotsoy/testcase-view-report (renderHTML).
 *
 * - El esquema zod acepta y rechaza lo mismo que el JSON Schema de references/report-schema.md.
 * - renderHTML genera la página con los datos incrustados, valida antes y oculta secretos con stripSecrets.
 * - Ambos paquetes se construyen a dist/, se empaquetan con `npm pack` y funcionan instalados en un proyecto aparte.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkReferences, parseReport, reportJsonSchema, ReportValidationError, validateReport } from "../packages/testcase-report-dto/src/index.ts";
import { renderHTML, stripSecrets } from "../packages/testcase-view-report/src/index.ts";
import { ASSETS, readJson, ROOT, runScript, tempDir, validateReport as validateWithJsonSchema } from "./helpers.ts";

const DTO = join(ROOT, "packages", "testcase-report-dto");
const VIEW = join(ROOT, "packages", "testcase-view-report");
const example = () => readJson(join(ASSETS, "report.example.json"));
const embedded = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="report-data">(.*?)<\/script>/s)![1]);

let chromiumError: string | undefined;
try {
  const { chromium } = await import("playwright");
  await (await chromium.launch()).close();
} catch (e) {
  chromiumError = `Chromium no está disponible: ${(e as Error).message.split("\n")[0]}`;
}

describe("@jondotsoy/testcase-report-dto", () => {
  it("acepta el reporte de ejemplo y el reporte vacío", () => {
    for (const file of ["report.example.json", "report.empty.json"]) {
      const r = validateReport(readJson(join(ASSETS, file)));
      assert.ok(r.success, `${file}: ${!r.success && r.issues.join("; ")}`);
    }
  });

  it("rechaza lo mismo que el JSON Schema de report-schema.md", async () => {
    const mutations: Array<[string, (r: any) => void]> = [
      ["sin run", (r) => delete r.run],
      ["reportVersion distinta", (r) => (r.reportVersion = "2.0")],
      ["campo desconocido en la raíz", (r) => (r.extra = 1)],
      ["campo desconocido en un caso", (r) => (r.useCases[0].color = "rojo")],
      ["estado de caso inválido", (r) => (r.useCases[0].status = "ok")],
      ["caso failed sin failure", (r) => {
        const u = r.useCases.find((x: any) => x.status === "failed");
        delete u.failure;
      }],
      ["caso pending sin pending", (r) => {
        const u = r.useCases.find((x: any) => x.status === "pending");
        delete u.pending;
      }],
      ["id de caso con formato inválido", (r) => (r.useCases[0].id = "CASO-1")],
      ["header sensible sin secretRef", (r) => {
        const h = r.requests.flatMap((x: any) => x.request.headers).find((x: any) => x.sensitive);
        delete h.secretRef;
      }],
      ["estado http fuera de rango", (r) => (r.requests.find((x: any) => x.protocol === "http").response.status.code = 99)],
      ["estado con kind desconocido", (r) => (r.requests[0].response.status.kind = "ftp")],
      ["servicio con mode desconocido", (r) => (r.services[0].mode = "cloud")],
      ["servicio provisionado sin image", (r) => delete r.services.find((s: any) => s.mode === "provisioned").image],
      ["proxy en contenedor sin image", (r) => (r.services[0].proxy = { engine: "podman", listen: "http://localhost:18080", upstream: "http://api:8080" })],
      ["anotación con clave inválida", (r) => (r.requests[0].annotations = { "Clave Mayúscula": "x" })],
      ["fecha que no es date-time", (r) => (r.run.startedAt = "ayer")],
      ["conteo negativo", (r) => (r.summary.useCases.total = -1)],
      ["protocolo desconocido en byProtocol", (r) => (r.summary.requests.byProtocol = { ftp: 1 })],
    ];
    for (const [name, mutate] of mutations) {
      const report = example();
      mutate(report);
      const jsonSchema = await validateWithJsonSchema(report);
      assert.ok(jsonSchema.length > 0, `${name}: el JSON Schema debería rechazarlo`);
      const zod = validateReport(report);
      assert.equal(zod.success, false, `${name}: zod debería rechazarlo`);
    }
  });

  it("revisa referencias que el esquema solo no puede ver", () => {
    const report = example();
    report.requests[0].useCaseId = "UC-99";
    report.useCases[0].requestIds.push(9999);
    const r = validateReport(report);
    assert.equal(r.success, false);
    assert.ok(!r.success && r.issues.some((i) => i.includes("UC-99")));
    assert.ok(!r.success && r.issues.some((i) => i.includes("9999")));
    assert.deepEqual(checkReferences(parseReport(example())), []);
  });

  it("parseReport devuelve el reporte tal cual o lanza ReportValidationError con los problemas", () => {
    const report = example();
    assert.deepEqual(parseReport(report), report, "no agrega valores por defecto ni quita campos");
    const bad = example();
    delete bad.manifest;
    assert.throws(() => parseReport(bad), (e: unknown) => e instanceof ReportValidationError && e.issues.some((i) => i.startsWith("manifest")));
  });

  it("reportJsonSchema() genera un JSON Schema que acepta el ejemplo", async () => {
    const schema = reportJsonSchema();
    const { default: Ajv2020 } = (await import("ajv/dist/2020.js")) as any;
    const { default: addFormats } = (await import("ajv-formats")) as any;
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    assert.ok(validate(example()), JSON.stringify(validate.errors?.slice(0, 3)));
  });
});

describe("@jondotsoy/testcase-view-report", () => {
  it("renderHTML genera la página completa con los datos del reporte incrustados", async () => {
    const report = example();
    const html = await renderHTML(report);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, new RegExp(`<title>Reporte testmania ${report.manifest.suite} #${report.run.number}</title>`));
    assert.deepEqual(embedded(html), report);
  });

  it("escapa el JSON incrustado y el título", async () => {
    const report = example();
    report.useCases[0].title = "</script><script>alert(1)</script>";
    const html = await renderHTML(report, { title: 'A & B <"x">' });
    assert.ok(!html.includes("</script><script>alert(1)"));
    assert.equal(embedded(html).useCases[0].title, report.useCases[0].title);
    assert.match(html, /<title>A &amp; B &lt;&quot;x&quot;&gt;<\/title>/);
  });

  it("fragment devuelve solo el contenido, sin documento", async () => {
    const html = await renderHTML(example(), { fragment: true });
    assert.doesNotMatch(html, /<!doctype|<html|<body/i);
    assert.match(html, /id="report-data"/);
  });

  it("stripSecrets quita el mapa de secretos y oculta sus valores en todo el reporte", async () => {
    const report = example();
    // Un header sensible con su valor real en `secrets`, y el mismo valor filtrado en una anotación y en la URL
    const token = "tok_super_secreto_123";
    report.secrets = { ...(report.secrets ?? {}), sec_901: token };
    report.requests[0].request.headers.push({ name: "x-api-key", value: "••••", sensitive: true, secretRef: "sec_901" });
    report.requests[0].annotations = { ...report.requests[0].annotations, nota: `token ${token}` };
    report.requests[0].url += `?key=${token}`;
    const values = Object.values<string>(report.secrets).filter((v) => v.length >= 4);
    assert.ok(validateReport(report).success);
    const html = await renderHTML(report, { stripSecrets: true });
    const data = embedded(html);
    assert.equal(data.secrets, undefined);
    assert.equal(data.run.secretsIncluded, false);
    for (const v of values) assert.ok(!html.includes(v), "no queda ningún valor sensible en el HTML");
    assert.equal(data.requests[0].annotations.nota, "token ••••");
    assert.ok(data.requests[0].url.endsWith("?key=••••"));
    assert.equal(report.secrets.sec_901, token, "no modifica el reporte original");
    assert.equal(stripSecrets(parseReport(report)).run.secretsIncluded, false);
  });

  it("un reporte inválido lanza ReportValidationError", async () => {
    const bad = example();
    bad.useCases[0].status = "ok";
    await assert.rejects(() => renderHTML(bad), ReportValidationError);
  });

  it("la página generada se abre en el navegador sin errores", { skip: chromiumError ?? false, timeout: 120_000 }, async () => {
    const { chromium } = await import("playwright");
    const { dir, cleanup } = tempDir("tc-view-");
    const browser = await chromium.launch();
    try {
      const report = example();
      writeFileSync(join(dir, "report.html"), await renderHTML(report));
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await page.goto("file://" + join(dir, "report.html"));
      const text = await page.locator("body").innerText();
      for (const uc of report.useCases) assert.ok(text.includes(uc.title), `no se ve "${uc.title}"`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      cleanup();
    }
  });
});

describe("paquetes del reporte en npm", () => {
  const tmp = tempDir("tc-report-pkgs-");
  const proj = join(tmp.dir, "proyecto");
  const npm = (args: string[], cwd: string) => spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 180_000 });

  before(() => {
    const tgz: string[] = [];
    for (const pkg of [DTO, VIEW]) {
      const b = runScript(join(pkg, "scripts", "build.ts"), [], { cwd: pkg });
      assert.equal(b.code, 0, b.out);
      const dest = join(tmp.dir, pkg.split("/").pop()!);
      mkdirSync(dest);
      const pack = npm(["pack", join(pkg, "dist"), "--pack-destination", dest], ROOT);
      assert.equal(pack.status, 0, pack.stderr);
      tgz.push(join(dest, readdirSync(dest).find((f) => f.endsWith(".tgz"))!));
    }
    mkdirSync(proj);
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proyecto", private: true, type: "module" }));
    const inst = npm(["install", ...tgz, "--no-audit", "--no-fund", "--ignore-scripts"], proj);
    assert.equal(inst.status, 0, inst.stderr);
  });
  after(() => tmp.cleanup());

  it("dist/ de cada paquete tiene su package.json con exports al JS compilado", () => {
    for (const pkg of [DTO, VIEW]) {
      const json = readJson(join(pkg, "dist", "package.json"));
      assert.deepEqual(json.exports["."], { types: "./index.d.ts", import: "./index.js" });
      assert.equal(json.scripts, undefined);
      assert.ok(existsSync(join(pkg, "dist", "index.js")) && existsSync(join(pkg, "dist", "index.d.ts")));
      assert.ok(existsSync(join(pkg, "dist", "LICENSE")) && existsSync(join(pkg, "dist", "README.md")));
    }
    assert.equal(readJson(join(DTO, "dist", "package.json")).dependencies.zod.startsWith("^4"), true);
    assert.ok(existsSync(join(VIEW, "dist", "assets", "report.template.html")));
  });

  it("instalados en otro proyecto: renderHTML genera el reporte y los tipos compilan", () => {
    writeFileSync(join(tmp.dir, "example.json"), JSON.stringify(example()));
    writeFileSync(
      join(proj, "main.ts"),
      [
        'import { readFileSync } from "node:fs";',
        'import { renderHTML } from "@jondotsoy/testcase-view-report";',
        'import { validateReport, type Report } from "@jondotsoy/testcase-report-dto";',
        `const report: Report = JSON.parse(readFileSync(${JSON.stringify(join(tmp.dir, "example.json"))}, "utf8"));`,
        "const check = validateReport(report);",
        "const html: string = await renderHTML(report);",
        'console.log(check.success, html.startsWith("<!doctype html>"), html.includes(report.manifest.suite));',
      ].join("\n"),
    );
    const run = runScript(join(proj, "main.ts"), [], { cwd: proj });
    assert.equal(run.code, 0, run.out);
    assert.equal(run.stdout.trim(), "true true true");
    writeFileSync(
      join(proj, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: false, types: ["node"], typeRoots: [join(ROOT, "node_modules", "@types")] }, include: ["main.ts"] }),
    );
    const tsc = spawnSync(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", proj], { encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  });
});
