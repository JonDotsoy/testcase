/**
 * Regenera las capturas del README a partir del reporte de ejemplo (testcase/assets/report.example.json).
 *
 *   npm run docs:screenshots
 *
 * Necesita Chromium de Playwright (npx playwright install chromium).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "docs");
const tmp = mkdtempSync(join(tmpdir(), "testcase-shots-"));
const html = join(tmp, "report.html");

execFileSync(process.execPath, [join(root, "testcase/scripts/render-report.ts"), join(root, "testcase/assets/report.example.json"), "-o", html], { stdio: "inherit" });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  await page.goto(pathToFileURL(html).href);
  await page.waitForLoadState("networkidle");

  // Resumen de la corrida y tarjetas de los casos de uso.
  await page.screenshot({ path: join(out, "report-overview.png") });

  // Línea de tiempo con el detalle del request seleccionado (anotaciones, aserciones, metadata).
  const section = page.locator("section", { has: page.locator("h2", { hasText: "Línea de tiempo" }) }).first();
  const box = await section.evaluate((e) => {
    const r = e.getBoundingClientRect();
    return { y: r.top + scrollY - 16, height: r.height + 32 };
  });
  await page.screenshot({ path: join(out, "report-timeline.png"), fullPage: true, clip: { x: 0, y: box.y, width: 1440, height: box.height } });
  console.log(`Capturas en ${out}: report-overview.png, report-timeline.png`);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
