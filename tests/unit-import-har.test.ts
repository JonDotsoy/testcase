/**
 * import-har.ts: convierte la evidencia del proxy (HAR de mitmdump) en requests del reporte.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { b64, baseReport, har, harEntry, readJson, runScript, SCRIPTS, tempDir, validateReport, writeJson } from "./helpers.ts";

const IMPORT = join(SCRIPTS, "import-har.ts");
const SYNC = join(SCRIPTS, "sync-report.ts");

describe("import-har", () => {
  let dir: string;
  let cleanup: () => void;
  let reportFile: string;
  let harFile: string;
  const start = new Date(Date.now() - 4_000);
  const at = (ms: number) => new Date(start.getTime() + ms);

  before(() => {
    ({ dir, cleanup } = tempDir());
    reportFile = join(dir, "report.json");
    harFile = join(dir, "evidence", "api.har");
    const report = baseReport({ startedAt: start.toISOString(), runId: "run_7" });
    writeJson(reportFile, report);
    mkdirSync(join(dir, "evidence"));
    writeJson(
      harFile,
      har([
        // 0: login con password, tags y anotaciones con ñ
        harEntry({
          method: "POST",
          url: "http://localhost:18080/v1/auth/token?cliente=Pedro-77-secreto",
          started: at(100),
          headers: {
            "Content-Type": "application/json",
            "x-testcase-uc": "UC-01",
            "x-testcase-step": "UC-01.s1",
            "x-testcase-request": "UC-01.s1.r1",
            "x-testcase-annotations": b64({ usuario: "Peña", paso: "given" }),
          },
          body: JSON.stringify({ username: "pedro", password: "Pedro-77", nested: [{ token: "abc" }], nota: "clave Pedro-77-secreto" }),
          resBody: JSON.stringify({ access_token: "tok_1234567890" }),
          resHeaders: { "content-type": "application/json", "set-cookie": "sid=xyz; Path=/" },
        }),
        // 1: CSS del navegador, se omite
        harEntry({ url: "http://localhost:18080/app.css", started: at(150), headers: { "x-testcase-uc": "UC-01" }, resMime: "text/css", resBody: "body{}" }),
        // 2: sin header del caso, se omite
        harEntry({ url: "http://localhost:18080/healthz", started: at(160) }),
        // 3: de una corrida anterior, se omite
        harEntry({ url: "http://localhost:18080/v1/orders/1", started: new Date(start.getTime() - 60_000), headers: { "x-testcase-uc": "UC-01" } }),
        // 4: caso que no existe, se omite
        harEntry({ url: "http://localhost:18080/v1/orders/1", started: at(170), headers: { "x-testcase-uc": "UC-99" } }),
        // 5: DELETE con bearer, 403
        harEntry({
          method: "DELETE",
          url: "http://localhost:18080/v1/orders/ord_01",
          started: at(300),
          headers: { authorization: "Bearer tok_1234567890", "x-testcase-uc": "UC-01", "x-testcase-step": "UC-01.s2", "x-testcase-request": "UC-01.s2.r1" },
          status: 403,
          statusText: "Forbidden",
          resBody: JSON.stringify({ error: "forbidden" }),
          time: 33,
        }),
        // 6: GraphQL
        harEntry({
          method: "POST",
          url: "http://localhost:18080/graphql",
          started: at(400),
          headers: { "x-testcase-uc": "UC-01", "x-testcase-step": "UC-01.s3" },
          body: JSON.stringify({ query: "mutation CancelOrder { cancel(id: 1) { ok } }" }),
          resBody: JSON.stringify({ errors: [{ message: "no" }] }),
        }),
        // 7: texto plano con un valor sensible
        harEntry({
          url: "http://localhost:18080/v1/echo",
          started: at(500),
          headers: { "x-testcase-uc": "UC-01", "x-testcase-step": "UC-01.s3" },
          resMime: "text/plain",
          resBody: "hola Pedro-77-secreto",
        }),
      ]),
    );
    writeJson(join(dir, "run-sensitive.json"), { runId: "run_7", values: ["Pedro-77-secreto", "abc"] });
    writeJson(join(dir, "run-assertions.json"), {
      runId: "run_7",
      cases: [
        {
          id: "UC-01",
          checks: [
            { tag: "UC-01.s1.r1", tagKind: "request", expression: "login responde 200", passed: true },
            { tag: "UC-01.s2.r1", tagKind: "request", expression: "status es 403", passed: false, expected: 403, actual: 200 },
            { tag: "UC-01.s3", tagKind: "step", expression: "el eco llega", passed: true },
            { tag: "UC-01.s9", tagKind: "step", expression: "sin request", passed: true },
          ],
          notations: [
            { tag: "UC-01.s1.r1", name: "time alive", value: "3600" },
            { tag: "UC-01.s8.r1", name: "huérfana", value: "x" },
          ],
        },
      ],
    });
  });
  after(() => cleanup());

  let first: ReturnType<typeof runScript>;
  let report: any;
  it("importa solo las entradas de la corrida, del caso y que no son estáticas", () => {
    first = runScript(IMPORT, [reportFile, harFile, "--service", "api"]);
    assert.equal(first.code, 0, first.out);
    report = readJson(reportFile);
    assert.equal(report.requests.length, 4);
    assert.deepEqual(report.requests.map((r: any) => r.evidence.entry), [0, 5, 6, 7]);
    assert.match(first.out, /Importados 4 requests/);
    assert.match(first.out, /entrada 1: archivo estático/);
    assert.match(first.out, /entrada 2: sin header x-testcase-uc/);
    assert.match(first.out, /entrada 3: es de una corrida anterior/);
    assert.match(first.out, /entrada 4: el caso UC-99 no existe/);
    assert.equal(report.requests[0].evidence.file, join("evidence", "api.har"));
    assert.equal(report.requests[0].evidence.source, "proxy");
  });

  it("reescribe la URL al endpoint real y quita los headers x-testcase-*", () => {
    const [login, del] = report.requests;
    assert.equal(login.method, "POST");
    assert.ok(login.url.startsWith("https://api.example.com/v1/auth/token"));
    assert.ok(!JSON.stringify(report.requests.map((r: any) => r.request.headers)).includes("x-testcase"));
    assert.equal(del.response.status.code, 403);
    assert.equal(del.response.status.label, "403 Forbidden");
    assert.equal(del.durationMs, 33);
    assert.ok(del.startOffsetMs >= 200 && del.startOffsetMs <= 400, String(del.startOffsetMs));
    assert.deepEqual(del.services, ["api"]);
  });

  it("decodifica las anotaciones b64 y les suma las de notation()", () => {
    const login = report.requests[0];
    assert.deepEqual(login.annotations, { usuario: "Peña", paso: "given", "time alive": "3600" });
  });

  it("enmascara campos y headers sensibles con secretRef y guarda los valores reales en secrets", () => {
    const [login, del, , echo] = report.requests;
    const { secrets, ...rest } = report;
    const all = JSON.stringify(rest);
    // Fuera de secrets, los valores solo aparecen donde se guardan tal cual: URL, anotaciones y aserciones
    for (const secret of ["Pedro-77\"", "tok_1234567890", "xyz;"]) assert.ok(!all.includes(secret), `aparece ${secret}`);
    const values = Object.values(secrets);
    for (const v of ["Pedro-77", "tok_1234567890", "Bearer tok_1234567890", "Pedro-77-secreto", "abc"]) assert.ok(values.includes(v), `falta ${v} en secrets`);
    assert.equal(login.request.body.value.password, "••••");
    assert.equal(login.request.body.value.nested[0].token, "••••");
    assert.equal(login.request.body.value.nota, "clave ••••");
    const paths = login.request.body.redactions.map((r: any) => r.path);
    assert.deepEqual(paths.sort(), ["$.nested.0.token", "$.nota", "$.password"]);
    assert.equal(login.response.body.value.access_token, "••••");
    assert.ok(login.url.endsWith("cliente=Pedro-77-secreto"), "la URL queda tal cual para reproducir el request");
    const cookie = login.response.headers.find((h: any) => h.name === "set-cookie");
    assert.equal(cookie.value, "sid=••••; Path=/");
    assert.equal(cookie.sensitive, true);
    const auth = del.request.headers.find((h: any) => h.name === "authorization");
    assert.equal(auth.value, "Bearer ••••");
    assert.match(auth.secretRef, /^sec_\d+$/);
    // Un mismo valor reutiliza su secretRef
    const pwdRef = login.request.body.redactions.find((r: any) => r.path === "$.password").secretRef;
    assert.notEqual(pwdRef, auth.secretRef);
    assert.match(del.reproduce.command, /Bearer \$TOKEN/);
    assert.deepEqual(del.reproduce.env, ["TOKEN"]);
    assert.equal(echo.response.body.encoding, "text");
    assert.equal(echo.response.body.value, "hola ••••");
    assert.deepEqual(echo.response.body.redactions.map((r: any) => r.path), ["$"]);
    assert.equal(secrets[auth.secretRef], "Bearer tok_1234567890");
    assert.equal(secrets[pwdRef], "Pedro-77");
  });

  it("reconoce GraphQL por el body", () => {
    const gql = report.requests[2];
    assert.equal(gql.protocol, "graphql");
    assert.equal(gql.method, "MUTATION");
    assert.equal(gql.target, "CancelOrder");
    assert.equal(gql.request.body.encoding, "graphql");
    assert.equal(gql.response.status.kind, "graphql");
    assert.equal(gql.response.status.errorCount, 1);
    assert.equal(gql.response.status.hasData, false);
  });

  it("une las aserciones por request o por paso y avisa las huérfanas", () => {
    const [login, del, gql, echo] = report.requests;
    assert.deepEqual(login.assertions.map((a: any) => a.expression), ["login responde 200"]);
    assert.deepEqual(del.assertions, [{ id: `r${del.id}.a1`, expression: "status es 403", passed: false, expected: 403, actual: 200 }]);
    // El check del paso va al último request de ese paso
    assert.equal(gql.assertions.length, 0);
    assert.deepEqual(echo.assertions.map((a: any) => a.expression), ["el eco llega"]);
    assert.match(first.out, /Aserciones unidas a sus requests: 3 de 4/);
    assert.match(first.out, /Anotaciones unidas a sus requests: 1 de 2/);
    assert.match(first.out, /UC-01: sin request/);
    assert.match(first.out, /notation\("huérfana"\)/);
  });

  it("el reporte importado y sincronizado cumple el schema", async () => {
    const s = runScript(SYNC, [reportFile]);
    assert.equal(s.code, 0, s.out);
    const synced = readJson(reportFile);
    assert.equal(synced.useCases[0].status, "failed");
    assert.deepEqual(await validateReport(synced), []);
  });

  it("se puede correr de nuevo sin duplicar requests", () => {
    const again = runScript(IMPORT, [reportFile, harFile, "--service", "api"]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /Importados 0 requests/);
    assert.equal(readJson(reportFile).requests.length, 4);
  });

  it("--no-secrets deja solo los valores enmascarados, también en la URL y las aserciones", () => {
    const { dir: d2, cleanup: c2 } = tempDir();
    try {
      const rf = join(d2, "report.json");
      writeJson(rf, baseReport({ startedAt: start.toISOString() }));
      const hf = join(d2, "api.har");
      writeJson(hf, har([harEntry({ method: "POST", url: "http://localhost:18080/login", started: at(10), headers: { "x-testcase-uc": "UC-01", authorization: "Basic cGVkcm86eA==" }, body: '{"password":"s3cr3t"}' })]));
      writeJson(join(d2, "run-sensitive.json"), { runId: "run_1", values: ["valor-del-caso"] });
      writeJson(join(d2, "run-assertions.json"), {
        runId: "run_1",
        cases: [{ id: "UC-01", checks: [{ tag: "s1", tagKind: "step", expression: "token == valor-del-caso", passed: false, expected: "valor-del-caso", actual: "otro" }] }],
      });
      writeJson(hf, har([harEntry({ method: "POST", url: "http://localhost:18080/login?k=valor-del-caso", started: at(10), headers: { "x-testcase-uc": "UC-01", "x-testcase-step": "s1", authorization: "Basic cGVkcm86eA==" }, body: '{"password":"s3cr3t"}' })]));
      const r = runScript(IMPORT, [rf, hf, "--service", "api", "--no-secrets"]);
      assert.equal(r.code, 0, r.out);
      const out = readJson(rf);
      assert.equal(out.secrets, undefined);
      const text = JSON.stringify(out);
      for (const v of ["valor-del-caso", "s3cr3t", "cGVkcm86eA=="]) assert.ok(!text.includes(v), `aparece ${v}`);
      assert.ok(out.requests[0].url.endsWith("k=••••"));
      assert.equal(out.requests[0].assertions[0].expected, "••••");
    } finally {
      c2();
    }
  });

  it("ignora run-assertions y run-sensitive de otra corrida", () => {
    const { dir: d2, cleanup: c2 } = tempDir();
    try {
      const rf = join(d2, "report.json");
      writeJson(rf, baseReport({ startedAt: start.toISOString(), runId: "run_2" }));
      writeJson(join(d2, "run-assertions.json"), { runId: "run_1", cases: [{ id: "UC-01", checks: [{ tag: "x", tagKind: "step", expression: "e", passed: true }] }] });
      writeJson(join(d2, "run-sensitive.json"), { runId: "run_1", values: ["visible-value"] });
      const hf = join(d2, "api.har");
      writeJson(hf, har([harEntry({ url: "http://localhost:18080/v1/visible-value", started: at(10), headers: { "x-testcase-uc": "UC-01" } })]));
      const r = runScript(IMPORT, [rf, hf, "--service", "api"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /es de la corrida run_1 y el reporte está en run_2/);
      assert.ok(readJson(rf).requests[0].url.endsWith("/v1/visible-value"));
    } finally {
      c2();
    }
  });

  it("con x-testcase-run omite las entradas de otra corrida aunque sean recientes", () => {
    const { dir: d2, cleanup: c2 } = tempDir();
    try {
      const rf = join(d2, "report.json");
      writeJson(rf, baseReport({ startedAt: start.toISOString(), runId: "run_5" }));
      const hf = join(d2, "api.har");
      writeJson(
        hf,
        har([
          harEntry({ url: "http://localhost:18080/v1/a", started: at(10), headers: { "x-testcase-run": "run_4", "x-testcase-uc": "UC-01" } }),
          // Sin x-testcase-run se acepta un segundo de desfase en los relojes
          harEntry({ url: "http://localhost:18080/v1/b", started: new Date(start.getTime() - 500), headers: { "x-testcase-uc": "UC-01" } }),
          harEntry({ url: "http://localhost:18080/v1/c", started: new Date(start.getTime() - 500), headers: { "x-testcase-run": "run_5", "x-testcase-uc": "UC-01" } }),
        ]),
      );
      const r = runScript(IMPORT, [rf, hf, "--service", "api"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /entrada 0: es de una corrida anterior/);
      const reqs = readJson(rf).requests;
      assert.deepEqual(reqs.map((x: any) => x.target), ["/v1/b", "/v1/c"]);
      assert.ok(!JSON.stringify(reqs).includes("x-testcase-run"));
    } finally {
      c2();
    }
  });

  it("falla con mensajes claros ante argumentos o servicios inválidos", () => {
    assert.equal(runScript(IMPORT, []).code, 1);
    const r = runScript(IMPORT, [reportFile, harFile, "--service", "nope"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no tiene un servicio "nope"/);
  });
});

