/**
 * Paquete @jondotsoy/testcase: build a dist/, `npm pack ./dist` y el .tgz instalado en un proyecto aparte.
 * Revisa los exports (API de los casos separada del runner), los tipos, los assets y el estado global compartido
 * entre dos copias del paquete.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ASSETS, PKG, readJson, ROOT, runScript, SRC, tempDir } from "./helpers.ts";

const DIST = join(PKG, "dist");
const npm = (args: string[], cwd: string) => spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000 });

describe("paquete npm", () => {
  const tmp = tempDir("tc-pkg-");
  const proj = join(tmp.dir, "proyecto");
  let installed = "";
  const sh = (cmd: string, args: string[], cwd: string) => {
    const r = runScript(cmd, args, { cwd });
    assert.equal(r.code, 0, r.out);
    return r;
  };

  before(() => {
    sh(join(PKG, "scripts", "build.ts"), [], PKG);
    const pack = npm(["pack", DIST, "--pack-destination", tmp.dir], ROOT);
    assert.equal(pack.status, 0, pack.stderr);
    const tgz = readdirSync(tmp.dir).find((f) => f.endsWith(".tgz"));
    assert.ok(tgz, "npm pack no dejó un .tgz");
    mkdirSync(proj);
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "proyecto", private: true, type: "module" }));
    // Playwright es peerDependency: aquí se usa el de este repositorio en vez de descargarlo
    const inst = npm(["install", join(tmp.dir, tgz!), "--legacy-peer-deps", "--no-audit", "--no-fund", "--ignore-scripts"], proj);
    assert.equal(inst.status, 0, inst.stderr);
    installed = join(proj, "node_modules", "@jondotsoy", "testcase");
    for (const dep of ["playwright", "playwright-core", "typescript", "@types"]) {
      if (existsSync(join(ROOT, "node_modules", dep)) && !existsSync(join(proj, "node_modules", dep))) symlinkSync(join(ROOT, "node_modules", dep), join(proj, "node_modules", dep), "dir");
    }
  });
  after(() => tmp.cleanup());

  it("dist/ tiene su propio package.json con exports al JS compilado", () => {
    const pkg = readJson(join(DIST, "package.json"));
    assert.equal(pkg.name, "@jondotsoy/testcase");
    assert.equal(pkg.type, "module");
    assert.deepEqual(pkg.exports["."], { types: "./index.d.ts", import: "./index.js" });
    assert.deepEqual(pkg.exports["./runner"], { types: "./runner.d.ts", import: "./runner.js" });
    assert.equal(pkg.scripts, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.ok(pkg.peerDependencies.playwright);
    for (const f of Object.values<any>(pkg.exports).flatMap((e): string[] => (typeof e === "string" ? [e] : Object.values(e)))) assert.ok(existsSync(join(DIST, f)), `falta ${f}`);
    assert.ok(existsSync(join(DIST, "assets", "report.template.html")));
    assert.ok(existsSync(join(DIST, "LICENSE")) && existsSync(join(DIST, "README.md")));
    const js = readFileSync(join(DIST, "run.js"), "utf8");
    assert.match(js, /from "\.\/testcase\.js"/, "los imports relativos quedan con .js");
  });

  it("la entrada principal es la API de los casos y /runner trae lo interno", async () => {
    writeFileSync(
      join(proj, "check.mjs"),
      // import estático: la entrada exporta then(), así que `await import()` trataría el módulo como una promesa
      `import * as main from "@jondotsoy/testcase";
import * as runner from "@jondotsoy/testcase/runner";
console.log(JSON.stringify({ main: Object.keys(main).sort(), runner: Object.keys(runner).sort() }));`,
    );
    const out = sh(join(proj, "check.mjs"), [], proj);
    const { main, runner } = JSON.parse(out.stdout);
    for (const name of ["defineCase", "title", "describe", "id", "given", "when", "then", "defineService", "fromEnv", "fromEnvFile", "sensitive", "notation", "vars", "page", "check", "ensure", "satisfies", "instanceOf", "between", "Cookies", "withCookies"])
      assert.ok(main.includes(name), `falta ${name} en la entrada principal`);
    for (const name of ["createContext", "takeDefinedCases", "declaredServices", "maskSensitive", "encodeHeaderJson", "CaseAbort"]) {
      assert.ok(!main.includes(name), `${name} es interno y no va en la entrada principal`);
      assert.ok(runner.includes(name), `falta ${name} en /runner`);
    }
  });

  it("dos copias del paquete comparten el registro de casos y servicios (globalThis)", () => {
    writeFileSync(
      join(proj, "shared.mjs"),
      `import { defineCase, defineService, title, given, when, then } from "@jondotsoy/testcase";
const src = await import(${JSON.stringify(join(SRC, "runner.ts"))});
await defineService({ name: "api", endpoint: "https://api.example.com" });
await defineCase(async () => { await title("Caso de la copia instalada"); await given("g"); await when("w"); await then("t"); });
const cases = await src.takeDefinedCases();
const services = src.declaredServices().map((s) => s.name);
const abort = await import("@jondotsoy/testcase/runner").then((m) => new m.CaseAbort("x"));
console.log(JSON.stringify({ titles: cases.map((c) => c.title), services, abort: abort instanceof src.CaseAbort }));`,
    );
    const out = sh(join(proj, "shared.mjs"), [], proj);
    assert.deepEqual(JSON.parse(out.stdout), { titles: ["Caso de la copia instalada"], services: ["api"], abort: true });
  });

  it("un caso escrito contra el paquete instalado pasa tsc con sus tipos", () => {
    mkdirSync(join(proj, "cases"));
    writeFileSync(
      join(proj, "cases", "UC-01.case.ts"),
      `import { defineCase, defineService, title, given, when, then, check, type Service } from "@jondotsoy/testcase";
const api: Service = await defineService({ name: "api", endpoint: "https://api.example.com" });
await defineCase(async () => {
  await title("Tipos del paquete");
  await given("nada");
  const res = await when("pide algo", () => api.http.get("/v1/orders"));
  await then("responde 200", () => check("status == 200", res.status(), 200));
});
export {};
`,
    );
    writeFileSync(
      join(proj, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: ["node"] }, include: ["cases/*.ts"] }),
    );
    sh(join(ROOT, "node_modules", "typescript", "bin", "tsc"), ["-p", join(proj, "tsconfig.json")], proj);
  });

  it("los scripts compilados corren desde el paquete instalado (render-report con su plantilla)", () => {
    const json = join(tmp.dir, "report.json");
    writeFileSync(json, readFileSync(join(ASSETS, "report.example.json")));
    sh(join(installed, "scripts", "render-report.js"), [json], proj);
    assert.match(readFileSync(join(tmp.dir, "report.html"), "utf8"), /<html/i);
  });
});
