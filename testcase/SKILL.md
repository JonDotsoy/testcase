---
name: testcase
description: Convierte los casos de prueba que describe la persona en un reporte HTML de testmania. El agente escribe cada caso como script TypeScript con Playwright, provisiona los servicios con Podman y un proxy de evidencia, mantiene el JSON del reporte y genera el HTML. Úsala cuando la persona describa casos de prueba, pida probar un flujo de una API o pida el reporte de pruebas.
---

# testcase

El resultado de esta skill es un **reporte HTML** de pruebas. Para llegar a él:

- **La persona describe los casos de prueba** en lenguaje natural ("un cliente no puede cancelar el pedido de otro").
- **El agente escribe cada caso de uso como un script TypeScript** (`UC-NN.case.ts`) que usa Playwright, tanto su cliente HTTP como el navegador. Los scripts viven en un espacio de trabajo temporal con su propio `package.json` y sus dependencias.
- **El agente mantiene un JSON** (`.testcase/report.json`) que sigue el schema de `references/report-schema.md`. Es la única fuente de verdad del reporte.
- **El agente provee los servicios, su configuración y los estados**: levanta los contenedores con Podman y pone un proxy delante de cada servicio URL para capturar la evidencia de cada request y response.
- **Los scripts de la skill** importan la evidencia, recalculan los totales y generan el HTML. El agente no escribe HTML a mano.

```text
persona: describe casos
  └─▶ agente: escribe cases/UC-NN.case.ts (Playwright) en un espacio temporal
  └─▶ agente: declara services en .testcase/report.json y los levanta con Podman + proxy de evidencia
        └─▶ run.ts: corre los casos por el proxy ──▶ .testcase/evidence/*.har + .testcase/run-assertions.json
              └─▶ import-har.ts ──▶ sync-report.ts ──▶ render-report.ts ──▶ .testcase/report.html
```

## Archivos de la skill

| Archivo | Para qué |
|---|---|
| `references/report-schema.md` | Schema del JSON: tablas por objeto, lectura por protocolo, secretos y JSON Schema completo. Léelo antes de editar el JSON por primera vez. |
| `assets/workspace/` | Plantilla del espacio de trabajo temporal: `package.json` (Playwright), `testcase.ts` (contexto del caso), `run.ts` (runner) y `examples/UC-01.case.ts`. |
| `assets/report.empty.json` | JSON inicial para un proyecto nuevo. |
| `assets/report.example.json` | Reporte completo de ejemplo (9 casos, 24 requests HTTP, gRPC, GraphQL, WebSocket y SQL). |
| `assets/report.template.html` | Plantilla del HTML. No la edites para un reporte puntual. |
| `scripts/import-har.ts` | Importa la evidencia (HAR) del proxy y la une con las aserciones del runner. |
| `scripts/sync-report.ts` | Recalcula los campos derivados del JSON (estados, totales, línea de tiempo, inventario de invocaciones). |
| `scripts/render-report.ts` | Valida las referencias del JSON y genera el HTML. |

Los scripts de `scripts/` no tienen dependencias: córrelos con `bun <script>` o `node <script>` (Node 22.6 o superior). En los comandos de abajo, `<skill>` es la carpeta donde está instalada esta skill y `$WS` es el espacio de trabajo temporal.

## Flujo

### 1. Preparar el reporte y el espacio de trabajo

Si no existe `.testcase/report.json`, cópialo desde `assets/report.empty.json` y completa `manifest.suite` con el nombre del sistema que se prueba. Si existe, léelo completo antes de cambiar algo.

Crea el espacio de trabajo en un directorio temporal, fuera del repositorio de la persona:

```sh
WS=$(mktemp -d -t testcase-XXXX)
cp -r <skill>/assets/workspace/. "$WS"/
cd "$WS" && bun install && bunx playwright install chromium
```

Si ya hay scripts en `.testcase/cases/` de una corrida anterior, cópialos a `$WS/cases/` para partir de ellos.

### 2. Escribir cada caso de uso como script

Un archivo por caso en `$WS/cases/UC-NN.case.ts`. El script define el caso (id, título, given, when, then) y lo ejecuta:

```ts
import { defineCase } from "../testcase.ts";

export default defineCase({
  id: "UC-03",
  title: "Cliente no puede cancelar un pedido ajeno",
  given: "un pedido creado por María",
  when: "Pedro intenta cancelarlo",
  then: "la API responde 403 y el pedido sigue en estado pending",
  annotations: { tenant: "tienda-norte" },

  async run(t) {
    const api = t.api("api");                       // Playwright APIRequestContext, por el proxy del servicio

    await t.step("given", { usuario: "pedro@acme.test", perfil: "cliente" });
    const login = await api.post("/v1/auth/token", { data: { email: "pedro@acme.test", password: process.env.PEDRO_PASSWORD } });
    t.require("status == 200", login.status(), 200, { response: login });
    const { access_token } = await login.json();

    await t.step("when", { usuario: "pedro@acme.test", perfil: "cliente", "dueño-del-recurso": "maria@acme.test" });
    const del = await api.delete("/v1/orders/ord_01JD9", { headers: { authorization: `Bearer ${access_token}` } });
    t.check("status == 403", del.status(), 403, { response: del, expectedFailure: true });

    await t.step("then", { usuario: "maria@acme.test", perfil: "cliente" });
    const page = await t.page();                    // navegador de Playwright, también por el proxy
    await page.goto(t.url("api", "/pedidos/ord_01JD9"));
    t.check("estado visible == \"pending\"", await page.locator("[data-estado]").textContent(), "pending");
  },
});
```

