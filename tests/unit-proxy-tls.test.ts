/**
 * Proxy de evidencia delante de un servicio HTTPS con certificado propio (autofirmado o de una CA local).
 *
 * Reproduce el 502 "certificado inválido": el proxy verificaba siempre el certificado del upstream y
 * run.ts --plan no tenía forma de decirle que confiara en él, así que todo request a un servicio
 * local con HTTPS terminaba en 502.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { caseSource, project, readJson, runScript, SCRIPTS, tempDir, validateReport } from "./helpers.ts";

const PROXY = join(SCRIPTS, "proxy.ts");
const LOCAL = join(SCRIPTS, "local.ts");
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const caseBody = `await defineCase(async () => { await title("Caso"); await given("a"); await when("b"); await then("c"); });`;
/** Certificado autofirmado para localhost y 127.0.0.1, como el de un servidor de desarrollo. */
function selfSigned(dir: string) {
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore" });
  return { key, cert };
}

/** Levanta proxy.ts y devuelve su puerto, una función para leer su salida y otra para detenerlo. */
async function startProxy(args: string[]) {
  const p = spawn(process.execPath, [PROXY, "--listen", "0", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout!.on("data", (d) => (out += d));
  p.stderr!.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !/localhost:(\d+)/.test(out); i++) await sleep(50);
  const port = out.match(/localhost:(\d+)/)?.[1];
  assert.ok(port, out);
  return { port: Number(port), out: () => out, stop: () => p.kill("SIGKILL") };
}

describe("proxy.ts con un upstream HTTPS de certificado propio", () => {
  let dir: string;
  let cleanup: () => void;
  let tls: { key: string; cert: string };
  let upstream: Server;
  let upPort: number;

  before(async () => {
    ({ dir, cleanup } = tempDir());
    tls = selfSigned(dir);
    upstream = createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.cert) }, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url, seguro: true }));
    });
    upPort = await new Promise<number>((ok) => upstream.listen(0, "127.0.0.1", () => ok((upstream.address() as AddressInfo).port)));
  });
  after(async () => {
    await new Promise((ok) => upstream.close(ok));
    cleanup();
  });

  it("sin opciones verifica el certificado: responde 502 y explica cómo confiar en él", async () => {
    const p = await startProxy(["--upstream", `https://127.0.0.1:${upPort}`, "--har", join(dir, "strict.har")]);
    try {
      const r = await fetch(`http://127.0.0.1:${p.port}/v1/ping`);
      assert.equal(r.status, 502);
      const body = await r.text();
      assert.match(body, /certificado/i);
      assert.match(body, /tls: \{ insecure: true \}|tls: \{ ca:/);
      assert.match(p.out(), /self-signed|certificate/i);
    } finally {
      p.stop();
    }
  });

  it("con --insecure reenvía y guarda la evidencia", async () => {
    const har = join(dir, "insecure.har");
    const p = await startProxy(["--upstream", `https://127.0.0.1:${upPort}`, "--har", har, "--insecure"]);
    try {
      const r = await fetch(`http://127.0.0.1:${p.port}/v1/ping`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { path: "/v1/ping", seguro: true });
      assert.equal(readJson(har).log.entries[0].response.status, 200);
    } finally {
      p.stop();
    }
  });

  it("con --ca confía solo en esa CA y sigue verificando el nombre del host", async () => {
    const p = await startProxy(["--upstream", `https://localhost:${upPort}`, "--har", join(dir, "ca.har"), "--ca", tls.cert]);
    try {
      const r = await fetch(`http://127.0.0.1:${p.port}/v1/ping`);
      assert.equal(r.status, 200);
    } finally {
      p.stop();
    }
    // Otra CA no sirve: el certificado del upstream sigue siendo inválido para ella.
    const other = join(dir, "otra");
    mkdirSync(other);
    const q = await startProxy(["--upstream", `https://localhost:${upPort}`, "--har", join(dir, "ca2.har"), "--ca", selfSigned(other).cert]);
    try {
      assert.equal((await fetch(`http://127.0.0.1:${q.port}/v1/ping`)).status, 502);
    } finally {
      q.stop();
    }
  });

  it("rechaza un --ca que no existe", () => {
    const r = runScript(PROXY, ["--upstream", `https://127.0.0.1:${upPort}`, "--listen", "0", "--har", join(dir, "x.har"), "--ca", join(dir, "no-existe.pem")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no pude leer la CA/);
  });
});

