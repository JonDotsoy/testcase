/**
 * Flujo completo de la skill, como lo sigue el agente:
 *
 *   cases.ts --only-up-services --proxy local → cases.ts (reutiliza los servicios) → cases.ts --down-services
 *   → import-har → sync-report → render-report
 *
 * El servicio es un servidor de prueba en este proceso; el proxy de evidencia es scripts/proxy.ts, que cases.ts
 * levanta con local.ts, sin contenedores. Los casos corren con Playwright y Chromium de verdad.
 * Se omite si Chromium no está instalado (npx playwright install chromium).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
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
  let p: ReturnType<typeof project>;
  let apiPort: number;
  let proxyPort: number;
  let proxyPid = 0;

  before(async () => {
    api = upstream();
    apiPort = await listen(api);
    // Un puerto libre para el proxy
    const probe = netServer();
    proxyPort = await new Promise<number>((ok) => probe.listen(0, "127.0.0.1", () => ok((probe.address() as AddressInfo).port)));
    await new Promise((ok) => probe.close(ok));

    const header = `import { defineCase, defineService, sensitive, id, title, describe, given, when, then, notation, check, ensure, page, vars } from "../testcase.ts";
export const api = await defineService({ name: "api", endpoint: "http://127.0.0.1:${apiPort}", health: "GET /healthz" });
`;
    p = project({
      "UC-01.case.ts": `${header}
await defineCase(async () => {
  await title("Cliente no puede cancelar un pedido ajeno");
  await describe("Un cliente solo cancela sus propios pedidos.");
  notation("tenant", "tienda-norte");

  const token = await given("un pedido creado por María", async () => {
    notation("usuario", "pedro@acme.test");
    const password = sensitive(process.env.E2E_PASSWORD ?? "");
    const login = await api.http.post("/v1/auth/token", { data: { email: "pedro@acme.test", password } });
    ensure("status == 200", login.status(), 200);
    notation("rol", login.body.user.role);
    return sensitive(login.body.access_token as string);
  });

  const cancel = await when("Pedro intenta cancelarlo", async () => {
    notation("dueño del recurso", "maria@acme.test");
    return api.http.delete("/v1/orders/ord_01JD9", { headers: { authorization: \`Bearer \${token}\` } });
  });

  await then("la API responde 403", () => {
    check("status == 403", cancel.status(), 403);
    check("detalle", cancel.body.detail, "El pedido no pertenece al usuario.");
  });

  await then("el pedido sigue en estado pending", async () => {
    const p = await page();
    await p.goto(api.url("/pedidos/ord_01JD9"));
    check('estado visible == "pending"', await p.locator("[data-estado]:not(:empty)").textContent(), "pending");
  });
});
`,
      // Dos casos en un archivo, uno con un fallo esperado del sistema bajo prueba
      "propios.case.ts": `${header}
await defineCase(async () => {
  await id("UC-02");
  await title("Cliente cancela su propio pedido");
  await given("un pedido de Pedro", async () => {
    const login = await api.http.post("/v1/auth/token", { data: { password: sensitive(process.env.E2E_PASSWORD ?? "") } });
    vars.token = sensitive(login.body.access_token);
  });
  const res = await when("Pedro lo cancela", async () =>
    api.http.delete("/v1/orders/ord_PEDRO", { headers: { authorization: \`Bearer \${vars.token}\` } }),
  );
  await then("la API responde 204", () => check("status == 204", res.status(), 204));
});

await defineCase(async () => {
  await id("UC-03");
  await title("Login con contraseña equivocada");
  await given("un usuario existente");
  const res = await when("inicia sesión con otra contraseña", async () => api.http.post("/v1/auth/token", { data: { password: "otra-cosa" } }));
  await then("la API responde 401", () => ensure("status == 401", res.status(), 401));
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
    if (p) await runAsync(join(SCRIPTS, "local.ts"), ["down", "--report", p.reportFile], { cwd: p.dir });
    p?.cleanup();
  });

  const run = (args: string[]) => runAsync(CASES, ["--report", p.reportFile, "--workspace", p.ws, "--skip-install", ...args], { cwd: p.dir, env: { E2E_PASSWORD: PASSWORD } });

  const local = (cmd: string) => runAsync(join(SCRIPTS, "local.ts"), [cmd, "--report", p.reportFile], { cwd: p.dir });

  it("--only-up-services --proxy local registra el servicio y levanta su proxy local, sin correr los casos", async () => {
    const r = await run(["--only-up-services", "--proxy", "local"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Servicios levantados/);
    assert.doesNotMatch(r.out, /aserciones ok/);
    assert.doesNotMatch(r.out, /# A mano/, "cases.ts ya los levantó: no imprime los comandos");
    const svc = p.report().services[0];
    assert.equal(svc.endpoint, `http://127.0.0.1:${apiPort}`);
    assert.equal(svc.proxy.engine, "local");
    assert.equal(svc.proxy.listen, `http://127.0.0.1:${proxyPort}`, "conserva el puerto que ya tenía");
    assert.equal(svc.proxy.upstream, `http://127.0.0.1:${apiPort}`);
    assert.ok(!existsSync(join(p.tc, "compose.yaml")), "sin contenedores no hay compose.yaml");
    assert.ok(svc.proxy.pid > 0);
    proxyPid = svc.proxy.pid;
    const st = await local("status");
    assert.equal(st.code, 0, st.out);
  });

  let runOut = "";
  it("sin opciones reutiliza los servicios que ya corren, corre todos los casos y los deja arriba", async () => {
    const r = await run([]);
    runOut = r.out;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Ya están corriendo con el mismo plan: proxy-api pid \d+/);
    assert.match(r.out, /Los servicios siguen levantados/);
    assert.equal(p.report().services[0].proxy.pid, proxyPid, "el plan no pierde el PID del proxy");
    process.kill(proxyPid, 0); // sigue vivo
    assert.match(r.out, /UC-01 Cliente no puede cancelar un pedido ajeno: 4\/4 aserciones ok/);
    assert.match(r.out, /UC-02 Cliente cancela su propio pedido: 0\/1 aserciones ok/);
    assert.match(r.out, /UC-03 Login con contraseña equivocada: 1\/1 aserciones ok/);
    const rep = p.report();
    assert.equal(rep.run.number, 2);
    assert.deepEqual(rep.useCases.map((u: any) => u.id), ["UC-01", "UC-02", "UC-03"]);
    assert.equal(rep.useCases[1].handler.file, "cases/propios.case.ts");
    assert.equal(rep.useCases[0].description, "Un cliente solo cancela sus propios pedidos.");
    assert.equal(rep.useCases[1].description, undefined, "sin describe() no hay description");
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

  it("importa la evidencia, sincroniza y genera el HTML: el JSON guarda los valores reales y el HTML los oculta", async () => {
    const har = join(p.tc, "evidence", "api.har");
    const down = await run(["--down-services"]);
    assert.equal(down.code, 0, down.out);
    assert.ok(!existsSync(join(p.tc, "local.pids.json")));
    assert.match(down.out, /proxy-api: pid \d+ detenido \(SIGTERM\)/);
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

    // report.json conserva los valores reales en secrets, para validar y reproducir
    const secretValues = Object.values(final.secrets);
    assert.ok(secretValues.includes(PASSWORD) && secretValues.includes(TOKEN));
    assert.equal(final.run.secretsIncluded, true);
    assert.equal(final.secrets[login.request.body.redactions.find((x: any) => x.path === "$.password").secretRef], PASSWORD);
    assert.ok(runOut.length > 0);

    // El HTML los oculta hasta que se pulsa "Mostrar valores sensibles"
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await page.goto("file://" + html);
      await page.locator(`.tl-row[data-id="${login.id}"]`).click();
      const visible = await page.locator("body").innerText();
      assert.ok(!visible.includes(PASSWORD) && !visible.includes(TOKEN), "se ven valores sensibles sin pulsar el botón");
      await page.locator("[data-reveal]").click();
      await page.locator("#detail").getByText(PASSWORD).first().waitFor({ timeout: 5000 });
    } finally {
      await browser.close();
    }

    // Una copia para compartir no los trae en ninguna parte
    const shared = join(p.tc, "report.shared.html");
    const strip = await runAsync(join(SCRIPTS, "render-report.ts"), [p.reportFile, "-o", shared, "--strip-secrets"], { cwd: p.dir });
    assert.equal(strip.code, 0, strip.out);
    const sharedText = readFileSync(shared, "utf8");
    assert.ok(!sharedText.includes(PASSWORD) && !sharedText.includes(TOKEN));
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
      for (const uc of example.useCases.filter((u: any) => u.description)) assert.ok(text.includes(uc.description), `no se ve la descripción de ${uc.id}`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      cleanup();
    }
  });

  it("la cabecera tiene un selector de temas con Cobalto y Raycast", async () => {
    const { chromium } = await import("playwright");
    const { tempDir, ASSETS } = await import("./helpers.ts");
    const { dir, cleanup } = tempDir();
    const browser = await chromium.launch();
    try {
      const json = join(dir, "tema.json");
      writeFileSync(json, readFileSync(join(ASSETS, "report.example.json")));
      const r = await runAsync(join(SCRIPTS, "render-report.ts"), [json], { cwd: dir });
      assert.equal(r.code, 0, r.out);
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await page.goto("file://" + join(dir, "tema.html"));
      const select = page.locator("header #theme-select");
      assert.deepEqual(await select.locator("option").allTextContents(), ["Cobalto", "Raycast"]);
      assert.equal(await select.inputValue(), "cobalto");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "cobalto");
      // Raycast: siempre oscuro, lienzo #040506; la elección se recuerda al recargar
      await select.selectOption("raycast");
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(4, 5, 6)");
      await page.reload();
      assert.equal(await page.locator("#theme-select").inputValue(), "raycast");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "raycast");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      cleanup();
    }
  });

  it("Copiar en Estado copia la respuesta como mensaje HTTP, y Reproducir copia el request como fetch()", async () => {
    const { chromium } = await import("playwright");
    const { tempDir, ASSETS } = await import("./helpers.ts");
    const { dir, cleanup } = tempDir();
    const browser = await chromium.launch();
    try {
      const example = readJson(join(ASSETS, "report.example.json"));
      const json = join(dir, "example.json");
      writeJson(json, example);
      const r = await runAsync(join(SCRIPTS, "render-report.ts"), [json], { cwd: dir });
      assert.equal(r.code, 0, r.out);
      const page = await browser.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void ((window as any).__copied = t) } });
      });
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await page.goto("file://" + join(dir, "example.html"));
      const copy = async (id: number) => {
        await page.locator(`.tl-row[data-id="${id}"]`).click();
        await page.locator('#detail [data-tab="res"]').click();
        const btn = page.locator('#detail [data-copy="resHttp"]');
        if (!(await btn.count())) return null;
        await btn.click();
        return page.evaluate(() => (window as any).__copied as string);
      };

      const http = example.requests.find((x: any) => x.protocol === "http" && x.response.headers.length && x.response.body.encoding === "json");
      const msg = (await copy(http.id))!;
      const [head, body] = msg.split("\n\n");
      const lines = head.split("\n");
      assert.equal(lines[0], `HTTP/1.1 ${http.response.status.code} ${http.response.status.reason}`.trim());
      assert.deepEqual(lines.slice(1), http.response.headers.map((h: any) => `${h.name}: ${h.value}`));
      assert.deepEqual(JSON.parse(body), http.response.body.value);

      const gql = example.requests.find((x: any) => x.protocol === "graphql");
      assert.match((await copy(gql.id))!, new RegExp(`^HTTP/[\\d.]+ ${gql.response.status.httpCode} OK\n`));

      const grpc = example.requests.find((x: any) => x.protocol === "grpc");
      assert.equal(await copy(grpc.id), null, "un request gRPC no tiene la copia HTTP");

      // Reproducir → fetch: el código copiado corre y llama a fetch con la URL, el método, los headers y el body del request
      const copyFetch = async (id: number) => {
        await page.locator(`.tl-row[data-id="${id}"]`).click();
        await page.locator('#detail [data-tab="rep"]').click();
        const btn = page.locator('#detail [data-copy="fetch"]');
        if (!(await btn.count())) return null;
        await btn.click();
        return page.evaluate(() => (window as any).__copied as string);
      };
      const post = example.requests.find((x: any) => x.protocol === "http" && x.request.body.encoding === "json");
      const code = (await copyFetch(post.id))!;
      let call: any;
      await new Function("fetch", `return (async () => { ${code}; return res; })()`)(async (url: string, init: any) => ((call = { url, init }), "ok"));
      assert.equal(call.url, post.url);
      assert.equal(call.init.method, post.method);
      const sent = post.request.headers.filter((h: any) => !/^(host|content-length|connection|accept-encoding|transfer-encoding|keep-alive|upgrade|x-testcase-.*|:.*)$/i.test(h.name));
      assert.deepEqual(Object.entries(call.init.headers), sent.map((h: any) => [h.name, h.value]));
      assert.deepEqual(JSON.parse(call.init.body), post.request.body.value);
      assert.equal(await copyFetch(grpc.id), null, "un request gRPC no tiene la copia fetch");
    } finally {
      await browser.close();
      cleanup();
    }
  });

  it("muestra los procesos locales y los proxies sin contenedor", async () => {
    const { chromium } = await import("playwright");
    const { tempDir, ASSETS } = await import("./helpers.ts");
    const { dir, cleanup } = tempDir();
    const browser = await chromium.launch();
    try {
      const report = readJson(join(ASSETS, "report.example.json"));
      report.services.push({
        name: "web",
        mode: "process",
        command: "bun run dev",
        cwd: "./apps/web",
        port: 3000,
        endpoint: "http://localhost:3000",
        env: [{ name: "API_KEY", source: "manifest", value: "••••", sensitive: true, fromEnv: "WEB_API_KEY" }],
        health: { check: "GET /healthz", status: "healthy", durationMs: 12 },
        requestCount: 0,
        readyMs: 850,
        artifacts: [],
        process: { pid: 4242, startedAt: "2026-11-23T10:00:00.000Z", stoppedAt: "2026-11-23T10:01:00.000Z", exitCode: null, signal: "SIGTERM", log: "logs/web.log" },
        proxy: { engine: "local", listen: "http://127.0.0.1:18085", upstream: "http://localhost:3000", evidence: "evidence/web.har" },
      });
      assert.deepEqual(await validateReport(report), []);
      const json = join(dir, "proc.json");
      writeJson(json, report);
      const r = await runAsync(join(SCRIPTS, "render-report.ts"), [json], { cwd: dir });
      assert.equal(r.code, 0, r.out);
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
      await page.goto("file://" + join(dir, "proc.html"));
      const group = page.locator("#services-proc");
      await assert.doesNotReject(group.waitFor({ state: "visible", timeout: 5000 }));
      const text = await group.innerText();
      for (const t of ["Proceso local", "bun run dev", "./apps/web", "4242 · detenido con SIGTERM · salida en logs/web.log", "API_KEY ← $WEB_API_KEY", "proceso local · http://127.0.0.1:18085 → http://localhost:3000"])
        assert.ok(text.includes(t), `no se ve "${t}" en:\n${text}`);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      cleanup();
    }
  });
});
