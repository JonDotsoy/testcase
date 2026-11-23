/**
 * Librería de casos (assets/workspace/testcase.ts): sintaxis defineCase, pasos, notation, sensitive,
 * defineService y el contexto que recibe cada paso.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  between,
  check,
  createContext,
  instanceOf,
  satisfies,
  declaredServices,
  defineCase,
  defineService,
  describe as describeCase,
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
  withCookies,
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
  it("registra título, id y pasos en orden sin ejecutarlos, y une los textos repetidos con ' y '", async () => {
    await takeDefinedCases();
    let ran = false;
    const def = await defineCase(async () => {
      await id("UC-10");
      await title(() => "Título " + "calculado");
      await describeCase("  Contexto del caso: por qué importa.  ");
      const pedido = await given("un pedido", async () => ((ran = true), { id: "ord_1" }));
      // Al registrar, el valor de un paso acepta propiedades y llamadas sin fallar
      const ruta = `/v1/orders/${pedido.id}`;
      await when("se cancela", async () => ((ran = true), ruta));
      await then("responde 403", async () => {});
      await then("el pedido sigue pending");
    });
    assert.equal(ran, false, "los pasos no corren al registrar");
    assert.equal(def.id, "UC-10");
    assert.equal(def.title, "Título calculado");
    assert.equal(def.description, "Contexto del caso: por qué importa.");
    assert.equal(def.given, "un pedido");
    assert.equal(def.then, "responde 403 y el pedido sigue pending");
    assert.deepEqual(
      def.steps.map((s) => [s.paso, s.description]),
      [
        ["given", "un pedido"],
        ["when", "se cancela"],
        ["then", "responde 403"],
        ["then", "el pedido sigue pending"],
      ],
    );
    assert.deepEqual(await takeDefinedCases(), [def]);
    assert.deepEqual(await takeDefinedCases(), [], "takeDefinedCases vacía la lista");
  });

  it("title, describe, id y los pasos aceptan string, Promise<string> o una función que devuelve cualquiera", async () => {
    await takeDefinedCases();
    const later = (v: string) => new Promise<string>((ok) => setTimeout(() => ok(v), 5));
    const def = await defineCase(async () => {
      await id(later("UC-42"));
      await title(async () => "Título " + (await later("async")));
      await describeCase(later("Descripción en una promesa"));
      await given(later("un pedido"));
      await when(() => later("se cancela"), async () => "ok");
      await then("responde 403");
    });
    await takeDefinedCases();
    assert.equal(def.id, "UC-42");
    assert.equal(def.title, "Título async");
    assert.equal(def.description, "Descripción en una promesa");
    assert.deepEqual(def.steps.map((s) => s.description), ["un pedido", "se cancela", "responde 403"]);
    await assert.rejects(defineCase(async () => (await title(later("  ")), await given("a"))), /title\(\) necesita un texto no vacío/);
    await takeDefinedCases().catch(() => {});
  });

  it("takeDefinedCases espera a los defineCase sin await y deja el id vacío si no se declara", async () => {
    defineCase(async () => {
      await title("sin await");
      await given("a");
      await when("b");
      await then("c");
    });
    const [def] = await takeDefinedCases();
    assert.equal(def.title, "sin await");
    assert.equal(def.id, "");
  });

  for (const [name, build, msg] of [
    ["sin title", async () => (await given("a"), await when("b"), await then("c")), /Falta title\(\)/],
    ["sin given", async () => (await title("x"), await when("b"), await then("c")), /falta al menos un given\(\)/],
    ["sin when", async () => (await title("x"), await given("a"), await then("c")), /falta al menos un when\(\)/],
    ["sin then", async () => (await title("x"), await given("a"), await when("b")), /falta al menos un then\(\)/],
    ["title dos veces", async () => (await title("x"), await title("y")), /una sola vez/],
    ["title vacío", () => title("  "), /texto no vacío/],
    ["describe dos veces", async () => (await title("x"), await describeCase("a"), await describeCase("b")), /describe\(\) se declara una sola vez/],
    ["describe vacío", () => describeCase(""), /texto no vacío/],
    ["defineCase anidado", () => defineCase(async () => {}), /no se puede anidar/],
    ["paso con segundo argumento inválido", async () => (await title("x"), await given("a", "no" as any)), /debe ser una función/],
    ["request fuera de un paso", async () => (await title("x"), page()), /solo funciona dentro de un paso/],
  ] as const) {
    it(`falla con un mensaje claro: ${name}`, async () => {
      await assert.rejects(defineCase(build as any), msg);
      await assert.rejects(takeDefinedCases(), msg, "takeDefinedCases también lo informa");
    });
  }

  for (const [name, fn] of [
    ["title", () => title("x")],
    ["given", () => given("x")],
    ["id", () => id("UC-01")],
  ] as const) {
    it(`${name}() fuera de defineCase falla`, async () => {
      await assert.rejects(async () => fn(), /solo se usa dentro de defineCase/);
    });
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
  it("corre los pasos en orden, devuelve sus valores, manda los headers x-testcase-* y lee el body como JSON", async () => {
    const order: string[] = [];
    const api = await defineService({ name: "api", endpoint: "https://api.example.com" });
    const def = await defineCase(async () => {
      await id("UC-01");
      await title("x");
      notation("tenant", "tienda-norte");
      const login = await given("a", async () => {
        order.push("given");
        notation("usuario", "pedro@acme.test");
        return api.post("/v1/auth/token", { data: { email: "pedro@acme.test" }, headers: { "x-extra": "1" } });
      });
      const token: string = login.body.access_token; // entre pasos: con datos reales al correr
      order.push(`token=${token}`);
      await when("b", async (t) => {
        order.push("when");
        assert.equal(t.vars.n, undefined);
      });
      await then("c", () => {
        order.push("then");
      });
    });
    await takeDefinedCases();
    assert.deepEqual(order, ["token="], "al registrar, el token es un valor vacío");
    order.length = 0;
    const r = runCase(def, () => ({ body: '{"access_token":"tok"}' }), "run_9");
    await def.run(r.ctx.t);
    await r.ctx.close();
    assert.deepEqual(order, ["given", "token=tok", "when", "then"]);
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

  it("un paso sin await o anidado falla con un mensaje claro", async () => {
    const sinAwait = await defineCase(async () => {
      await title("x");
      given("a", async () => new Promise((ok) => setTimeout(ok, 20)));
      await when("b");
      await then("c");
    });
    const anidado = await defineCase(async () => {
      await title("y");
      await given("a", async () => {
        await when("b dentro de a");
      });
      await when("b");
      await then("c");
    });
    const alFinal = await defineCase(async () => {
      await title("z");
      await given("a");
      await when("b");
      then("c", async () => new Promise((ok) => setTimeout(ok, 20)));
    });
    await takeDefinedCases();
    await assert.rejects(sinAwait.run(runCase(sinAwait).ctx.t), /Falta await antes de given\("a"\): when\("b"\) empezó con el paso anterior todavía corriendo/);
    await assert.rejects(anidado.run(runCase(anidado).ctx.t), /when\(\) no se usa dentro de un paso \(given\("a"\)\)/);
    await assert.rejects(alFinal.run(runCase(alFinal).ctx.t), /Falta await antes de then\("c"\): el caso terminó/);
  });

  it("une check y notation al request correcto", async () => {
    const api = await defineService({ name: "api", endpoint: "https://api.example.com" });
    const def = await defineCase(async () => {
      await id("UC-02");
      await title("x");
      await given("sin requests", () => {
        check("antes de cualquier request", 1, 1);
      });
      const [a, b] = await when("dos requests", async () => {
        const a = await api.get("/a");
        const b = await api.get("/b");
        notation("después de b", b.body.n);
        notation("sobre a", "x", { response: a });
        check("sin response: el último del paso", b.status(), 200);
        check("con response", a.status(), 500, { response: a, expectedFailure: true });
        return [a, b];
      });
      await then("sin requests propios", () => {
        check("sin requests en el paso: el último del caso", b.body.n, 2);
        check("valor de otro paso", a.body.n, 1);
      });
    });
    await takeDefinedCases();
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
        ["valor de otro paso", "request", "b", true],
      ],
    );
    assert.equal(r.checks[2].expectedFailure, true);
    assert.deepEqual(r.notations, [
      { tag: tagB, name: "después de b", value: 2 },
      { tag: tagA, name: "sobre a", value: "x" },
    ]);
  });

  it("vars sigue disponible entre pasos y en el cuerpo del caso", async () => {
    const seen: unknown[] = [];
    const def = await defineCase(async () => {
      await title("x");
      await given("a", () => {
        vars.n = 1;
      });
      vars.n += 1;
      await when("b", (t) => {
        seen.push(vars.n, t.vars.n);
      });
      await then("c");
    });
    await takeDefinedCases();
    await def.run(runCase(def).ctx.t);
    assert.deepEqual(seen, [2, 2]);
  });

  it("check compara en profundidad y guarda esperado y actual; ensure detiene el caso", async () => {
    let after = false;
    let siguiente = false;
    const def = await defineCase(async () => {
      await id("UC-03");
      await title("x");
      await given("a", () => {
        assert.equal(check("objetos iguales", { a: [1, 2] }, { a: [1, 2] }), true);
        assert.equal(check("distintos", { a: 1 }, { a: "1" }), false);
        ensure("falla", 1, 2);
        after = true;
      });
      await when("b", () => {
        siguiente = true;
      });
      await then("c");
    });
    await takeDefinedCases();
    const r = runCase(def);
    await assert.rejects(def.run(r.ctx.t), (e: unknown) => e instanceof CaseAbort && /Falló una aserción obligatoria: falla/.test(e.message));
    assert.equal(after, false);
    assert.equal(siguiente, false, "los pasos siguientes no corren");
    assert.deepEqual(r.checks.map((c) => [c.expression, c.passed]), [["objetos iguales", true], ["distintos", false], ["falla", false]]);
    assert.deepEqual([r.checks[1].expected, r.checks[1].actual], [{ a: "1" }, { a: 1 }]);
  });

  it("check acepta un validador como esperado: instancia, rango, función propia", async () => {
    const def = await defineCase(async () => {
      await id("UC-04");
      await title("x");
      await given("a", () => {
        assert.equal(check("es fecha", new Date(), instanceOf(Date)), true);
        assert.equal(check("no es fecha", "2026-11-23", instanceOf(Date)), false);
        assert.equal(check("en rango", 250, between(0, 500)), true);
        assert.equal(check("fuera de rango", 900, between(0, 500)), false);
        assert.equal(check("positivo", 3, (n: number) => n > 0), true);
        assert.equal(check("par", 3, satisfies("número par", (n: number) => n % 2 === 0)), false);
        assert.equal(
          check("lanza", null, (v: any) => v.id === 1),
          false,
        );
        ensure("ensure con validador", "abc", (s: string) => s.startsWith("a"));
      });
      await when("b", () => {
        assert.throws(() => check("no booleano", 1, () => "sí" as any), /debe devolver true o false/);
        assert.throws(() => check("async", 1, (async () => true) as any), /no puede ser async/);
      });
      await then("c");
    });
    await takeDefinedCases();
    const r = runCase(def);
    await def.run(r.ctx.t);
    const by = Object.fromEntries(r.checks.map((c) => [c.expression, c]));
    assert.deepEqual(
      r.checks.map((c) => [c.expression, c.passed]),
      [["es fecha", true], ["no es fecha", false], ["en rango", true], ["fuera de rango", false], ["positivo", true], ["par", false], ["lanza", false], ["ensure con validador", true]],
    );
    assert.equal(by["no es fecha"].expected, "instancia de Date");
    assert.equal(by["fuera de rango"].expected, "entre 0 y 500");
    assert.equal(by["fuera de rango"].actual, 900);
    assert.equal(by["positivo"].expected, "(n) => n > 0", "sin descripción, el esperado es el código del validador");
    assert.equal(by["par"].expected, "número par");
    assert.match(String(by["lanza"].expected), /^\(v\) => v\.id === 1 \(lanzó: .*null/);
  });

  it("cookies arma el header Cookie y se suma a uno que ya venga en headers", async () => {
    const api = await defineService({ name: "api", endpoint: "https://api.example.com" });
    const def = await defineCase(async () => {
      await id("UC-05");
      await title("x");
      await given("a", () => api.get("/a", { cookies: { "my-cookie": "true", sesion: "a b;c" } }));
      await when("b", () => api.get("/b", { headers: { Cookie: "previa=1" }, cookies: { n: 2 } }));
      await then("c", () => api.get("/c"));
    });
    await takeDefinedCases();
    const r = runCase(def);
    await def.run(r.ctx.t);
    const h = r.calls.map((c) => c.opts.headers);
    assert.equal(h[0].cookie, "my-cookie=true; sesion=a%20b%3Bc");
    assert.equal(h[1].cookie, "previa=1; n=2");
    assert.equal(h[1].Cookie, undefined, "queda un solo header cookie");
    assert.equal(h[2].cookie, undefined, "sin cookies no se agrega el header");
    assert.throws(() => withCookies({}, { "mal nombre": "x" }), /no es un nombre de cookie válido/);
  });

  it("body: JSON parseado, texto si no es JSON, undefined si viene vacío", async () => {
    const api = await defineService({ name: "api", endpoint: "https://api.example.com" });
    const def = await defineCase(async () => {
      await id("UC-04");
      await title("x");
      await given("a");
      const seen = await when("b", async () => {
        const out: unknown[] = [];
        for (const p of ["json", "texto", "vacío", "json-roto"]) out.push((await api.get(p)).body);
        return out;
      });
      await then("c", () => {
        assert.deepEqual(seen, [{ ok: true }, "hola", undefined, "{roto"]);
      });
    });
    await takeDefinedCases();
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
  });

  it("un servicio que no está en el reporte da un error con los disponibles", async () => {
    const otro = await defineService({ name: "pagos-no-existe", endpoint: "https://pagos.example.com" });
    const def = await defineCase(async () => {
      await id("UC-05");
      await title("x");
      await given("a", async () => {
        await otro.get("/");
      });
      await when("b");
      await then("c");
    });
    await takeDefinedCases();
    const r = runCase(def);
    await assert.rejects(def.run(r.ctx.t), /El servicio "pagos-no-existe" no está en el reporte\. Servicios disponibles: api/);
  });

  it("servicio.url() arma la URL por el proxy", async () => {
    const api = await defineService({ name: "api", endpoint: "https://api.example.com" });
    let url = "";
    const def = await defineCase(async () => {
      await id("UC-06");
      await title("x");
      await given("a", () => {
        url = api.url("/pedidos/1?x=1");
      });
      await when("b");
      await then("c");
    });
    await takeDefinedCases();
    const r = runCase(def);
    await def.run(r.ctx.t);
    assert.equal(url, "http://localhost:18080/pedidos/1?x=1");
  });
});

describe("notation", () => {
  it("devuelve el valor, normaliza la clave y acepta espacios, tildes y ñ", async () => {
    const def = await defineCase(async () => {
      await id("UC-07");
      await title("x");
      const v = notation("Time Alive", 42);
      assert.equal(v, 42);
      notation("dueño del recurso", "maria");
      notation("objeto", { a: 1 });
      await given("a");
      await when("b");
      await then("c");
    });
    await takeDefinedCases();
    assert.deepEqual(def.annotations, { "time alive": 42, "dueño del recurso": "maria", objeto: '{"a":1}' });
    await def.run(runCase(def).ctx.t); // al correr, la anotación del caso no vuelve a registrarse ni falla
  });

  for (const bad of ["", "con:dos-puntos", "-empieza", "x".repeat(65)]) {
    it(`rechaza la clave ${JSON.stringify(bad.slice(0, 12))}`, async () => {
      await assert.rejects(
        defineCase(async () => {
          notation(bad, 1);
        }),
        /el nombre usa letras/,
      );
      await takeDefinedCases().catch(() => {});
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
  it("declara servicios conectados y contenedores (image o build)", async () => {
    await defineService({ name: "svc-url", endpoint: "https://svc.example.com" });
    await defineService({ name: "svc-img", image: "docker.io/library/postgres:16.4-alpine", ports: [{ container: 5432 }] });
    await defineService({ name: "svc-build", build: "./services/x", ports: [{ container: 8080 }], http: true });
    const names = declaredServices().map((s) => s.name);
    for (const n of ["svc-url", "svc-img", "svc-build"]) assert.ok(names.includes(n), n);
  });

  it("acepta la misma definición dos veces (dos scripts autocontenidos)", async () => {
    const db = await defineService({ name: "svc-dup", image: "img:1" });
    await defineService({ name: "svc-dup", image: "img:1" });
    await defineService({ name: "svc-dep", image: "img:2", dependsOn: [db] });
    await defineService({ name: "svc-dep", image: "img:2", dependsOn: ["svc-dup"] });
  });

  it("rechaza definiciones distintas con el mismo nombre", async () => {
    await defineService({ name: "svc-conf", endpoint: "https://a.example.com" });
    await assert.rejects(defineService({ name: "svc-conf", endpoint: "https://b.example.com" }), /declarado dos veces con definiciones distintas/);
  });

  it("declara procesos locales con comando, cwd y puerto", async () => {
    const web = await defineService({ name: "svc-proc", command: "bun run dev", cwd: "./apps/web", port: 3000 });
    assert.equal(serviceKind(web.definition), "process");
    assert.equal(isHttpService(web.definition), true, "con puerto habla HTTP");
    const worker = await defineService({ name: "svc-worker", command: "node worker.js" });
    assert.equal(isHttpService(worker.definition), false);
    assert.equal(serviceKind({ name: "x", image: "img", command: "run" }), "provisioned", "command con image es el comando del contenedor");
    assert.equal(serviceKind({ name: "x", endpoint: "https://x.example.com" }), "connected");
    await assert.rejects(defineService({ name: "svc-bad-port", command: "x", port: 70000 }), /port debe ser un entero/);
    await assert.rejects(defineService({ name: "svc-http-no-port", command: "x", http: true }), /un proceso http necesita port/);
  });

  it("exige endpoint, image/build o command, solo uno", async () => {
    await assert.rejects(defineService({ name: "nada" } as any), /declara endpoint/);
    await assert.rejects(defineService({ name: "vacío", command: "  " } as any), /declara endpoint/);
    await assert.rejects(defineService({ name: "ambos", endpoint: "https://x.example.com", image: "x" } as any), /declara endpoint/);
    await assert.rejects(defineService({ name: "url-y-comando", endpoint: "https://x.example.com", command: "x" } as any), /declara endpoint/);
    await assert.rejects(defineService({} as any), /necesita un name/);
  });

  it("se usa con await: sin await, takeDefinedCases() informa el error", async () => {
    await takeDefinedCases().catch(() => {}); // descarta las promesas rechazadas de las pruebas anteriores
    const p = defineService({ name: "svc-sin-await" } as any);
    assert.ok(p instanceof Promise);
    await assert.rejects(takeDefinedCases(), /"svc-sin-await".*declara endpoint/);
    assert.deepEqual(await takeDefinedCases(), [], "el error no queda pendiente");
  });
});

describe("encodeHeaderJson", () => {
  it("codifica JSON con tildes y ñ en base64url ASCII", () => {
    const h = encodeHeaderJson({ "dueño": "María" });
    assert.match(h, /^b64:[A-Za-z0-9_-]+$/);
    assert.deepEqual(decode(h), { "dueño": "María" });
  });
});