describe("run.ts --plan con servicios HTTPS de certificado propio", () => {
  it("un servicio conectado en localhost no verifica el certificado; uno remoto sí, salvo que se pida", async () => {
    const p = project({
      "UC-01.case.ts": caseSource(
        caseBody,
        `await defineService({ name: "dev", endpoint: "https://localhost:8443" });
await defineService({ name: "estricto", endpoint: "https://127.0.0.1:9443", tls: { insecure: false } });
await defineService({ name: "remoto", endpoint: "https://api.example.com" });
await defineService({ name: "staging", endpoint: "https://staging.interno", tls: { insecure: true } });
await defineService({ name: "corp", endpoint: "https://corp.interno", tls: { ca: "./certs/ca.pem" } });`,
      ),
    });
    try {
      const r = p.cases(["--plan", "--proxy", "local"]);
      assert.equal(r.code, 0, r.out);
      const local = readJson(join(p.tc, "local.json"));
      const byName = Object.fromEntries(local.proxies.map((x: any) => [x.service, x]));
      assert.equal(byName.dev.insecure, true);
      assert.equal(byName.estricto.insecure, undefined);
      assert.equal(byName.remoto.insecure, undefined);
      assert.equal(byName.staging.insecure, true);
      assert.equal(byName.corp.ca, "./certs/ca.pem");
      const rep = Object.fromEntries(p.report().services.map((s: any) => [s.name, s.proxy]));
      assert.equal(rep.dev.insecure, true);
      assert.equal(rep.remoto.insecure, undefined);
      assert.equal(rep.corp.ca, "./certs/ca.pem");
      // El reporte aún no tiene health (lo registra el agente después), pero proxy.insecure y proxy.ca cumplen el schema.
      assert.deepEqual((await validateReport(p.report())).filter((e) => e.includes("/proxy")), []);

      // Con mitmdump en contenedor: ssl_insecure, o la CA montada en el contenedor.
      assert.equal(p.cases(["--plan", "--proxy", "podman"]).code, 0);
      const compose = readFileSync(join(p.tc, "compose.yaml"), "utf8");
      const block = (name: string) => compose.split(`\n  proxy-${name}:`)[1].split(/\n  \S/)[0];
      assert.match(block("dev"), /"ssl_insecure=true"/);
      assert.doesNotMatch(block("remoto"), /ssl_insecure/);
      assert.match(block("corp"), /"ssl_verify_upstream_trusted_ca=\/certs\/ca\.pem"/);
      assert.match(block("corp"), /\.\.\/certs\/ca\.pem:\/certs\/ca\.pem:ro,Z/);
    } finally {
      p.cleanup();
    }
  });

  it("rechaza tls en un servicio que no es conectado", () => {
    const p = project({ "UC-01.case.ts": caseSource(caseBody, `await defineService({ name: "web", command: "x", port: 3000, tls: { insecure: true } } as any);`) });
    try {
      const r = p.cases(["--plan"]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /tls solo aplica a servicios conectados/);
    } finally {
      p.cleanup();
    }
  });
});

describe("local.ts levanta el proxy de un servicio HTTPS local con certificado propio", () => {
  let p: ReturnType<typeof project>;
  let upstream: Server;
  let upPort: number;

  before(async () => {
    const { dir, cleanup } = tempDir();
    const tls = selfSigned(dir);
    upstream = createServer({ key: readFileSync(tls.key), cert: readFileSync(tls.cert) }, (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: req.url }));
    });
    upPort = await new Promise<number>((ok) => upstream.listen(0, "127.0.0.1", () => ok((upstream.address() as AddressInfo).port)));
    cleanup();
    p = project({ "UC-01.case.ts": caseSource(caseBody, `await defineService({ name: "dev", endpoint: "https://localhost:${upPort}" });`) });
  });
  after(async () => {
    runScript(LOCAL, ["down", "--report", p.reportFile]);
    await new Promise((ok) => upstream.close(ok));
    p.cleanup();
  });

  it("el request por el proxy llega al servicio en vez de responder 502", async () => {
    assert.equal(p.cases(["--plan", "--proxy", "local"]).code, 0);
    const up = runScript(LOCAL, ["up", "--report", p.reportFile]);
    assert.equal(up.code, 0, up.out);
    const dev = p.report().services.find((s: any) => s.name === "dev");
    const r = await fetch(`${dev.proxy.listen}/hola`);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { path: "/hola" });
  });
});
