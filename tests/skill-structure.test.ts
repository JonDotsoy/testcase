/**
 * Estructura de la skill: frontmatter, archivos referenciados, versiones fijadas y ejemplos.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ASSETS, readJson, ROOT, SKILL, SKILL_SCRIPTS as SCRIPTS, WORKSPACE } from "./helpers.ts";
import { SKILL_COPIES } from "../scripts/sync-skill.ts";

const skillMd = readFileSync(join(SKILL, "SKILL.md"), "utf8");

describe("SKILL.md", () => {
  it("tiene frontmatter con name y description", () => {
    const m = skillMd.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, "falta el frontmatter");
    const fm = Object.fromEntries(m![1].split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    assert.equal(fm.name, "testcase");
    assert.ok(fm.description.length > 50 && fm.description.length <= 1024, "description entre 50 y 1024 caracteres");
    assert.ok(!/[<>]/.test(fm.description), "description sin < ni >");
  });

  it("todos los archivos que menciona existen", () => {
    const refs = new Set([...skillMd.matchAll(/(?:scripts|assets|references)\/[A-Za-z0-9_.\/-]+/g)].map((m) => m[0].replace(/[.,)]+$/, "")));
    assert.ok(refs.size >= 8, [...refs].join(", "));
    for (const ref of refs) assert.ok(existsSync(join(SKILL, ref)), `SKILL.md menciona ${ref}, que no existe`);
  });

  it("documenta cada script y cada utilidad que exporta testcase.ts para los casos", () => {
    for (const f of readdirSync(SCRIPTS)) assert.ok(skillMd.includes(`scripts/${f}`), `SKILL.md no menciona scripts/${f}`);
    for (const name of ["defineCase", "title", "describe", "id", "given", "when", "then", "defineService", "fromEnv", "fromEnvFile", "graphql", "sensitive", "notation", "check", "ensure", "page", "vars"])
      assert.match(skillMd, new RegExp(`\\b${name}\\b`), `SKILL.md no menciona ${name}`);
  });

  it("README.md menciona cómo instalar la skill y correr las pruebas", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.match(readme, /skills add \.\/testcase/);
    assert.match(readme, /npm test|bun run test|node --test/);
  });
});

describe("scripts", () => {
  for (const f of readdirSync(SCRIPTS)) {
    it(`${f} documenta su uso y no depende de paquetes externos`, () => {
      const src = readFileSync(join(SCRIPTS, f), "utf8");
      assert.match(src, new RegExp(`^(#!.*\\n)?\\/\\*\\*\\n \\* ${f.replace(".", "\\.")}\\n`), "empieza con un comentario con su nombre");
      assert.match(src, /Uso/);
      const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
      for (const i of imports) assert.ok(i.startsWith("node:"), `${f} importa ${i}: los scripts solo usan módulos de Node`);
    });
  }
});

describe("copias del paquete", () => {
  it("la skill lleva una copia exacta del código de packages/testcase/src (npm run sync:skill)", () => {
    assert.ok(SKILL_COPIES.length >= 8);
    for (const [from, to] of SKILL_COPIES) {
      assert.ok(existsSync(to), `falta ${to}`);
      assert.ok(readFileSync(from).equals(readFileSync(to)), `${to} no coincide con ${from}: corre npm run sync:skill`);
    }
  });
});

describe("assets", () => {
  it("el espacio de trabajo fija versiones exactas, iguales a las que prueba este repositorio", () => {
    const ws = readJson(join(WORKSPACE, "package.json"));
    const root = readJson(join(ROOT, "package.json"));
    for (const [name, v] of Object.entries<string>({ ...ws.dependencies, ...ws.devDependencies })) {
      assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v} no es una versión exacta`);
      assert.equal(root.devDependencies[name], v, `${name}: el workspace usa ${v} y las pruebas ${root.devDependencies[name]}`);
    }
  });

  it("el espacio de trabajo no trae casos de la persona ni node_modules", () => {
    assert.ok(!existsSync(join(WORKSPACE, "node_modules")));
    const cases = join(WORKSPACE, "cases");
    if (existsSync(cases)) assert.deepEqual(readdirSync(cases).filter((f) => f.endsWith(".ts")), []);
  });

  it("los reportes de ejemplo son JSON del schema 1.0 y la plantilla tiene sus marcadores", () => {
    for (const f of ["report.empty.json", "report.example.json"]) assert.equal(readJson(join(ASSETS, f)).reportVersion, "1.0");
    const tpl = readFileSync(join(ASSETS, "report.template.html"), "utf8");
    assert.ok(tpl.includes("/*REPORT_JSON*/"));
    assert.ok(tpl.includes("{{TITLE}}"));
  });

  it("los ejemplos importan la librería del espacio de trabajo", () => {
    const dir = join(WORKSPACE, "examples");
    const files = readdirSync(dir).filter((f) => f.endsWith(".case.ts"));
    assert.ok(files.length > 0);
    for (const f of files) assert.match(readFileSync(join(dir, f), "utf8"), /from "\.\.\/testcase\.ts"/);
  });

  it("la skill no trae archivos generados", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const bad = walk(SKILL).filter((f) => /(node_modules|\.har$|run-sensitive\.json|run-assertions\.json|compose\.yaml$)/.test(f));
    assert.deepEqual(bad, []);
  });
});
