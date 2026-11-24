/**
 * build.ts
 *
 * Escribe en dist/ el paquete completo, listo para publicar: el JavaScript compilado con tsc, sus .d.ts y mapas de
 * fuente, los assets, README, LICENSE y un package.json propio con exports apuntando al JS.
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

// JavaScript, .d.ts y mapas de fuente
const tsc = createRequire(join(ROOT, "package.json")).resolve("typescript/bin/tsc");
const r = spawnSync(process.execPath, [tsc, "-p", join(PKG, "tsconfig.json")], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status ?? 1);

// Assets que el código lee con import.meta.url
cpSync(join(PKG, "src", "assets"), join(DIST, "assets"), { recursive: true });

// README y LICENSE
cpSync(existsSync(join(PKG, "README.md")) ? join(PKG, "README.md") : join(ROOT, "README.md"), join(DIST, "README.md"));
cpSync(join(ROOT, "LICENSE"), join(DIST, "LICENSE"));

// package.json publicado: el de desarrollo con exports al JS compilado y sin lo que solo sirve en el repo
const dev = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const entry = (name: string) => ({ types: `./${name}.d.ts`, import: `./${name}.js` });
const { scripts: _scripts, devDependencies: _dev, exports: _exports, ...rest } = dev;
const pkg = {
  ...rest,
  exports: {
    ".": entry("index"),
    "./runner": entry("runner"),
    "./package.json": "./package.json",
  },
  types: "./index.d.ts",
};
writeFileSync(join(DIST, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(`Paquete ${pkg.name}@${pkg.version} escrito en ${DIST}. Valídalo con: npm pack ./dist`);
