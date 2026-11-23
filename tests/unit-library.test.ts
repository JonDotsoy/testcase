/**
 * Librería de casos (assets/workspace/testcase.ts): sintaxis defineCase, pasos, notation, sensitive,
 * defineService y el contexto que recibe cada paso.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  check,
  createContext,
  declaredServices,
  defineCase,
  defineService,
  isHttpService,
  serviceKind,
  encodeHeaderJson,
  ensure,
  fromEnv,
  given,
  id,
  maskSensitive,
  notation,
  page,
  sensitive,
  sensitiveValues,
  takeDefinedCases,
  then,
  title,
  vars,
  when,
  CaseAbort,
  type CaseDefinition,
  type RecordedCheck,
  type RecordedNotation,
  type ServiceTarget,
} from "../testcase/assets/workspace/testcase.ts";

const decode = (h: string) => JSON.parse(Buffer.from(h.slice(4), "base64url").toString("utf8"));

/** APIRequestContext falso: guarda cada llamada y responde con lo que diga `reply`. */
function fakeApi(reply: (path: string, opts: any) => { status?: number; headers?: Record<string, string>; body?: string } = () => ({})) {
  const calls: Array<{ baseURL: string; path: string; opts: any }> = [];
  let disposed = 0;
  const newApi = async (baseURL: string) =>
    ({
      async fetch(path: string, opts: any) {
        calls.push({ baseURL, path, opts });
        const r = reply(path, opts);
        const headers = r.headers ?? { "content-type": "application/json" };
        return { status: () => r.status ?? 200, headers: () => headers, text: async () => r.body ?? "", json: async () => JSON.parse(r.body ?? "null") };
      },
      async dispose() {
        disposed++;
      },
    }) as any;
  return { calls, newApi, disposed: () => disposed };
}

function runCase(def: CaseDefinition, reply?: Parameters<typeof fakeApi>[0], runId?: string) {
  const api = fakeApi(reply);
  const services = new Map<string, ServiceTarget>([["api", { name: "api", baseURL: "http://localhost:18080/", viaProxy: true }]]);
  const checks: RecordedCheck[] = [];
  const notations: RecordedNotation[] = [];
  const requestTags: string[] = [];
  const ctx = createContext({ def, services, newApi: api.newApi, getBrowser: async () => assert.fail("no se usa el navegador"), checks, notations, requestTags, runId });
  return { ...api, ctx, checks, notations, requestTags };
}

describe("defineCase", () => {
  it("registra título, id y pasos en orden, y une los textos repetidos con ' y '", () => {
    takeDefinedCases();
    const def = defineCase(() => {
      id("UC-10");
      title(() => "Título " + "calculado");
      given("un pedido");
      when("se cancela", async () => {});
      then("responde 403", async () => {});
      then("el pedido sigue pending");
    });
    assert.equal(def.id, "UC-10");
    assert.equal(def.title, "Título calculado");
    assert.equal(def.given, "un pedido");
    assert.equal(def.then, "responde 403 y el pedido sigue pending");
    assert.deepEqual(
      def.steps.map((s) => [s.paso, s.description, !!s.fn]),
      [
        ["given", "un pedido", false],
        ["when", "se cancela", true],
        ["then", "responde 403", true],
        ["then", "el pedido sigue pending", false],
      ],
    );
    assert.deepEqual(takeDefinedCases(), [def]);
    assert.deepEqual(takeDefinedCases(), [], "takeDefinedCases vacía la lista");
  });

  it("deja el id vacío si no se declara (run.ts lo toma del archivo)", () => {
    const def = defineCase(() => {
      title("x");
      given("a");
      when("b");
      then("c");
    });
    assert.equal(def.id, "");
    takeDefinedCases();
  });

  for (const [name, build, msg] of [
    ["sin title", () => (given("a"), when("b"), then("c")), /Falta title\(\)/],
    ["sin given", () => (title("x"), when("b"), then("c")), /falta al menos un given\(\)/],
    ["sin when", () => (title("x"), given("a"), then("c")), /falta al menos un when\(\)/],
    ["sin then", () => (title("x"), given("a"), when("b")), /falta al menos un then\(\)/],
    ["title dos veces", () => (title("x"), title("y")), /una sola vez/],
    ["title vacío", () => title("  "), /texto no vacío/],
    ["función async", async () => {}, /debe ser síncrona/],
    ["defineCase anidado", () => defineCase(() => {}), /no se puede anidar/],
    ["paso con segundo argumento inválido", () => (title("x"), given("a", "no" as any)), /debe ser una función/],
  ] as const) {
    it(`falla con un mensaje claro: ${name}`, () => {
      assert.throws(() => defineCase(build as any), msg);
      takeDefinedCases();
    });
  }

  for (const [name, fn] of [
    ["title", () => title("x")],
    ["given", () => given("x")],
    ["id", () => id("UC-01")],
  ] as const) {
    it(`${name}() fuera de defineCase falla`, () => assert.throws(fn, /solo se usa dentro de defineCase/));
  }

  it("las utilidades fuera de un paso fallan con un mensaje claro", () => {
    assert.throws(() => check("x", 1, 1), /solo funciona dentro de un paso/);
    assert.throws(() => ensure("x", 1, 1), /solo funciona dentro de un paso/);
    assert.throws(() => vars.x, /solo funciona dentro de un paso/);
    assert.throws(() => page(), /solo funciona dentro de un paso/);
    assert.throws(() => notation("x", 1), /solo se usa dentro de defineCase/);
  });
});

