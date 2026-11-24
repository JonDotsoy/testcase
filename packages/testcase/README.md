# @jondotsoy/testcase

Casos de uso como scripts TypeScript, con la evidencia HTTP de cada request y un reporte HTML. Es la librería de la skill [`testcase`](https://github.com/JonDotsoy/testcase).

> [!WARNING]
> **Versión experimental (0.x).** La API puede cambiar entre versiones sin compatibilidad hacia atrás.

```ts
import { defineCase, defineService, title, given, when, then, check } from "@jondotsoy/testcase";

const api = await defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });

await defineCase(async () => {
  await title("Cliente no puede cancelar un pedido ajeno");
  await given("un pedido de María");
  const res = await when("Pedro intenta cancelarlo", () => api.http.delete("/v1/orders/ord_01JD9"));
  await then("la API responde 403", () => check("status == 403", res.status(), 403, { expectedFailure: true }));
});
```

| Entrada | Para quién |
|---|---|
| `@jondotsoy/testcase` | Los casos (`*.case.ts`): `defineCase`, pasos, `defineService` (con `http.*` y `graphql.*`), `check`, `ensure`, validadores, `sensitive`, `notation`, `vars`, `page`, `Cookies`. |
| `@jondotsoy/testcase/runner` | El runner: `takeDefinedCases`, `declaredServices`, `createContext`, `CaseAbort`… |

Solo ESM. Node 22.18 o superior (o Bun). Playwright es `peerDependency`.

Usa siempre `import { … } from "@jondotsoy/testcase"` (estático): la entrada exporta `then`, así que `await import("@jondotsoy/testcase")` trataría el módulo como una promesa.

Licencia [MIT](https://github.com/JonDotsoy/testcase/blob/develop/LICENSE).
