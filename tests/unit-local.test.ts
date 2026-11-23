/**
 * Servicios como procesos locales (defineService con command) y proxies de evidencia sin contenedor:
 * scripts/proxy.ts, scripts/local.ts y run.ts --plan con --proxy local.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { baseReport, caseSource, project, readJson, runScript, SCRIPTS, tempDir, writeJson } from "./helpers.ts";

const PROXY = join(SCRIPTS, "proxy.ts");
const LOCAL = join(SCRIPTS, "local.ts");
const IMPORT = join(SCRIPTS, "import-har.ts");

const freePort = () =>
  new Promise<number>((ok) => {
    const s = netServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => ok(port));
    });
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const caseBody = `defineCase(() => { title("Caso"); given("a"); when("b"); then("c"); });`;

describe("proxy.ts", () => {
  let upstream: Server;
  let upPort: number;
  let proxyPort: number;
  let child: ReturnType<typeof spawn>;
  let dir: string;
  let cleanup: () => void;
  let har: string;
  let out = "";
  const seen: Array<{ url: string; host: string; body: string }> = [];

  before(async () => {
    ({ dir, cleanup } = tempDir());
    har = join(dir, "evidence", "api.har");
    upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url!, host: req.headers.host!, body });
        if (req.url!.endsWith("/gzip")) {
          res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
          return res.end(gzipSync(JSON.stringify({ comprimido: true })));
        }
        if (req.url!.endsWith("/png")) {
          res.writeHead(200, { "content-type": "image/png" });
          return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
        }
        res.writeHead(req.method === "POST" ? 201 : 200, "Hecho", { "content-type": "application/json", "x-upstream": "sí" });
        res.end(JSON.stringify({ path: req.url, method: req.method }));
      });
    });
    upPort = await new Promise<number>((ok) => upstream.listen(0, "127.0.0.1", () => ok((upstream.address() as AddressInfo).port)));
    proxyPort = await freePort();
    child = spawn(process.execPath, [PROXY, "--upstream", `http://127.0.0.1:${upPort}/base/`, "--listen", String(proxyPort), "--har", har], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    for (let i = 0; i < 100 && !out.includes("escuchando"); i++) await sleep(50);
    assert.match(out, /proxy escuchando en http:\/\/localhost:\d+/);
  });
  after(async () => {
    if (child.exitCode == null) child.kill("SIGKILL");
    await new Promise((ok) => upstream.close(ok));
    cleanup();
  });

  const base = () => `http://127.0.0.1:${proxyPort}`;

  it("reenvía al upstream con su ruta base y su Host, y devuelve la respuesta tal cual", async () => {
    const r = await fetch(`${base()}/v1/orders?x=1`, { headers: { "x-testcase-uc": "UC-01" } });
    assert.equal(r.status, 200);
    assert.equal(r.statusText, "Hecho");
    assert.equal(r.headers.get("x-upstream"), "sí");
    assert.deepEqual(await r.json(), { path: "/base/v1/orders?x=1", method: "GET" });
    assert.equal(seen.at(-1)!.host, `127.0.0.1:${upPort}`);
    const p = await fetch(`${base()}/v1/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
    assert.equal(p.status, 201);
    assert.equal(seen.at(-1)!.body, '{"a":1}');
  });

  it("descomprime para la evidencia y guarda binarios en base64", async () => {
    const g = await fetch(`${base()}/gzip`);
    assert.deepEqual(await g.json(), { comprimido: true });
    const b = await fetch(`${base()}/png`);
    assert.equal(Buffer.from(await b.arrayBuffer()).length, 8);
    const entries = readJson(har).log.entries;
    assert.equal(entries.length, 4, "el HAR se escribe después de cada request");
    assert.equal(entries[2].response.content.text, '{"comprimido":true}');
    assert.equal(entries[3].response.content.encoding, "base64");
    assert.deepEqual([...Buffer.from(entries[3].response.content.text, "base64")], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  });

  it("responde 502 si el upstream no contesta", async () => {
    const port = await freePort();
    const { dir: d2, cleanup: c2 } = tempDir();
    const p = spawn(process.execPath, [PROXY, "--upstream", `http://127.0.0.1:${port}`, "--listen", "0", "--har", join(d2, "x.har")], { stdio: ["ignore", "pipe", "pipe"] });
    let o = "";
    p.stdout!.on("data", (d) => (o += d));
    try {
      for (let i = 0; i < 100 && !/localhost:(\d+)/.test(o); i++) await sleep(50);
      const listen = o.match(/localhost:(\d+)/)![1];
      const r = await fetch(`http://127.0.0.1:${listen}/`);
      assert.equal(r.status, 502);
      assert.match(await r.text(), /no pude conectar/);
    } finally {
      p.kill("SIGKILL");
      c2();
    }
  });

  it("con SIGTERM escribe el HAR y termina; import-har lo entiende", async () => {
    const exited = new Promise<number | null>((ok) => child.on("exit", (code) => ok(code)));
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    const report = baseReport({ startedAt: new Date(Date.now() - 60_000).toISOString() });
    report.services[0].endpoint = `http://127.0.0.1:${upPort}/base`;
    const rf = join(dir, "report.json");
    writeJson(rf, report);
    const r = runScript(IMPORT, [rf, har, "--service", "api"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Importados 1 requests/, "solo el request con x-testcase-uc");
    const req = readJson(rf).requests[0];
    assert.equal(req.url, `http://127.0.0.1:${upPort}/v1/orders?x=1`);
    assert.equal(req.response.status.code, 200);
  });

  it("valida sus argumentos", () => {
    assert.equal(runScript(PROXY, []).code, 1);
    const r = runScript(PROXY, ["--upstream", "ftp://x", "--listen", "0", "--har", "x.har"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /debe ser http o https/);
  });
});

describe("local.ts con un proceso local", () => {
  let p: ReturnType<typeof project>;
  let webPort: number;
  let rep: any;

  before(async () => {
    webPort = await freePort();
    p = project({
      "UC-01.case.ts": caseSource(
        caseBody,
        `defineService({ name: "web", command: "node server.mjs", cwd: "./app", port: ${webPort}, env: { SALUDO: "hola $USER", CLAVE: fromEnv("TC_CLAVE") }, health: "GET /healthz" });
defineService({ name: "worker", command: "node -e \\"setInterval(() => {}, 1000); console.log('worker listo')\\"", dependsOn: ["web"] });`,
      ),
    });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(p.dir, "app"));
    writeFileSync(
      join(p.dir, "app", "server.mjs"),
      `import { createServer } from "node:http";
console.log("arrancando en", process.cwd());
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ path: req.url, saludo: process.env.SALUDO, clave: process.env.CLAVE }));
}).listen(${webPort}, "127.0.0.1");
`,
    );
  });
  after(() => {
    runScript(LOCAL, ["down", "--report", p.reportFile]);
    p.cleanup();
  });

  it("--plan escribe local.json con el proceso y su proxy local, sin compose.yaml", () => {
    const r = p.cases(["--plan"]);
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(p.tc, "compose.yaml")));
    const local = readJson(join(p.tc, "local.json"));
    assert.equal(local.projectRoot, "..");
    assert.deepEqual(local.services.map((s: any) => s.name), ["web", "worker"]);
    assert.deepEqual(local.services[0], {
      name: "web",
      command: "node server.mjs",
      cwd: "./app",
      port: webPort,
      env: { SALUDO: "hola $USER", CLAVE: { fromEnv: "TC_CLAVE" } },
      health: "GET /healthz",
      log: "logs/web.log",
    });
    assert.equal(local.proxies.length, 1, "worker no tiene puerto: no habla HTTP");
    assert.equal(local.proxies[0].upstream, `http://localhost:${webPort}`);
    rep = p.report();
    const web = rep.services.find((s: any) => s.name === "web");
    assert.equal(web.mode, "process");
    assert.equal(web.endpoint, `http://localhost:${webPort}`);
    assert.deepEqual(web.env[1], { name: "CLAVE", source: "manifest", value: "••••", sensitive: true, fromEnv: "TC_CLAVE" });
    assert.equal(web.proxy.engine, "local");
    assert.equal(web.proxy.listen, `http://127.0.0.1:${local.proxies[0].port}`);
    assert.equal(rep.services.find((s: any) => s.name === "worker").proxy, undefined);
    assert.match(r.out, /local\.ts up --report/);
    assert.match(r.out, /local\.ts down --report/);
    assert.match(r.out, /Variables que deben existir en el entorno: TC_CLAVE/);
    assert.doesNotMatch(r.out, /podman compose/);
  });

  it("up exige las variables de fromEnv antes de levantar nada", () => {
    const r = runScript(LOCAL, ["up", "--report", p.reportFile], { env: { TC_CLAVE: undefined } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /faltan variables de entorno: TC_CLAVE/);
    assert.ok(!existsSync(join(p.tc, "local.pids.json")));
  });

  it("up levanta los procesos en su cwd, guarda los PID y corre el healthcheck", async () => {
    const r = runScript(LOCAL, ["up", "--report", p.reportFile], { env: { TC_CLAVE: "c1@ve" } });
    assert.equal(r.code, 0, r.out);
    rep = p.report();
    const web = rep.services.find((s: any) => s.name === "web");
    const worker = rep.services.find((s: any) => s.name === "worker");
    assert.ok(alive(web.process.pid) && alive(worker.process.pid) && alive(web.proxy.pid));
    assert.equal(web.process.log, "logs/web.log");
    assert.equal(web.health.status, "healthy");
    assert.equal(web.health.check, "GET /healthz");
    assert.ok(web.readyMs >= 0);
    assert.match(readFileSync(join(p.tc, "logs", "web.log"), "utf8"), /arrancando en .*app/);
    const pids = readJson(join(p.tc, "local.pids.json")).items;
    assert.deepEqual(pids.map((i: any) => i.name), ["web", "worker", "proxy-web"]);

    const res = await fetch(`${web.proxy.listen}/hola`);
    assert.deepEqual(await res.json(), { path: "/hola", saludo: "hola $USER", clave: "c1@ve" });

    const st = runScript(LOCAL, ["status", "--report", p.reportFile]);
    assert.equal(st.code, 0, st.out);
    assert.match(st.out, new RegExp(`web: pid ${web.process.pid} corriendo · puerto ${webPort}`));
  });

  it("up no levanta dos veces", () => {
    const r = runScript(LOCAL, ["up", "--report", p.reportFile], { env: { TC_CLAVE: "x" } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ya hay procesos corriendo/);
  });

  it("status avisa si un proceso se cayó", async () => {
    const worker = rep.services.find((s: any) => s.name === "worker");
    process.kill(-worker.process.pid, "SIGKILL");
    for (let i = 0; i < 40 && alive(worker.process.pid); i++) await sleep(50);
    const st = runScript(LOCAL, ["status", "--report", p.reportFile]);
    assert.equal(st.code, 1);
    assert.match(st.out, /worker: pid \d+ terminó/);
  });

  it("down detiene primero el proxy (que escribe el HAR) y luego los procesos", async () => {
    const before = p.report();
    const web = before.services.find((s: any) => s.name === "web");
    const r = runScript(LOCAL, ["down", "--report", p.reportFile]);
    assert.equal(r.code, 0, r.out);
    const lines = r.out.trim().split("\n");
    assert.match(lines[0], /^proxy-web: pid \d+ detenido \(SIGTERM\)/);
    assert.match(lines[1], /^worker: pid \d+ ya había terminado/);
    assert.match(lines[2], /^web: pid \d+ detenido/);
    assert.ok(!alive(web.process.pid) && !alive(web.proxy.pid));
    // El servidor (hijo de sh -c) también terminó: el puerto quedó libre
    await assert.rejects(fetch(`http://127.0.0.1:${webPort}/`));
    const har = readJson(join(p.tc, "evidence", "web.har"));
    assert.equal(har.log.entries.length, 1);
    assert.equal(har.log.entries[0].request.url.endsWith("/hola"), true);
    const after = p.report().services.find((s: any) => s.name === "web");
    assert.equal(after.process.signal, "SIGTERM");
    assert.ok(after.process.stoppedAt);
    assert.equal(after.proxy.pid, undefined);
    assert.ok(!existsSync(join(p.tc, "local.pids.json")));
    assert.match(runScript(LOCAL, ["status", "--report", p.reportFile]).out, /No hay procesos locales levantados/);
  });
});

describe("local.ts: fallos al levantar", () => {
  const withProcess = async (def: string, run: (p: ReturnType<typeof project>) => void) => {
    const p = project({ "UC-01.case.ts": caseSource(caseBody, def) });
    try {
      const r = p.cases(["--plan"]);
      assert.equal(r.code, 0, r.out);
      run(p);
    } finally {
      runScript(LOCAL, ["down", "--report", p.reportFile]);
      p.cleanup();
    }
  };

  it("un proceso que termina antes de estar listo muestra su salida y no deja nada corriendo", async () => {
    const port = await freePort();
    await withProcess(`defineService({ name: "roto", command: "echo 'falta la config' >&2; exit 3", port: ${port} });`, (p) => {
      const r = runScript(LOCAL, ["up", "--report", p.reportFile]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /roto terminó antes de estar listo/);
      assert.match(r.stderr, /falta la config/);
      assert.ok(!existsSync(join(p.tc, "local.pids.json")));
    });
  });

  it("un puerto que no abre a tiempo detiene el proceso", async () => {
    const port = await freePort();
    await withProcess(`defineService({ name: "lento", command: "sleep 30", port: ${port} });`, (p) => {
      const r = runScript(LOCAL, ["up", "--report", p.reportFile, "--timeout", "1"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`lento no abrió el puerto ${port} en 1 s`));
    });
  });

  it("sin local.json pide correr --plan", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeJson(join(dir, "report.json"), baseReport());
      const r = runScript(LOCAL, ["up", "--report", join(dir, "report.json")]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Corre antes cases.ts --plan/);
      assert.equal(runScript(LOCAL, []).code, 1);
    } finally {
      cleanup();
    }
  });
});

describe("run.ts --plan --proxy local", () => {
  it("deja en compose solo los contenedores y corre todos los proxies como procesos", () => {
    const p = project({
      "UC-01.case.ts": caseSource(
        caseBody,
        `defineService({ name: "api", endpoint: "https://api.example.com/v2" });
defineService({ name: "db", image: "postgres:16", ports: [{ container: 5432 }] });
defineService({ name: "svc", image: "svc:1", ports: [{ container: 8080 }], http: true, dependsOn: ["db"] });
defineService({ name: "web", command: "bun run dev", port: 3999, dependsOn: ["svc"] });`,
      ),
    });
    try {
      const r = p.cases(["--plan", "--proxy", "local"]);
      assert.equal(r.code, 0, r.out);
      const compose = readFileSync(join(p.tc, "compose.yaml"), "utf8");
      assert.match(compose, /\n  db:/);
      assert.match(compose, /\n  svc:/);
      assert.doesNotMatch(compose, /proxy-|mitmdump|\n  web:/);
      const local = readJson(join(p.tc, "local.json"));
      assert.deepEqual(local.services.map((s: any) => s.name), ["web"]);
      const svcPort = p.report().services.find((s: any) => s.name === "svc").ports[0].host;
      assert.deepEqual(
        Object.fromEntries(local.proxies.map((x: any) => [x.service, x.upstream])),
        { api: "https://api.example.com", svc: `http://localhost:${svcPort}`, web: "http://localhost:3999" },
      );
      assert.ok(r.out.indexOf("podman compose") < r.out.indexOf("local.ts up"), "primero los contenedores");
      assert.ok(r.out.indexOf("local.ts down") < r.out.lastIndexOf("compose -f"), "se detienen primero los proxies locales");

      // Sin --proxy se conserva el motor que ya tenía cada servicio
      assert.equal(p.cases(["--plan"]).code, 0);
      assert.equal(p.report().services.find((s: any) => s.name === "api").proxy.engine, "local");
      // Y con --proxy podman vuelven a ser contenedores, salvo el del proceso local
      assert.equal(p.cases(["--plan", "--proxy", "podman"]).code, 0);
      const engines = Object.fromEntries(p.report().services.filter((s: any) => s.proxy).map((s: any) => [s.name, s.proxy.engine]));
      assert.deepEqual(engines, { api: "podman", svc: "podman", web: "local" });
      assert.match(readFileSync(join(p.tc, "compose.yaml"), "utf8"), /proxy-api/);
    } finally {
      p.cleanup();
    }
  });

  it("rechaza un contenedor que depende de un proceso local y un --proxy desconocido", () => {
    const p = project({
      "UC-01.case.ts": caseSource(caseBody, `defineService({ name: "web", command: "x", port: 3000 });\ndefineService({ name: "svc", image: "svc:1", dependsOn: ["web"] });`),
    });
    try {
      const r = p.cases(["--plan"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /El contenedor "svc" depende del proceso local "web"/);
      assert.match(p.cases(["--plan", "--proxy", "nginx"]).stderr, /--proxy acepta local o podman/);
    } finally {
      p.cleanup();
    }
  });
});
