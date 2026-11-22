#!/usr/bin/env node
/**
 * sync-report.ts
 *
 * Recalcula los campos derivados de un reporte testcase/testmania (schema 1.0) después de que el agente
 * edita el JSON a mano. Así el agente solo mantiene los datos de origen: casos de uso, requests,
 * servicios y aserciones.
 *
 * Qué recalcula:
 *   - requests[].passed               a partir de sus aserciones
 *   - useCases[].requestIds           requests que apuntan al caso, en orden de inicio
 *   - useCases[].invocations          URLs y métodos invocados tal cual, agrupando solo los idénticos
 *   - useCases[].startOffsetMs / durationMs
 *   - useCases[].status               pending si no tiene requests, failed si alguno falló, passed en otro caso
 *   - useCases[].failure              explicación determinista si falta o si cambió el fallo
 *   - services[].requestCount
 *   - timeline                        regenera los eventos "request" y ordena todo por inicio
 *   - summary                         conteos, protocolos, aserciones y fases
 *   - run.status / exitCode / durationMs / finishedAt
 *
 * Uso:
 *   node sync-report.ts <reporte.json> [--check]
 *
 *   --check   No escribe. Termina con código 1 si el archivo no está sincronizado.
 *
 * Corre con Node 22.6 o superior, o con bun.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Json = any;

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const file = args.find((a) => !a.startsWith("-"));
if (!file) {
  console.log("Uso: node sync-report.ts <reporte.json> [--check]");
  process.exit(1);
}

const path = resolve(file);
const original = readFileSync(path, "utf8");
const report: Json = JSON.parse(original);

const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function explain(uc: Json, failing: Json[]): string {
  const parts: string[] = [];
  for (const r of failing) {
    for (const a of r.assertions.filter((a: Json) => !a.passed)) {
      const target = `${r.method} ${r.target}`;
      if (a.expected !== undefined && a.actual !== undefined) {
        parts.push(`En el request #${r.id} (${target}) se esperaba ${fmt(a.expected)} y se recibió ${fmt(a.actual)} (${a.expression}).`);
      } else {
        parts.push(`En el request #${r.id} (${target}) falló la aserción ${a.expression}.`);
      }
    }
  }
  return parts.join(" ") || `El caso ${uc.id} falló.`;
}

// 1. Requests
const requests: Json[] = report.requests ?? [];
requests.sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.id - b.id);
for (const r of requests) {
  r.assertions = r.assertions ?? [];
  r.assertions.forEach((a: Json, i: number) => {
    if (!a.id) a.id = `r${r.id}.a${i + 1}`;
  });
  r.passed = r.assertions.every((a: Json) => a.passed);
}

// 2. Casos de uso
for (const uc of report.useCases ?? []) {
  const rs = requests.filter((r) => r.useCaseId === uc.id);
  uc.requestIds = rs.map((r) => r.id);
  const inv: Json[] = [];
  for (const r of rs) {
    const same = inv.find((i) => i.protocol === r.protocol && i.method === r.method && i.target === r.target);
    if (same) same.count++;
    else inv.push({ protocol: r.protocol, method: r.method, target: r.target, count: 1 });
  }
  uc.invocations = inv;

  if (rs.length) {
    const start = Math.min(...rs.map((r) => r.startOffsetMs));
    uc.startOffsetMs = start;
    uc.durationMs = Math.max(...rs.map((r) => r.startOffsetMs + r.durationMs)) - start;
  } else {
    delete uc.startOffsetMs;
    delete uc.durationMs;
  }

  const failing = rs.filter((r) => !r.passed);
  if (!rs.length) {
    uc.status = "pending";
    uc.pending = uc.pending ?? { reason: "handler-not-implemented", message: "Todavía no se ejecutó ningún request para este caso." };
    delete uc.failure;
  } else if (failing.length) {
    uc.status = "failed";
    const ids = failing.map((r) => r.id);
    const assertionIds = failing.flatMap((r) => r.assertions.filter((a: Json) => !a.passed).map((a: Json) => a.id));
    const same = uc.failure && JSON.stringify(uc.failure.assertionIds) === JSON.stringify(assertionIds);
    uc.failure = { explanation: same ? uc.failure.explanation : explain(uc, failing), requestIds: ids, assertionIds };
    delete uc.pending;
  } else {
    uc.status = "passed";
    delete uc.failure;
    delete uc.pending;
  }
}

// 3. Servicios
for (const s of report.services ?? []) {
  s.requestCount = requests.filter((r) => (r.services ?? []).includes(s.name)).length;
}

// 4. Línea de tiempo
const infra = (report.timeline ?? []).filter((t: Json) => t.kind !== "request");
const reqEvents = requests.map((r) => ({
  kind: "request",
  label: `${r.method} ${r.target}`,
  ref: r.id,
  useCaseId: r.useCaseId,
  startOffsetMs: r.startOffsetMs,
  durationMs: r.durationMs,
}));
report.timeline = [...infra, ...reqEvents].sort((a: Json, b: Json) => a.startOffsetMs - b.startOffsetMs);

// 5. Resumen
const ucs: Json[] = report.useCases ?? [];
const allAsserts = requests.flatMap((r) => r.assertions);
const byProtocol: Record<string, number> = {};
for (const r of requests) byProtocol[r.protocol] = (byProtocol[r.protocol] ?? 0) + 1;
const span = (kinds: string[]) => {
  const ev = report.timeline.filter((t: Json) => kinds.includes(t.kind));
  if (!ev.length) return 0;
  return Math.max(...ev.map((t: Json) => t.startOffsetMs + t.durationMs)) - Math.min(...ev.map((t: Json) => t.startOffsetMs));
};
const end = Math.max(0, ...report.timeline.map((t: Json) => t.startOffsetMs + (t.kind === "request" && requests.find((r) => r.id === t.ref)?.open ? 0 : t.durationMs)));
report.summary = {
  useCases: {
    total: ucs.length,
    passed: ucs.filter((u) => u.status === "passed").length,
    failed: ucs.filter((u) => u.status === "failed").length,
    pending: ucs.filter((u) => u.status === "pending").length,
  },
  requests: { total: requests.length, byProtocol },
  assertions: { total: allAsserts.length, passed: allAsserts.filter((a) => a.passed).length, failed: allAsserts.filter((a) => !a.passed).length },
  phases: {
    provisioningMs: span(["service.up", "artifact.apply", "service.check"]),
    buildMs: span(["build"]),
    testsMs: span(["request"]),
    teardownMs: span(["teardown"]),
  },
};

// 6. Corrida
const run = report.run;
if (run.status !== "error") {
  run.status = report.summary.useCases.failed ? "failed" : "passed";
  run.exitCode = run.status === "passed" ? 0 : 1;
}
run.durationMs = Math.max(run.durationMs ?? 0, end);
if (run.startedAt) run.finishedAt = new Date(Date.parse(run.startedAt) + run.durationMs).toISOString();
run.secretsIncluded = !!report.secrets && Object.keys(report.secrets).length > 0;

const next = JSON.stringify(report, null, 2) + "\n";
if (checkOnly) {
  if (next !== original) {
    console.error(`${file} no está sincronizado. Corre: node sync-report.ts ${file}`);
    process.exit(1);
  }
  console.log(`${file} está sincronizado.`);
} else {
  writeFileSync(path, next);
  const s = report.summary;
  console.log(
    `Sincronizado ${file}: ${s.useCases.total} casos (${s.useCases.passed} ok, ${s.useCases.failed} fallidos, ${s.useCases.pending} pendientes) · ` +
      `${s.requests.total} requests · ${s.assertions.failed}/${s.assertions.total} aserciones fallidas`,
  );
}
