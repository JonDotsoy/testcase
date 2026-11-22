/**
 * sync-report.ts, render-report.ts y el schema del reporte.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ASSETS, baseReport, readJson, runScript, SCRIPTS, tempDir, validateReport, writeJson } from "./helpers.ts";

const SYNC = join(SCRIPTS, "sync-report.ts");
const RENDER = join(SCRIPTS, "render-report.ts");

/** Request mínimo como lo deja import-har. */
function request(id: number, over: Record<string, any> = {}) {
  return {
    id,
    useCaseId: "UC-01",
    protocol: "http",
    transport: "HTTP/1.1 vía proxy",
    method: "GET",
    target: "/v1/orders/1",
    url: "https://api.example.com/v1/orders/1",
    services: ["api"],
    startOffsetMs: id * 100,
    durationMs: 20,
    passed: true,
    handler: { file: "agente" },
    annotations: {},
    request: { headers: [], body: { encoding: "none", value: null } },
    response: { status: { kind: "http", label: "200 OK", code: 200, reason: "OK" }, headers: [], body: { encoding: "none", value: null } },
    assertions: [],
    reproduce: { tool: "curl", command: "curl https://api.example.com/v1/orders/1", env: [] },
    evidence: { source: "proxy", file: "evidence/api.har", entry: id },
    ...over,
  };
}

describe("esquema", () => {
  it("report-schema.md trae un JSON Schema 2020-12 válido y report.example.json lo cumple", async () => {
    assert.deepEqual(await validateReport(readJson(join(ASSETS, "report.example.json"))), []);
  });

  it("rechaza reportes con errores de forma", async () => {
    const r = readJson(join(ASSETS, "report.example.json"));
    r.reportVersion = "9.9";
    delete r.run;
    const errors = await validateReport(r);
    assert.ok(errors.length >= 2, errors.join("\n"));
  });

  it("acepta claves de anotación con tildes, ñ y espacios, y rechaza mayúsculas", async () => {
    const r = baseReport();
    r.requests = [request(1, { annotations: { "time alive": "3600", "año": "2026" } })];
    let s = runSync(r);
    assert.deepEqual(await validateReport(s), []);
    s.requests[0].annotations = { Usuario: "x" };
    assert.ok((await validateReport(s)).length > 0);
  });
});

function runSync(report: any, extra: string[] = []) {
  const { dir, cleanup } = tempDir();
  try {
    const f = join(dir, "report.json");
    writeJson(f, report);
    const r = runScript(SYNC, [f, ...extra]);
    assert.equal(r.code, 0, r.out);
    return readJson(f);
  } finally {
    cleanup();
  }
}

describe("sync-report", () => {
  it("deja pending un caso sin requests y el reporte vacío cumple el schema", async () => {
    const s = runSync(baseReport());
    assert.equal(s.useCases[0].status, "pending");
    assert.deepEqual(s.useCases[0].requestIds, []);
    assert.equal(s.summary.useCases.total, 1);
    assert.deepEqual(await validateReport(s), []);
  });

  it("calcula passed, requestIds, invocaciones, conteos y estado de la corrida", async () => {
    const r = baseReport();
    r.requests = [
      request(2, { startOffsetMs: 300, assertions: [{ expression: "status 200", passed: true }] }),
      request(1, { startOffsetMs: 100, assertions: [{ expression: "status 200", passed: true }] }),
      request(3, { startOffsetMs: 500, method: "DELETE", target: "/v1/orders/1", assertions: [{ expression: "status 403", passed: false, expected: 403, actual: 200 }] }),
    ];
    const s = runSync(r);
    assert.deepEqual(s.requests.map((x: any) => x.id), [1, 2, 3]);
    assert.deepEqual(s.requests.map((x: any) => x.passed), [true, true, false]);
    assert.equal(s.requests[2].assertions[0].id, "r3.a1");
    const uc = s.useCases[0];
    assert.deepEqual(uc.requestIds, [1, 2, 3]);
    assert.equal(uc.status, "failed");
    assert.match(uc.failure.explanation, /se esperaba 403 y se recibió 200/);
    assert.deepEqual(uc.failure.requestIds, [3]);
    assert.deepEqual(uc.failure.assertionIds, ["r3.a1"]);
    const get = uc.invocations.find((i: any) => i.method === "GET");
    assert.equal(get.count, 2);
    assert.equal(s.services[0].requestCount, 3);
    assert.deepEqual(s.timeline.filter((t: any) => t.kind === "request").map((t: any) => t.ref), [1, 2, 3]);
    assert.equal(s.run.status, "failed");
    assert.equal(s.run.exitCode, 1);
    assert.equal(s.summary.useCases.failed, 1);
    assert.equal(s.summary.requests.total, 3);
    assert.deepEqual(await validateReport(s), []);
  });

  it("marca passed la corrida cuando todo pasa", () => {
    const r = baseReport();
    r.requests = [request(1, { assertions: [{ expression: "ok", passed: true }] })];
    const s = runSync(r);
    assert.equal(s.useCases[0].status, "passed");
    assert.equal(s.run.status, "passed");
    assert.equal(s.run.exitCode, 0);
  });

  it("es idempotente y --check detecta un reporte desincronizado", () => {
    const { dir, cleanup } = tempDir();
    try {
      const f = join(dir, "report.json");
      const r = baseReport();
      r.requests = [request(1, { assertions: [{ expression: "ok", passed: false }] })];
      writeJson(f, r);
      assert.equal(runScript(SYNC, [f, "--check"]).code, 1, "antes de sincronizar");
      assert.equal(runScript(SYNC, [f]).code, 0);
      const once = readFileSync(f, "utf8");
      assert.equal(runScript(SYNC, [f, "--check"]).code, 0, "después de sincronizar");
      assert.equal(runScript(SYNC, [f]).code, 0);
      assert.equal(readFileSync(f, "utf8"), once);
    } finally {
      cleanup();
    }
  });

  it("sin argumentos muestra el uso y termina con 1", () => {
    const r = runScript(SYNC, []);
    assert.equal(r.code, 1);
    assert.match(r.out, /Uso: node sync-report.ts/);
  });
});

