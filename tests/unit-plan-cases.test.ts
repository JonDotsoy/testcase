/**
 * scripts/cases.ts y run.ts --plan: espacio de trabajo, validación de los scripts y compose.yaml.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { caseSource, CASES, hasCommand, project, runScript, tempDir, WORKSPACE } from "./helpers.ts";

const EXAMPLE = readFileSync(join(WORKSPACE, "examples", "UC-01.case.ts"), "utf8");
const caseBody = (t = "Caso simple") => `defineCase(() => { title("${t}"); given("a"); when("b"); then("c"); });`;
const simple = (t?: string) => caseSource(caseBody(t));
/** Caso simple que además declara servicios. */
const withServices = (services: string) => caseSource(caseBody(), services);

describe("cases.ts: argumentos y scripts", () => {
  it("sin --report muestra el uso", () => {
    const r = runScript(CASES, []);
    assert.equal(r.code, 1);
    assert.match(r.out, /Uso: bun scripts\/cases.ts --report/);
  });

  it("avisa si el reporte no existe", () => {
    const { dir, cleanup } = tempDir();
    try {
      const r = runScript(CASES, ["--report", join(dir, "nada.json")]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /No existe .*nada.json. Créalo desde assets\/report.empty.json/);
    } finally {
      cleanup();
    }
  });

  it("exige al menos un *.case.ts y no acepta nombres reservados", () => {
    const p = project({ "util.ts": "export const x = 1;\n" });
    try {
      assert.match(p.cases(["--plan"]).stderr, /No hay archivos \*\.case\.ts/);
      writeFileSync(join(p.tc, "cases", "run.ts"), "");
      assert.match(p.cases(["--plan"]).stderr, /Estos nombres los usa el espacio de trabajo; renómbralos: .*run\.ts/);
    } finally {
      p.cleanup();
    }
  });

  it("copia solo los scripts de origen al espacio de trabajo, junto con los módulos compartidos", () => {
    const p = project({
      "UC-01.case.ts": caseSource(`defineCase(() => { title(saludo); given("a"); when("b"); then("c"); });`, `import { saludo } from "./comun.ts";`),
      "comun.ts": `export const saludo = "Caso con módulo compartido";\n`,
      "notas.md": "no se copia",
    });
    try {
      writeFileSync(join(p.ws, "cases-stale.txt"), "");
      const r = p.cases(["--plan"]);
      assert.equal(r.code, 0, r.out);
      assert.ok(existsSync(join(p.ws, "cases", "comun.ts")));
      assert.ok(!existsSync(join(p.ws, "cases", "notas.md")));
      for (const f of ["package.json", "tsconfig.json", "testcase.ts", "run.ts", ".gitignore", "examples/UC-01.case.ts"]) assert.ok(existsSync(join(p.ws, f)), f);
    } finally {
      p.cleanup();
    }
  });

  it("acepta archivos y carpetas como argumentos en vez de .testcase/cases", () => {
    const p = project({});
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(join(dir, "UC-05.case.ts"), simple("Desde otra carpeta"));
      const r = p.cases(["--plan", join(dir, "UC-05.case.ts")]);
      assert.equal(r.code, 0, r.out);
      assert.ok(existsSync(join(p.ws, "cases", "UC-05.case.ts")));
    } finally {
      cleanup();
      p.cleanup();
    }
  });

  it("--typecheck pasa con el ejemplo y falla con un error de tipos", () => {
    const p = project({ "UC-01.case.ts": EXAMPLE });
    try {
      const ok = p.cases(["--typecheck"]);
      assert.equal(ok.code, 0, ok.out);
      assert.match(ok.out, /Tipos correctos/);
      writeFileSync(join(p.tc, "cases", "UC-02.case.ts"), caseSource(`defineCase(() => { title(42); given("a"); when("b"); then("c"); });`));
      const bad = p.cases(["--typecheck"]);
      assert.equal(bad.code, 2, bad.out);
      assert.match(bad.out, /UC-02\.case\.ts/);
      assert.match(bad.out, /Hay errores de tipos/);
    } finally {
      p.cleanup();
    }
  });

  it("--clean borra el espacio de trabajo", () => {
    const p = project({ "UC-01.case.ts": simple() });
    try {
      assert.equal(p.cases(["--plan", "--clean"]).code, 0);
      assert.ok(!existsSync(p.ws));
    } finally {
      p.cleanup();
    }
  });
});

