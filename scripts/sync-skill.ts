/**
 * sync-skill.ts
 *
 * El código vive en packages/testcase/src/. Mientras la skill no instale el paquete, lleva una copia exacta de ese
 * código para correr sin dependencias (assets/workspace/ y scripts/). @jondotsoy/testcase-view-report también lleva una
 * copia de la plantilla del reporte. Este script escribe esas copias.
 *
 *   node scripts/sync-skill.ts           # copia src → testcase/
 *   node scripts/sync-skill.ts --check   # solo revisa; sale con 1 si alguna copia no coincide
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "packages", "testcase", "src");
const SKILL = join(ROOT, "testcase");

/** Archivo del paquete → copia en la skill. */
export const SKILL_COPIES: Array<[string, string]> = [
  ["testcase.ts", "assets/workspace/testcase.ts"],
  ["run.ts", "assets/workspace/run.ts"],
  ["assets/report.template.html", "assets/report.template.html"],
  ...["local", "proxy", "import-har", "sync-report", "render-report"].map((f): [string, string] => [`scripts/${f}.ts`, `scripts/${f}.ts`]),
].map(([from, to]) => [join(SRC, from), join(SKILL, to)]);

// @jondotsoy/testcase-view-report lleva su propia copia de la plantilla del reporte
SKILL_COPIES.push([join(SRC, "assets", "report.template.html"), join(ROOT, "packages", "testcase-view-report", "src", "assets", "report.template.html")]);

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const stale = SKILL_COPIES.filter(([from, to]) => !existsSync(to) || !readFileSync(from).equals(readFileSync(to)));
  if (check) {
    for (const [from, to] of stale) console.error(`${relative(ROOT, to)} no coincide con ${relative(ROOT, from)}. Corre: npm run sync:skill`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const [from, to] of stale) {
    copyFileSync(from, to);
    console.log(`${relative(ROOT, from)} → ${relative(ROOT, to)}`);
  }
  if (!stale.length) console.log("La skill ya está al día.");
}