describe("render-report", () => {
  let dir: string;
  let cleanup: () => void;
  before(() => ({ dir, cleanup } = tempDir()));
  after(() => cleanup());

  it("genera un HTML autocontenido desde report.example.json", () => {
    const f = join(dir, "example.json");
    copyFileSync(join(ASSETS, "report.example.json"), f);
    const r = runScript(RENDER, [f]);
    assert.equal(r.code, 0, r.out);
    const html = readFileSync(join(dir, "example.html"), "utf8");
    assert.ok(html.startsWith("<!doctype html>"));
    assert.match(html, /<title>[^<]*Reporte testmania/);
    assert.ok(!html.includes("{{"), "quedan marcadores sin reemplazar");
    const json = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(json, "no trae el JSON incrustado");
    const embedded = JSON.parse(json![1]);
    assert.equal(embedded.useCases.length, readJson(f).useCases.length);
    assert.match(r.out, /casos de uso/);
  });

  it("escapa el JSON incrustado para que no cierre el <script>", () => {
    const r = baseReport();
    r.useCases[0].title = "</script><script>alert(1)</script>";
    const f = join(dir, "xss.json");
    writeJson(f, runSync(r));
    const out = join(dir, "xss.html");
    assert.equal(runScript(RENDER, [f, "-o", out]).code, 0);
    const html = readFileSync(out, "utf8");
    assert.ok(!html.includes("</script><script>alert(1)"));
    assert.ok(html.includes("\\u003c/script\\u003e"));
  });

  it("--fragment escribe solo el contenido y --strip-secrets quita los valores reales", () => {
    const r = runSync(baseReport());
    r.secrets = { sec_1: "valor-secreto-real" };
    r.run.secretsIncluded = true;
    const f = join(dir, "frag.json");
    writeJson(f, r);
    const out = join(dir, "frag.html");
    const res = runScript(RENDER, [f, "-o", out, "--fragment", "--strip-secrets"]);
    assert.equal(res.code, 0, res.out);
    const html = readFileSync(out, "utf8");
    assert.ok(!html.includes("<!doctype"));
    assert.ok(!html.includes("<body>"));
    assert.ok(!html.includes("valor-secreto-real"));
    assert.match(res.out, /sin valores sensibles/);

    const full = join(dir, "full.html");
    assert.equal(runScript(RENDER, [f, "-o", full]).code, 0);
    assert.ok(readFileSync(full, "utf8").includes("valor-secreto-real"), "sin --strip-secrets se incluyen");
  });

  it("rechaza reportes inconsistentes con un mensaje para el agente", () => {
    const r = runSync(baseReport());
    delete r.services[0].health;
    r.services.push({ name: "db", mode: "provisioned", image: "postgres:16", ports: [], requestCount: 0, health: { check: "pg_isready", status: "healthy" } });
    r.requests = [request(1, { useCaseId: "UC-77", services: ["fantasma"] })];
    r.useCases[0].requestIds = [42];
    r.useCases[0].status = "failed";
    const f = join(dir, "bad.json");
    writeJson(f, r);
    const res = runScript(RENDER, [f, "-o", join(dir, "bad.html")]);
    assert.equal(res.code, 1);
    for (const msg of [
      /el servicio "api" no tiene health/,
      /el servicio "db" no tiene artifacts/,
      /request 1 apunta a un caso de uso que no existe \(UC-77\)/,
      /UC-01 apunta al request 42, que no existe/,
      /UC-01 está fallido pero no trae "failure"/,
      /request 1 usa el servicio "fantasma"/,
    ])
      assert.match(res.stderr, msg);
    assert.ok(!existsSync(join(dir, "bad.html")));
  });

  it("valida los argumentos", () => {
    assert.equal(runScript(RENDER, []).code, 1);
    assert.match(runScript(RENDER, ["a.json", "--nope"]).stderr, /Opción desconocida: --nope/);
    assert.match(runScript(RENDER, [join(dir, "no-existe.json")]).stderr, /no pude leer/);
  });
});
