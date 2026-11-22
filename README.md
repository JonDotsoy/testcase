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
- `testcase/scripts/`: `import-har.ts` (evidencia del proxy), `sync-report.ts` (campos derivados) y `render-report.ts` (HTML).
- `testcase/assets/`: plantilla HTML, JSON inicial y un reporte de ejemplo.

Los scripts no tienen dependencias y corren con `bun` o con Node 22.6 o superior.
