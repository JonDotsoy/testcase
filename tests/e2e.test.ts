/**
 * Flujo completo de la skill, como lo sigue el agente:
 *
 *   cases.ts --plan → (proxy de evidencia) → cases.ts → import-har → sync-report → render-report
 *
 * En vez de Podman y mitmdump usa, en el mismo proceso, un servidor de prueba y un proxy inverso que escribe el
 * HAR con la forma de mitmdump al detenerse. Los casos corren con Playwright y Chromium de verdad.
 * Se omite si Chromium no está instalado (npx playwright install chromium).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CASES, project, readJson, SCRIPTS, validateReport, writeJson } from "./helpers.ts";

let chromiumError: string | undefined;
try {
  const { chromium } = await import("playwright");
  await (await chromium.launch()).close();
} catch (e) {
  chromiumError = `Chromium no está disponible: ${(e as Error).message.split("\n")[0]}`;
}

const PASSWORD = "Pedro-77-e2e";
const TOKEN = "tok-usr_2-abc123xyz";

/** Servidor que hace de API real. */
function upstream(): Server {
  return createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code: number, obj: unknown, ct = "application/json") => {
      const b = typeof obj === "string" ? obj : JSON.stringify(obj);
      res.writeHead(code, { "content-type": ct, "content-length": Buffer.byteLength(b) });
      res.end(b);
    };
    const url = req.url ?? "/";
    if (req.method === "POST" && url === "/v1/auth/token") {
      const data = JSON.parse(body || "{}");
      if (data.password !== PASSWORD) return send(401, { detail: "credenciales inválidas" });
      return send(200, { access_token: TOKEN, token_type: "Bearer", user: { id: "usr_2", role: "customer" } });
    }
    if (req.method === "DELETE") {
      const own = url.endsWith("ord_PEDRO");
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { detail: "sin token" });
      return send(403, { status: 403, detail: own ? "Cancelación deshabilitada." : "El pedido no pertenece al usuario." }, "application/problem+json");
    }
    if (url.startsWith("/pedidos/"))
      return send(
        200,
        '<!doctype html><link rel="stylesheet" href="/app.css"><h1>Pedido ord_01JD9</h1>Estado: <span data-estado></span>' +
          '<script>fetch("/v1/orders/ord_01JD9").then(r=>r.json()).then(o=>document.querySelector("[data-estado]").textContent=o.status)</script>',
        "text/html; charset=utf-8",
      );
    if (url === "/app.css") return send(200, "h1{color:red}", "text/css");
    if (url === "/healthz") return send(200, { ok: true });
    return send(200, { id: "ord_01JD9", status: "pending", owner: "usr_1" });
  });
}

/** Proxy inverso que guarda cada intercambio y escribe un HAR (como mitmdump --set hardump=…) al detenerse. */
function recordingProxy(target: string) {
  const entries: any[] = [];
  const server = createServer(async (req, res) => {
    const started = new Date();
    const reqBody = await readBody(req);
    const headers = { ...req.headers };
    delete headers.host;
    const up = httpRequest(new URL(req.url ?? "/", target), { method: req.method, headers }, async (ures) => {
      const resBody = await readBody(ures);
      const time = Date.now() - started.getTime();
      const pairs = (raw: string[]) => raw.reduce<any[]>((acc, v, i) => (i % 2 ? acc : [...acc, { name: v, value: raw[i + 1] }]), []);
      const mime = String(ures.headers["content-type"] ?? "");
      entries.push({
        startedDateTime: started.toISOString(),
        time,
        request: {
          method: req.method,
          url: `http://${req.headers.host}${req.url}`,
          httpVersion: "HTTP/1.1",
          headers: pairs(req.rawHeaders),
          queryString: [],
          ...(reqBody ? { postData: { mimeType: String(req.headers["content-type"] ?? ""), text: reqBody } } : {}),
        },
        response: {
          status: ures.statusCode,
          statusText: ures.statusMessage ?? "",
          httpVersion: "HTTP/1.1",
          headers: pairs(ures.rawHeaders),
          content: { size: Buffer.byteLength(resBody), mimeType: mime, text: resBody },
        },
        timings: { send: 0, wait: time, receive: 0 },
      });
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      res.end(resBody);
    });
    up.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    up.end(reqBody);
  });
  return {
    server,
    stop: (harFile: string) =>
      new Promise<void>((done) => {
        server.close(() => {
          writeFileSync(harFile, JSON.stringify({ log: { version: "1.2", creator: { name: "mitmproxy", version: "11.0.2" }, entries } }));
          done();
        });
        server.closeAllConnections();
      }),
  };
}