describe("contexto de un caso", () => {
  it("corre los pasos en orden, manda los headers x-testcase-* y lee el body como JSON", async () => {
    const order: string[] = [];
    const api = defineService({ name: "api", endpoint: "https://api.example.com" });
    const def = defineCase(() => {
      id("UC-01");
      title("x");
      notation("tenant", "tienda-norte");
      given("a", async () => {
        order.push("given");
        notation("usuario", "pedro@acme.test");
        vars.res = await api.post("/v1/auth/token", { data: { email: "pedro@acme.test" }, headers: { "x-extra": "1" } });
      });
      when("b", async (t) => {
        order.push("when");
        assert.equal(t.vars.res.body.access_token, "tok");
      });
      then("c", () => {
        order.push("then");
      });
    });
    takeDefinedCases();
    const r = runCase(def, () => ({ body: '{"access_token":"tok"}' }), "run_9");
    await def.run(r.ctx.t);
    await r.ctx.close();
    assert.deepEqual(order, ["given", "when", "then"]);
    assert.equal(r.calls.length, 1);
    const c = r.calls[0];
    assert.equal(c.baseURL, "http://localhost:18080/");
    assert.equal(c.path, "v1/auth/token", "quita la barra inicial para respetar la ruta base");
    assert.equal(c.opts.method, "POST");
    assert.equal(c.opts.failOnStatusCode, false);
    assert.equal(c.opts.maxRedirects, 0);
    assert.equal(c.opts.headers["x-extra"], "1");
    assert.equal(c.opts.headers["x-testcase-uc"], "UC-01");
    assert.equal(c.opts.headers["x-testcase-run"], "run_9");
    assert.equal(c.opts.headers["x-testcase-request"], r.requestTags[0]);
    assert.ok(c.opts.headers["x-testcase-step"]);
    assert.deepEqual(decode(c.opts.headers["x-testcase-annotations"]), { tenant: "tienda-norte", paso: "given", usuario: "pedro@acme.test" });
    assert.equal(r.disposed(), 1, "cierra los clientes HTTP");
  });

  it("une check y notation al request correcto", async () => {
    const api = defineService({ name: "api", endpoint: "https://api.example.com" });
    const def = defineCase(() => {
      id("UC-02");
      title("x");
      given("sin requests", () => {
        check("antes de cualquier request", 1, 1);
      });
      when("dos requests", async () => {
        vars.a = await api.get("/a");
        vars.b = await api.get("/b");
        notation("después de b", vars.b.body.n);
        notation("sobre a", "x", { response: vars.a });
        check("sin response: el último del paso", vars.b.status(), 200);
        check("con response", vars.a.status(), 500, { response: vars.a, expectedFailure: true });
      });
      then("sin requests propios", () => {
        check("sin requests en el paso: el último del caso", vars.b.body.n, 2);
      });
    });
    takeDefinedCases();
    const r = runCase(def, (p) => (p === "a" ? { status: 500, body: '{"n":1}' } : { body: '{"n":2}' }));
    await def.run(r.ctx.t);
    const [tagA, tagB] = r.requestTags;
    assert.deepEqual(
      r.checks.map((c) => [c.expression, c.tagKind, c.tag === tagA ? "a" : c.tag === tagB ? "b" : "paso", c.passed]),
      [
        ["antes de cualquier request", "step", "paso", true],
        ["sin response: el último del paso", "request", "b", true],
        ["con response", "request", "a", true],
        ["sin requests en el paso: el último del caso", "request", "b", true],
      ],
    );
    assert.equal(r.checks[2].expectedFailure, true);
    assert.deepEqual(r.notations, [
      { tag: tagB, name: "después de b", value: 2 },
      { tag: tagA, name: "sobre a", value: "x" },
    ]);
  });

  it("check compara en profundidad y guarda esperado y actual; ensure detiene el caso", async () => {
    let after = false;
    const def = defineCase(() => {
      id("UC-03");
      title("x");
      given("a", () => {
        assert.equal(check("objetos iguales", { a: [1, 2] }, { a: [1, 2] }), true);
        assert.equal(check("distintos", { a: 1 }, { a: "1" }), false);
        ensure("falla", 1, 2);
        after = true;
      });
      when("b");
      then("c");
    });
    takeDefinedCases();
    const r = runCase(def);
    await assert.rejects(def.run(r.ctx.t), (e: unknown) => e instanceof CaseAbort && /Falló una aserción obligatoria: falla/.test(e.message));
    assert.equal(after, false);
    assert.deepEqual(r.checks.map((c) => [c.expression, c.passed]), [["objetos iguales", true], ["distintos", false], ["falla", false]]);
    assert.deepEqual([r.checks[1].expected, r.checks[1].actual], [{ a: "1" }, { a: 1 }]);
  });

  it("body: JSON parseado, texto si no es JSON, undefined si viene vacío", async () => {
    const api = defineService({ name: "api", endpoint: "https://api.example.com" });
    const seen: unknown[] = [];
    const def = defineCase(() => {
      id("UC-04");
      title("x");
      given("a");
      when("b", async () => {
        for (const p of ["json", "texto", "vacío", "json-roto"]) seen.push((await api.get(p)).body);
      });
      then("c");
    });
    takeDefinedCases();
    const r = runCase(def, (p) =>
      p === "json"
        ? { body: '{"ok":true}' }
        : p === "texto"
          ? { body: "hola", headers: { "content-type": "text/plain" } }
          : p === "vacío"
            ? { body: "" }
            : { body: "{roto" },
    );
    await def.run(r.ctx.t);
    assert.deepEqual(seen, [{ ok: true }, "hola", undefined, "{roto"]);
  });

  it("un servicio que no está en el reporte da un error con los disponibles", async () => {
    const otro = defineService({ name: "pagos-no-existe", endpoint: "https://pagos.example.com" });
    const def = defineCase(() => {
      id("UC-05");
      title("x");
      given("a", async () => {
        await otro.get("/");
      });
      when("b");
      then("c");
    });
    takeDefinedCases();
    const r = runCase(def);
    await assert.rejects(def.run(r.ctx.t), /El servicio "pagos-no-existe" no está en el reporte\. Servicios disponibles: api/);
  });

  it("servicio.url() arma la URL por el proxy", async () => {
    const api = defineService({ name: "api", endpoint: "https://api.example.com" });
    let url = "";
    const def = defineCase(() => {
      id("UC-06");
      title("x");
      given("a", () => {
        url = api.url("/pedidos/1?x=1");
      });
      when("b");
      then("c");
    });
    takeDefinedCases();
    const r = runCase(def);
    await def.run(r.ctx.t);
    assert.equal(url, "http://localhost:18080/pedidos/1?x=1");
  });
});