describe("run.ts: carga de los casos", () => {
  const expectError = (cases: Record<string, string>, re: RegExp) => {
    const p = project(cases);
    try {
      const r = p.cases(["--plan"]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.stderr, re);
    } finally {
      p.cleanup();
    }
  };

  it("un archivo que no define casos", () => expectError({ "UC-01.case.ts": caseSource("") }, /UC-01\.case\.ts no define ningún caso/));
  it("un caso sin id ni nombre UC-NN", () => expectError({ "cancelar.case.ts": simple() }, /cancelar\.case\.ts: no tiene id/));
  it("varios casos en un archivo sin id()", () =>
    expectError({ "UC-01.case.ts": caseSource(caseBody("Uno") + "\n" + caseBody("Dos")) }, /define 2 casos y "Uno" no tiene id/));
  it("ids repetidos entre archivos", () =>
    expectError(
      { "UC-01.case.ts": simple(), "varios.case.ts": caseSource(`defineCase(() => { id("UC-01"); title("Otro"); given("a"); when("b"); then("c"); });`) },
      /El id UC-01 está repetido/,
    ));
  it("un error al importar el script", () => expectError({ "UC-01.case.ts": `throw new Error("roto al cargar");\n` }, /UC-01\.case\.ts: roto al cargar/));
  it("una dependencia que no está declarada", () =>
    expectError(
      { "UC-01.case.ts": withServices(`defineService({ name: "app", image: "x:1", dependsOn: ["db"] });`) },
      /"app" depende de "db", que no está declarado/,
    ));
  it("un nombre que no sirve en compose", () =>
    expectError({ "UC-01.case.ts": withServices(`defineService({ name: "Mi API", endpoint: "https://x.example.com" });`) }, /"Mi API" no sirve como servicio de compose/));
  it("un servicio http sin puertos", () =>
    expectError({ "UC-01.case.ts": withServices(`defineService({ name: "app", image: "x:1", http: true });`) }, /"app" es http pero no declara ports/));
  it("definiciones distintas del mismo servicio en dos scripts", () =>
    expectError(
      {
        "UC-01.case.ts": withServices(`defineService({ name: "api", endpoint: "https://a.example.com" });`),
        "UC-02.case.ts": withServices(`defineService({ name: "api", endpoint: "https://b.example.com" });`),
      },
      /declarado dos veces con definiciones distintas/,
    ));
});

