# @jondotsoy/testcase-view-report

Genera el reporte HTML de testcase a partir de un `report.json`. El resultado es una sola página, con los datos incrustados y sin dependencias externas salvo las fuentes de Google Fonts.

```ts
import { renderHTML } from "@jondotsoy/testcase-view-report";

const html = await renderHTML(report);
await writeFile("report.html", html);
```

`renderHTML(report, options?)` valida el reporte con [`@jondotsoy/testcase-report-dto`](../testcase-report-dto) y lanza `ReportValidationError` si no es válido. Opciones:

| Opción | Por defecto | Qué hace |
|---|---|---|
| `stripSecrets` | `false` | Copia para compartir: quita `secrets` y oculta sus valores en todo el reporte. |
| `fragment` | `false` | Solo el contenido, sin `<!doctype>`, `<html>`, `<head>` ni `<body>`. |
| `title` | `Reporte testmania <suite> #<n>` | Título de la página. |

También exporta `stripSecrets(report)` por separado.