describe("notation", () => {
  it("devuelve el valor, normaliza la clave y acepta espacios, tildes y ñ", async () => {
    const def = defineCase(() => {
      id("UC-07");
      title("x");
      const v = notation("Time Alive", 42);
      assert.equal(v, 42);
      notation("dueño del recurso", "maria");
      notation("objeto", { a: 1 });
      given("a");
      when("b");
      then("c");
    });
    takeDefinedCases();
    assert.deepEqual(def.annotations, { "time alive": 42, "dueño del recurso": "maria", objeto: '{"a":1}' });
  });

  for (const bad of ["", "con:dos-puntos", "-empieza", "x".repeat(65)]) {
    it(`rechaza la clave ${JSON.stringify(bad.slice(0, 12))}`, () => {
      assert.throws(
        () =>
          defineCase(() => {
            notation(bad, 1);
          }),
        /el nombre usa letras/,
      );
      takeDefinedCases();
    });
  }
});

describe("sensitive", () => {
  it("devuelve el valor tal cual y lo ofusca en cualquier texto", () => {
    assert.equal(sensitive("Secreto-Uno-123"), "Secreto-Uno-123");
    assert.equal(sensitive(undefined), undefined);
    assert.equal(sensitive(987654), 987654);
    sensitive("abc"); // menos de 4 caracteres: no se registra
    assert.ok(sensitiveValues().includes("Secreto-Uno-123"));
    assert.ok(sensitiveValues().includes("987654"));
    assert.ok(!sensitiveValues().includes("abc"));
    assert.equal(maskSensitive("clave=Secreto-Uno-123&pin=987654&abc"), "clave=••••&pin=••••&abc");
  });

  it("enmascara primero el valor más largo", () => {
    sensitive("tok-largo-1234");
    sensitive("tok-largo-1234-extra");
    assert.equal(maskSensitive("x tok-largo-1234-extra y"), "x •••• y");
  });

  it("fromEnv registra el valor de la variable si existe", () => {
    process.env.TC_TEST_SECRET = "valor-del-entorno-77";
    assert.deepEqual(fromEnv("TC_TEST_SECRET"), { fromEnv: "TC_TEST_SECRET" });
    assert.ok(sensitiveValues().includes("valor-del-entorno-77"));
    delete process.env.TC_TEST_SECRET;
  });
});

