/**
 * build.ts
 *
 * Escribe en dist/ el paquete listo para publicar: el JavaScript compilado con tsc, sus .d.ts y mapas de fuente,
 * los assets (si hay), README, LICENSE y un package.json propio con exports apuntando al JS.
 * Se valida empaquetando esa carpeta igual que se publicaría: `npm pack ./dist`.
 *
 *   node scripts/build.ts
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "..", "..");
const DIST = join(PKG, "dist");

rmSync(DIST, { recursive: true, force: true });

const tsc = createRequire(join(ROOT, "package.json")).resolve("typescript/bin/tsc");
const r = spawnSync(process.execPath, [tsc, "-p", join(PKG, "tsconfig.json")], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

if (existsSync(join(PKG, "src", "assets"))) cpSync(join(PKG, "src", "assets"), join(DIST, "assets"), { recursive: true });
cpSync(existsSync(join(PKG, "README.md")) ? join(PKG, "README.md") : join(ROOT, "README.md"), join(DIST, "README.md"));
cpSync(join(ROOT, "LICENSE"), join(DIST, "LICENSE"));

// package.json publicado: exports al JS compilado, sin scripts ni devDependencies
const dev = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const { scripts: _scripts, devDependencies: _dev, exports: devExports, ...rest } = dev;
const exports: Record<string, unknown> = {};
for (const [key, value] of Object.entries<string>(devExports)) {
  exports[key] = value.endsWith(".ts") ? { types: value.replace(/^\.\/src\//, "./").replace(/\.ts$/, ".d.ts"), import: value.replace(/^\.\/src\//, "./").replace(/\.ts$/, ".js") } : value;
}
const pkg = { ...rest, exports, types: "./index.d.ts" };
writeFileSync(join(DIST, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`Paquete ${pkg.name}@${pkg.version} escrito en ${DIST}. Valídalo con: npm pack ./dist`);