Lo que ofrece `t` (ver `testcase.ts`):

| | |
|---|---|
| `t.api(servicio)` | Cliente HTTP de Playwright hacia el servicio, a través de su proxy. `get`, `post`, `put`, `patch`, `delete`, `fetch`, con `data`, `form`, `params`, `headers` y `annotations`. |
| `t.page()` | Página de Playwright. Todos sus requests llevan las etiquetas del caso y del paso. |
| `t.url(servicio, ruta)` | URL del servicio por el proxy, para `page.goto()`. |
| `t.step(paso, anotaciones)` | Empieza `given`, `when` o `then` con sus anotaciones. |
| `t.annotate(anotaciones)` | Suma anotaciones al paso actual. |
| `t.check(expresión, actual, esperado, { response?, expectedFailure? })` | Registra una aserción y sigue. Sin `response`, se une al último request del paso. |
| `t.require(…)` | Igual que `check`, pero detiene el caso si falla. |
| `t.vars` | Datos compartidos entre pasos. |

Reglas:

- Un caso cubre un solo comportamiento. Si la persona describe varios en una frase, sepáralos y díselo.
- Usa las palabras de la persona en `title`, `given`, `when` y `then`. No inventes reglas de negocio: si algo es ambiguo, pregunta o escribe la lectura más probable y avísale.
- Los ids `UC-NN` son estables. No renumeres casos existentes.
- Las aserciones verifican lo que dice el `then`. Si el comportamiento correcto es un error (403, 429, un `errors` de GraphQL), pídelo de forma explícita con `expectedFailure: true`.
- Las credenciales salen de variables de entorno (`process.env`), nunca escritas en el script.
- Usa siempre `t.api()` y `t.page()`. No uses `fetch` ni otro cliente: sus requests no llevarían las etiquetas ni pasarían por el proxy.
- Revisa los tipos con `bun run typecheck` antes de correr.

### 3. Proveer los servicios

Declara en `services` del reporte cada servicio que usan los casos. **Usa Podman para todo contenedor.** Usa Docker solo si Podman no está instalado, y dilo en el reporte (`proxy.engine`, `run.runtime.engine`).

- **`provisioned`**: lo levantas tú con `podman run -d --rm --name tc-<servicio> …`. Registra `image`, `ports`, `env` (marca las credenciales como sensibles), `dependsOn`, `storage` y los `artifacts` que cargaste (migraciones, seeds, `.proto`, stubs) con su `status`.
- **`connected`**: es un servicio URL que ya existe (por ejemplo `https://api.example.com`). Registra `host`, `endpoint`, `version` y `tls` si aplica. No lo levantes, no le cargues datos y no lo detengas.

Para cada servicio ejecuta un healthcheck real y guarda el resultado en `health` (`healthy`, `unhealthy` o `timeout`). Agrega a `timeline` los eventos `service.up`, `artifact.apply`, `service.check` y `teardown` con los tiempos que mediste. Si un servicio no queda sano, no ejecutes los casos que dependen de él: deja `run.status: "error"` y explica a la persona qué falló.

#### Proxy de evidencia para servicios URL

Todo servicio `connected` se prueba **a través de un contenedor proxy** que captura cada request y response. Nunca llames al servicio directamente.

```sh
mkdir -p .testcase/evidence
podman run -d --rm --name tc-proxy-api -p 18080:8080 \
  -v "$PWD/.testcase/evidence:/evidence:Z" \
  docker.io/mitmproxy/mitmproxy:11.0.2 \
  mitmdump --mode reverse:https://api.example.com --listen-port 8080 \
  --set hardump=/evidence/api.har
```

Usa un proxy y un puerto local por servicio (`18080`, `18081`…) y regístralo en `services[].proxy` (`engine`, `image`, `container`, `listen`, `upstream`, `evidence`). `run.ts` toma `proxy.listen` como URL base del servicio.

### 4. Correr los casos

```sh
cd "$WS" && node run.ts --report /ruta/al/proyecto/.testcase/report.json      # todos
node run.ts --report …/report.json --only UC-03                                 # solo algunos
```

