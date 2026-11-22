# testcase

Skill para agentes que convierten los casos de prueba que describe una persona en un reporte HTML de [testmania](https://testmania.dev). El agente mantiene un JSON (`.testcase/report.json`), levanta los servicios con Podman, pone un proxy delante de cada servicio URL para capturar evidencia y genera el HTML con los scripts de la skill.

## Instalación

```sh
bunx skills add ./testcase
```

o directamente desde GitHub:

```sh
bunx skills add JonDotsoy/testcase
```

## Contenido

- `testcase/SKILL.md`: flujo de trabajo de la skill.
- `testcase/references/report-schema.md`: schema del reporte JSON.
- `testcase/scripts/`: `cases.ts` (ejecuta los `*.case.ts` en un espacio temporal con Playwright), `import-har.ts` (evidencia del proxy), `sync-report.ts` (campos derivados) y `render-report.ts` (HTML).
- `testcase/assets/`: plantilla HTML, JSON inicial y un reporte de ejemplo.

Los scripts no tienen dependencias y corren con `bun` o con Node 22.6 o superior.

## Pruebas

Las pruebas validan toda la skill: la librería de los casos (`testcase.ts`), `run.ts --plan` y el `compose.yaml` que genera, `cases.ts`, `import-har.ts`, `sync-report.ts`, `render-report.ts`, el schema del reporte y un flujo completo con Playwright, un servidor de prueba y un proxy que graba el HAR como mitmdump.

```sh
npm install                          # o bun install
npx playwright install chromium      # para el flujo completo; sin Chromium esas pruebas se omiten
npm test                             # todas
npm run test:unit                    # sin navegador
npm run test:e2e                     # flujo completo
npm run typecheck
```

Requieren Node 22.18 o superior. La prueba de `compose.yaml` usa `docker compose config` si está instalado.