describe("run.ts --plan", () => {
  it("pasa los servicios del ejemplo al reporte y escribe compose.yaml", () => {
    const p = project({ "UC-01.case.ts": EXAMPLE });
    try {
      const r = p.cases(["--plan"]);
      assert.equal(r.code, 0, r.out);
      const rep = p.report();
      const byName = Object.fromEntries(rep.services.map((s: any) => [s.name, s]));
      assert.deepEqual(Object.keys(byName).sort(), ["api", "pedidos-svc", "postgres"]);

      assert.equal(byName.api.mode, "connected");
      assert.equal(byName.api.host, "api.example.com");
      assert.deepEqual(byName.api.proxy, {
        engine: "podman",
        image: "docker.io/mitmproxy/mitmproxy:11.0.2",
        container: "tc-proxy-api",
        listen: "http://localhost:18080",
        upstream: "https://api.example.com",
        evidence: "evidence/api.har",
      });

      const pg = byName.postgres;
      assert.equal(pg.mode, "provisioned");
      assert.equal(pg.image, "docker.io/library/postgres:16.4-alpine");
      assert.deepEqual(pg.ports, [{ host: 55000, container: 5432 }]);
      assert.equal(pg.storage, "tmpfs");
      assert.deepEqual(pg.env.find((e: any) => e.name === "POSTGRES_PASSWORD"), { name: "POSTGRES_PASSWORD", source: "manifest", value: "••••", sensitive: true });
      assert.equal(pg.proxy, undefined, "postgres no habla HTTP: sin proxy");

      const svc = byName["pedidos-svc"];
      assert.equal(svc.image, "localhost/testcase-pedidos-svc:latest");
      assert.deepEqual(svc.build, { context: "./services/pedidos", dockerfile: "Dockerfile" });
      assert.deepEqual(svc.dependsOn, ["postgres"]);
      assert.deepEqual(svc.ports, [{ host: 55001, container: 8080 }]);
      assert.equal(svc.proxy.listen, "http://localhost:18081");
      assert.equal(svc.proxy.upstream, "http://pedidos-svc:8080");

      assert.ok(existsSync(join(p.tc, "evidence")), "crea la carpeta de evidencia");
      const compose = readFileSync(join(p.tc, "compose.yaml"), "utf8");
      assert.match(compose, /^# Generado por run.ts --plan/);
      assert.match(compose, /^name: testcase$/m);
      // Orden topológico: postgres antes que pedidos-svc
      assert.ok(compose.indexOf("\n  postgres:") < compose.indexOf("\n  pedidos-svc:"));
      assert.match(compose, /POSTGRES_PASSWORD: "\$\{PG_PASSWORD:\?Falta la variable PG_PASSWORD\}"/);
      assert.match(compose, /context: "\.\.\/services\/pedidos"/);
      assert.match(compose, /tmpfs:\n\s+- "\/var\/lib\/postgresql\/data"/);
      assert.match(compose, /"reverse:https:\/\/api.example.com"/);
      assert.match(compose, /"hardump=\/evidence\/api.har"/);
      assert.match(compose, /"\.\/evidence:\/evidence:Z"/);
      assert.match(compose, /"18081:8080"/);

      assert.match(r.out, /# Variables que deben existir en el entorno: PG_PASSWORD/);
      assert.match(r.out, /podman compose -f .*compose.yaml up -d --build/);
      assert.match(r.out, /stop proxy-api proxy-pedidos-svc/);
      assert.match(r.out, /postgres: aplicar migration \.\/db\/migrations\/\*\.sql/);
      assert.match(r.out, /postgres: healthcheck pg_isready/);
      assert.match(r.out, /api: healthcheck GET \/healthz \(a través de http:\/\/localhost:18080\)/);
    } finally {
      p.cleanup();
    }
  });

  it("conserva puertos y proxies entre corridas", () => {
    const p = project({ "UC-01.case.ts": EXAMPLE });
    try {
      assert.equal(p.cases(["--plan"]).code, 0);
      const first = p.report().services;
      assert.equal(p.cases(["--plan"]).code, 0);
      assert.deepEqual(p.report().services, first);
    } finally {
      p.cleanup();
    }
  });

  it("escapa $ en los valores literales y marca los tmpfs sin ruta como pendientes", () => {
    const p = project({
      "UC-01.case.ts": withServices(`defineService({ name: "cache", image: "redis:7", env: { PASS: "a$b" }, storage: "tmpfs" });`),
    });
    try {
      const r = p.cases(["--plan"]);
      assert.equal(r.code, 0, r.out);
      const compose = readFileSync(join(p.tc, "compose.yaml"), "utf8");
      assert.match(compose, /PASS: "a\$\$b"/);
      assert.match(r.out, /cache: storage tmpfs sin ruta/);
      assert.doesNotMatch(r.out, /up -d --build/);
      assert.match(compose, /Proxies de evidencia: ninguno/);
    } finally {
      p.cleanup();
    }
  });

  it("compose.yaml es válido para docker compose", { skip: !hasCommand("docker", ["compose", "version"]) && "docker compose no está instalado" }, () => {
    const p = project({ "UC-01.case.ts": EXAMPLE });
    try {
      assert.equal(p.cases(["--plan"]).code, 0);
      const file = join(p.tc, "compose.yaml");
      const ok = spawnSync("docker", ["compose", "-f", file, "config", "--format", "json"], { encoding: "utf8", env: { ...process.env, PG_PASSWORD: "pg-pass" } });
      assert.equal(ok.status, 0, ok.stderr);
      const cfg = JSON.parse(ok.stdout);
      assert.deepEqual(Object.keys(cfg.services).sort(), ["pedidos-svc", "postgres", "proxy-api", "proxy-pedidos-svc"]);
      assert.equal(cfg.services.postgres.environment.POSTGRES_PASSWORD, "pg-pass");
      assert.equal(cfg.services["proxy-api"].ports[0].published, "18080");
      assert.ok(cfg.services["pedidos-svc"].build.context.endsWith("/services/pedidos"));
      assert.deepEqual(Object.keys(cfg.services["pedidos-svc"].depends_on), ["postgres"]);

      const missing = spawnSync("docker", ["compose", "-f", file, "config"], { encoding: "utf8", env: { ...process.env, PG_PASSWORD: undefined } });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /Falta la variable PG_PASSWORD/);
    } finally {
      p.cleanup();
    }
  });
});