describe("defineService", () => {
  it("declara servicios conectados y contenedores (image o build)", () => {
    defineService({ name: "svc-url", endpoint: "https://svc.example.com" });
    defineService({ name: "svc-img", image: "docker.io/library/postgres:16.4-alpine", ports: [{ container: 5432 }] });
    defineService({ name: "svc-build", build: "./services/x", ports: [{ container: 8080 }], http: true });
    const names = declaredServices().map((s) => s.name);
    for (const n of ["svc-url", "svc-img", "svc-build"]) assert.ok(names.includes(n), n);
  });

  it("acepta la misma definición dos veces (dos scripts autocontenidos)", () => {
    const db = defineService({ name: "svc-dup", image: "img:1" });
    defineService({ name: "svc-dup", image: "img:1" });
    defineService({ name: "svc-dep", image: "img:2", dependsOn: [db] });
    defineService({ name: "svc-dep", image: "img:2", dependsOn: ["svc-dup"] });
  });

  it("rechaza definiciones distintas con el mismo nombre", () => {
    defineService({ name: "svc-conf", endpoint: "https://a.example.com" });
    assert.throws(() => defineService({ name: "svc-conf", endpoint: "https://b.example.com" }), /declarado dos veces con definiciones distintas/);
  });

  it("declara procesos locales con comando, cwd y puerto", () => {
    const web = defineService({ name: "svc-proc", command: "bun run dev", cwd: "./apps/web", port: 3000 });
    assert.equal(serviceKind(web.definition), "process");
    assert.equal(isHttpService(web.definition), true, "con puerto habla HTTP");
    const worker = defineService({ name: "svc-worker", command: "node worker.js" });
    assert.equal(isHttpService(worker.definition), false);
    assert.equal(serviceKind({ name: "x", image: "img", command: "run" }), "provisioned", "command con image es el comando del contenedor");
    assert.equal(serviceKind({ name: "x", endpoint: "https://x.example.com" }), "connected");
    assert.throws(() => defineService({ name: "svc-bad-port", command: "x", port: 70000 }), /port debe ser un entero/);
    assert.throws(() => defineService({ name: "svc-http-no-port", command: "x", http: true }), /un proceso http necesita port/);
  });

  it("exige endpoint, image/build o command, solo uno", () => {
    assert.throws(() => defineService({ name: "nada" } as any), /declara endpoint/);
    assert.throws(() => defineService({ name: "vacío", command: "  " } as any), /declara endpoint/);
    assert.throws(() => defineService({ name: "ambos", endpoint: "https://x.example.com", image: "x" } as any), /declara endpoint/);
    assert.throws(() => defineService({ name: "url-y-comando", endpoint: "https://x.example.com", command: "x" } as any), /declara endpoint/);
    assert.throws(() => defineService({} as any), /necesita un name/);
  });
});

describe("encodeHeaderJson", () => {
  it("codifica JSON con tildes y ñ en base64url ASCII", () => {
    const h = encodeHeaderJson({ "dueño": "María" });
    assert.match(h, /^b64:[A-Za-z0-9_-]+$/);
    assert.deepEqual(decode(h), { "dueño": "María" });
  });
});