`run.ts` abre una corrida nueva en el reporte (incrementa `run.number`, fija `run.startedAt` y vacía los requests), crea o actualiza cada caso en `useCases` desde su script, copia los scripts a `.testcase/cases/` y corre cada caso. Las aserciones quedan en `.testcase/run-assertions.json`. Si un caso falla antes de hacer requests, queda `pending` con el error como mensaje.

Después:

1. Detén cada proxy: `podman stop tc-proxy-api`. mitmdump escribe el HAR al detenerse.
2. Importa la evidencia de cada servicio:

   ```sh
   bun <skill>/scripts/import-har.ts .testcase/report.json .testcase/evidence/api.har --service api
   ```

   Agrega un request por entrada del HAR con headers, bodies, estado y tiempos reales. Enmascara los secretos, cambia la URL local por la del servicio, deja `evidence` apuntando a la entrada del HAR y une cada aserción de `run-assertions.json` con su request. Omite las entradas sin caso, las de corridas anteriores y los archivos estáticos del navegador. No duplica si lo corres de nuevo.

El proxy cubre HTTP y GraphQL. Para gRPC, WebSocket o SQL registra los requests en el JSON desde la salida de la herramienta (`grpcurl`, `websocat`, `psql`), con `evidence.source: "agent"`, sus aserciones y los mismos campos que un request importado.

**Nunca inventes una respuesta.** Todo `response` del JSON debe venir de una ejecución real.

### 5. Sincronizar y generar el HTML

```sh
bun <skill>/scripts/sync-report.ts .testcase/report.json
bun <skill>/scripts/render-report.ts .testcase/report.json -o .testcase/report.html
```

`sync-report.ts` recalcula `requests[].passed`, el estado de cada caso, `requestIds`, `invocations`, `failure` (con una explicación determinista), `services[].requestCount`, los eventos `request` de la línea de tiempo, `summary` y `run`. No edites esos campos a mano.

`render-report.ts` revisa que los ids se crucen bien y falla con un mensaje claro si algo no calza.

### 6. Entregar el reporte

Entrega `.testcase/report.html` a la persona y resume en pocas frases:

- Cuántos casos pasaron, fallaron o quedaron pendientes.
- Para cada fallo: el caso por título e id, qué se esperaba y qué llegó, y si parece un bug del servicio o un error del caso.

Al terminar, borra el espacio de trabajo temporal (`rm -rf "$WS"`). Los scripts quedan en `.testcase/cases/`.

## Cambios posteriores

- **La persona agrega o cambia un caso**: edita o crea su script, levanta los proxies, corre `run.ts --only UC-NN`, importa, sincroniza y genera el HTML. Una corrida con `--only` reemplaza los requests del reporte: si quieres el reporte completo, corre todos los casos.
- **La persona quita un caso**: borra su script y su elemento en `useCases`, y vuelve a correr.
- **Historial**: antes de una corrida nueva, guarda una copia como `.testcase/report-<número>.json` si la persona lo pide.

## Anotaciones

Anota todos los requests. Sirven para que una persona entienda el reporte sin preguntar.

| Clave | Cuándo |
|---|---|
| `usuario` | Siempre que el request vaya autenticado: email o id de la cuenta. |
| `perfil` | Rol de esa cuenta: `cliente`, `administrador`, `visitante`, `servicio-interno`… |
| `paso` | `given`, `when` o `then`. |
| `tenant` | Si el sistema es multi-tenant. |
| `nota` | Por qué existe el request, si no es obvio. |
| `intento` | Número de reintento. |
| `fixture` | Dato de prueba que se usó. |

Las claves van en minúsculas (se permiten tildes y ñ), con `-` o `_` y un máximo de 64 caracteres. **Nunca** pongas secretos en una anotación: los headers y bodies se enmascaran, las anotaciones no.

## Secretos

- Todo header, variable o campo de body con un token, contraseña, cookie o llave va enmascarado (`"••••"`, `"Bearer ••••"`) con `sensitive: true` y un `secretRef` (`sec_1`, `sec_2`…). En los bodies, usa `redactions` con el JSONPath del campo.
- Por defecto **no** escribas el mapa `secrets`. Agrégalo solo si la persona pide ver los valores sensibles en el reporte. En ese caso el HTML muestra el botón "Mostrar valores sensibles".
- Para generar una copia sin secretos de un reporte que sí los trae: `render-report.ts … --strip-secrets`.

## Qué no hacer

- No inventes respuestas, tiempos ni estados.
- No cambies el `then` de un caso para que calce con lo que hace el sistema sin confirmarlo con la persona.
- No borres ni desactives un caso para que el reporte salga verde.
- No edites el HTML generado ni la plantilla para un reporte puntual.
- No toques un servicio `connected` más allá de los requests de los casos, y no lo llames sin pasar por su proxy.
- No instales dependencias del espacio de trabajo en el repositorio de la persona: van en el directorio temporal.
- No borres los archivos de `.testcase/evidence/`: son la evidencia del reporte.
