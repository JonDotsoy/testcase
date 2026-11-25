# @jondotsoy/testcase-report-dto

Esquema del reporte de testcase (`report.json`, `reportVersion: "1.0"`) en [zod](https://zod.dev): los tipos de TypeScript y la validación completa.

```ts
import { validateReport, parseReport, type Report } from "@jondotsoy/testcase-report-dto";

const result = validateReport(JSON.parse(text));
if (!result.success) console.error(result.issues.join("\n"));

const report: Report = parseReport(data); // o lanza ReportValidationError
```

- `reportSchema` y un esquema por sección (`useCaseSchema`, `requestSchema`, `serviceSchema`, `statusSchema`…), con sus tipos (`Report`, `UseCase`, `Request`, `Service`…).
- `validateReport(data)` revisa la estructura y las referencias entre secciones (requests → casos, casos → requests, requests → servicios). No lanza.
- `parseReport(data)` devuelve el reporte o lanza `ReportValidationError` con `issues`.
- `reportJsonSchema()` devuelve el esquema como JSON Schema 2020-12.

Los objetos son estrictos (un campo desconocido es un error) y el parseo no agrega valores por defecto: el reporte sale tal cual entró. La estructura está documentada en `references/report-schema.md` de la skill testcase.