const readBody = (m: IncomingMessage) =>
  new Promise<string>((ok) => {
    const chunks: Buffer[] = [];
    m.on("data", (c) => chunks.push(c));
    m.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
  });

const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));

/** Como runScript, pero sin bloquear: los servidores de esta prueba corren en el mismo proceso. */
function runAsync(script: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) {
  return new Promise<{ code: number; out: string }>((ok) => {
    const p = spawn(process.execPath, [script, ...args], { cwd: opts.cwd, env: { ...process.env, NODE_NO_WARNINGS: "1", ...opts.env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => ok({ code: code ?? 1, out }));
  });
}

describe("flujo completo", { skip: chromiumError ?? false, timeout: 300_000 }, () => {
  let api: Server;
  let proxy: ReturnType<typeof recordingProxy>;
  let p: ReturnType<typeof project>;
  let apiPort: number;
  let proxyPort: number;

  before(async () => {
    api = upstream();
    apiPort = await listen(api);
    proxy = recordingProxy(`http://127.0.0.1:${apiPort}`);
    proxyPort = await listen(proxy.server);

    const header = `import { defineCase, defineService, sensitive, id, title, given, when, then, notation, check, ensure, page, vars } from "../testcase.ts";
export const api = defineService({ name: "api", endpoint: "http://127.0.0.1:${apiPort}", health: "GET /healthz" });
`;
    p = project({
      "UC-01.case.ts": `${header}
export default defineCase(() => {
  title("Cliente no puede cancelar un pedido ajeno");
  notation("tenant", "tienda-norte");

  given("un pedido creado por María", async () => {
    notation("usuario", "pedro@acme.test");
    const password = sensitive(process.env.E2E_PASSWORD ?? "");
    const login = await api.post("/v1/auth/token", { data: { email: "pedro@acme.test", password } });
    ensure("status == 200", login.status(), 200);
    vars.token = sensitive(login.body.access_token);
    notation("rol", login.body.user.role);
  });

  when("Pedro intenta cancelarlo", async () => {
    notation("dueño del recurso", "maria@acme.test");
    vars.cancel = await api.delete("/v1/orders/ord_01JD9", { headers: { authorization: \`Bearer \${vars.token}\` } });
  });

  then("la API responde 403", () => {
    check("status == 403", vars.cancel.status(), 403);
    check("detalle", vars.cancel.body.detail, "El pedido no pertenece al usuario.");
  });

  then("el pedido sigue en estado pending", async () => {
    const p = await page();
    await p.goto(api.url("/pedidos/ord_01JD9"));
    check('estado visible == "pending"', await p.locator("[data-estado]:not(:empty)").textContent(), "pending");
  });
});
`,
      // Dos casos en un archivo, uno con un fallo esperado del sistema bajo prueba
      "propios.case.ts": `${header}
defineCase(() => {
  id("UC-02");
  title("Cliente cancela su propio pedido");
  given("un pedido de Pedro", async () => {
    const login = await api.post("/v1/auth/token", { data: { password: sensitive(process.env.E2E_PASSWORD ?? "") } });
    vars.token = sensitive(login.body.access_token);
  });
  when("Pedro lo cancela", async () => {
    vars.res = await api.delete("/v1/orders/ord_PEDRO", { headers: { authorization: \`Bearer \${vars.token}\` } });
  });
  then("la API responde 204", () => check("status == 204", vars.res.status(), 204));
});

defineCase(() => {
  id("UC-03");
  title("Login con contraseña equivocada");
  given("un usuario existente");
  when("inicia sesión con otra contraseña", async () => {
    vars.res = await api.post("/v1/auth/token", { data: { password: "otra-cosa" } });
  });
  then("la API responde 401", () => ensure("status == 401", vars.res.status(), 401));
});
`,
    });
    // El agente ya registró el proxy de este servicio en otra corrida: --plan conserva su puerto.
    const r = p.report();
    r.manifest.suite = "e2e";
    r.services = [{ name: "api", mode: "connected", host: "x", endpoint: "http://x", requestCount: 0, proxy: { engine: "podman", image: "x", listen: `http://localhost:${proxyPort}`, upstream: "http://x", evidence: "evidence/api.har" } }];
    writeJson(p.reportFile, r);
  });

  after(async () => {
    await new Promise((ok) => api?.close(ok));
    proxy?.server.close();
    p?.cleanup();
  });

  const run = (args: string[]) => runAsync(CASES, ["--report", p.reportFile, "--workspace", p.ws, "--skip-install", ...args], { cwd: p.dir, env: { E2E_PASSWORD: PASSWORD } });

  it("--plan registra el servicio y su proxy", async () => {
    const r = await run(["--plan"]);
    assert.equal(r.code, 0, r.out);
    const svc = p.report().services[0];
    assert.equal(svc.endpoint, `http://127.0.0.1:${apiPort}`);
    assert.equal(svc.proxy.listen, `http://localhost:${proxyPort}`);
    assert.equal(svc.proxy.upstream, `http://127.0.0.1:${apiPort}`);
    assert.ok(existsSync(join(p.tc, "compose.yaml")));
  });

  let runOut = "";
  it("corre los casos a través del proxy", async () => {
    const r = await run([]);
    runOut = r.out;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /UC-01 Cliente no puede cancelar un pedido ajeno: 4\/4 aserciones ok/);
    assert.match(r.out, /UC-02 Cliente cancela su propio pedido: 0\/1 aserciones ok/);
    assert.match(r.out, /UC-03 Login con contraseña equivocada: 1\/1 aserciones ok/);
    const rep = p.report();
    assert.equal(rep.run.number, 2);
    assert.deepEqual(rep.useCases.map((u: any) => u.id), ["UC-01", "UC-02", "UC-03"]);
    assert.equal(rep.useCases[1].handler.file, "cases/propios.case.ts");
    const sens = join(p.tc, "run-sensitive.json");
    assert.equal(statSync(sens).mode & 0o777, 0o600);
    assert.deepEqual(readJson(sens).values.sort(), [PASSWORD, TOKEN].sort());
    const ra = readFileSync(join(p.tc, "run-assertions.json"), "utf8");
    assert.ok(!ra.includes(PASSWORD) && !ra.includes(TOKEN));
  });

  it("--only corre solo los casos pedidos", async () => {
    const r = await run(["--only", "UC-03"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /UC-03/);
    assert.doesNotMatch(r.out, /UC-01 Cliente/);
    // Vuelve a correr todo para el resto del flujo
    const all = await run([]);
    assert.equal(all.code, 0, all.out);
    assert.equal(p.report().run.number, 4);
  });

  it("importa la evidencia, sincroniza y genera el HTML sin valores sensibles", async () => {
    const har = join(p.tc, "evidence", "api.har");
    await proxy.stop(har);
    const raw = readFileSync(har, "utf8");
    assert.ok(raw.includes(PASSWORD), "el HAR crudo sí trae los valores: por eso no se comparte");

    const imp = await runAsync(join(SCRIPTS, "import-har.ts"), [p.reportFile, har, "--service", "api"], { cwd: p.dir });
    assert.equal(imp.code, 0, imp.out);
    assert.match(imp.out, /es de una corrida anterior/, "omite las corridas 2 y 3");
    assert.match(imp.out, /archivo estático/);
    assert.match(imp.out, /Aserciones unidas a sus requests: 6 de 6/);
    assert.match(imp.out, /Anotaciones unidas a sus requests: 1 de 1/);

    // El agente registra el healthcheck del servicio
    const rep = p.report();
    rep.services[0].health = { check: "GET /healthz", status: "healthy", durationMs: 5 };
    writeJson(p.reportFile, rep);

    const sync = await runAsync(join(SCRIPTS, "sync-report.ts"), [p.reportFile], { cwd: p.dir });
    assert.equal(sync.code, 0, sync.out);
    const html = join(p.tc, "report.html");
    const render = await runAsync(join(SCRIPTS, "render-report.ts"), [p.reportFile, "-o", html], { cwd: p.dir });
    assert.equal(render.code, 0, render.out);

    const final = p.report();
    assert.deepEqual(await validateReport(final), []);
    assert.deepEqual(final.useCases.map((u: any) => u.status), ["passed", "failed", "passed"]);
    assert.equal(final.run.status, "failed");
    assert.match(final.useCases[1].failure.explanation, /se esperaba 204 y se recibió 403/);

    const uc1 = final.requests.filter((r: any) => r.useCaseId === "UC-01");
    assert.deepEqual(uc1.map((r: any) => `${r.method} ${r.target}`), ["POST /v1/auth/token", "DELETE /v1/orders/ord_01JD9", "GET /pedidos/ord_01JD9", "GET /v1/orders/ord_01JD9"]);
    assert.ok(uc1.every((r: any) => r.url.startsWith(`http://127.0.0.1:${apiPort}/`)), "las URLs apuntan al servicio real, no al proxy");
    const [login, del, , xhr] = uc1;
    assert.deepEqual(login.annotations, { tenant: "tienda-norte", paso: "given", usuario: "pedro@acme.test", rol: "customer" });
    assert.equal(del.annotations["dueño del recurso"], "maria@acme.test");
    assert.equal(login.request.body.value.password, "••••");
    assert.equal(login.response.body.value.access_token, "••••");
    assert.equal(del.request.headers.find((h: any) => h.name === "authorization").value, "Bearer ••••");
    assert.deepEqual(del.assertions.map((a: any) => a.expression), ["status == 403", "detalle"]);
    assert.deepEqual(xhr.assertions.map((a: any) => a.expression), ['estado visible == "pending"']);
    assert.equal(final.services[0].requestCount, final.requests.length);

    for (const file of [p.reportFile, html, join(p.tc, "run-assertions.json")]) {
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes(PASSWORD), `${file} trae la contraseña`);
      assert.ok(!text.includes(TOKEN), `${file} trae el token`);
    }
    assert.ok(runOut.length > 0);
  });
});

describe("report.html en el navegador", { skip: chromiumError ?? false, timeout: 120_000 }, () => {
  it("la plantilla muestra los casos del ejemplo sin errores de JavaScript", async () => {
    const { chromium } = await import("playwright");
    const { tempDir, ASSETS } = await import("./helpers.ts");
    const { dir, cleanup } = tempDir();
    const browser = await chromium.launch();
    try {
      const json = join(dir, "example.json");
      writeFileSync(json, readFileSync(join(ASSETS, "report.example.json")));
      const r = await runAsync(join(SCRIPTS, "render-report.ts"), [json], { cwd: dir });
      assert.equal(r.code, 0, r.out);
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      // Sin red: las fuentes de Google se responden vacías
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await page.goto("file://" + join(dir, "example.html"));
      const example = readJson(json);
      const text = await page.locator("body").innerText();
      for (const uc of example.useCases) assert.ok(text.includes(uc.title), `no se ve "${uc.title}"`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      cleanup();
    }
  });
});
