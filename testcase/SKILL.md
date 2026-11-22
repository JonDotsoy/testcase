---
name: testcase
description: Convierte los casos de prueba que describe la persona en un reporte HTML de testmania. El agente escribe cada caso como script TypeScript con Playwright, provisiona los servicios con Podman y un proxy de evidencia, mantiene el JSON del reporte y genera el HTML. Úsala cuando la persona describa casos de prueba, pida probar un flujo de una API o pida el reporte de pruebas.
---

# testcase

El resultado de esta skill es un **reporte HTML** de pruebas. Para llegar a él:

- **La persona describe los casos de prueba** en lenguaje natural ("un cliente no puede cancelar el pedido de otro").
- **El agente escribe cada caso de uso como un script TypeScript autocontenido** (`UC-NN.case.ts`): declara sus servicios con `defineService` y usa Playwright, tanto su cliente HTTP como el navegador. Los scripts viven en un espacio de trabajo temporal con su propio `package.json` y sus dependencias.
- **El agente mantiene un JSON** (`.testcase/report.json`) que sigue el schema de `references/report-schema.md`. Es la única fuente de verdad del reporte.
- **El agente provee los servicios, su configuración y los estados**: levanta los contenedores con Podman y pone un proxy delante de cada servicio URL para capturar la evidencia de cada request y response.
- **Los scripts de la skill** importan la evidencia, recalculan los totales y generan el HTML. El agente no escribe HTML a mano.

```text
persona: describe casos
  └─▶ agente: escribe cases/UC-NN.case.ts (defineCase + defineService, Playwright) en un espacio temporal
  └─▶ run.ts --plan: servicios al reporte + comandos de Podman ──▶ agente los levanta con su proxy de evidencia
        └─▶ run.ts: corre los casos por el proxy ──▶ .testcase/evidence/*.har + .testcase/run-assertions.json
              └─▶ import-har.ts ──▶ sync-report.ts ──▶ render-report.ts ──▶ .testcase/report.html
```

## Archivos de la skill

| Archivo | Para qué |
|---|---|
| `references/report-schema.md` | Schema del JSON: tablas por objeto, lectura por protocolo, secretos y JSON Schema completo. Léelo antes de editar el JSON por primera vez. |
| `assets/workspace/` | Plantilla del espacio de trabajo temporal: `package.json` (Playwright), `testcase.ts` (librería: `defineCase`, `defineService`, `notation`, `check`…), `run.ts` (runner y `--plan` de servicios) y `examples/UC-01.case.ts`. |
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

Los casos van en `$WS/cases/*.case.ts`: un archivo por caso (`UC-NN.case.ts`) o varios casos relacionados en un archivo. **Cada script es autocontenido**: importa desde `testcase.ts` todo lo que usa y declara con `defineService` los servicios que necesita. Así, el script basta para saber qué se prueba, contra qué y cómo.

```ts
import { defineCase, defineService, fromEnv, sensitive, title, given, when, then, notation, check, ensure, page, vars } from "../testcase.ts";

// Servicio URL que ya existe: sus requests pasan por el proxy de evidencia.
const api = defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });

// Contenedor que se levanta con Podman, con sus migraciones y seeds.
const db = defineService({
  name: "postgres",
  image: "docker.io/library/postgres:16.4-alpine",
  ports: [{ container: 5432 }],
  env: { POSTGRES_DB: "pedidos_test", POSTGRES_PASSWORD: fromEnv("PG_PASSWORD") },
  tmpfs: ["/var/lib/postgresql/data"],
  artifacts: [{ kind: "migration", source: "./db/migrations/*.sql" }, { kind: "seed", source: "./db/seeds/usuarios.sql" }],
  health: "pg_isready",
});

export default defineCase(() => {
  title(() => "Cliente no puede cancelar un pedido ajeno");
  notation("tenant", "tienda-norte");                 // anotación de todo el caso

  given("un pedido creado por María", async () => {
    notation("usuario", "pedro@acme.test");          // antes del request: la lleva el request que sigue
    const password = sensitive(process.env.PEDRO_PASSWORD); // en el reporte queda como ••••
    const login = await api.post("/v1/auth/token", { data: { email: "pedro@acme.test", password } });
    ensure("status == 200", login.status(), 200);
    vars.token = sensitive(login.body.access_token);  // body ya viene parseado
    notation("rol", login.body.user.role);            // después del request: se une a ese request
  });

  when("Pedro intenta cancelarlo", async () => {
    notation("dueño del recurso", "maria@acme.test");
    vars.cancel = await api.delete("/v1/orders/ord_01JD9", { headers: { authorization: `Bearer ${vars.token}` } });
  });

  then("la API responde 403", () => {
    check("status == 403", vars.cancel.status(), 403, { expectedFailure: true });
  });

  then("el pedido sigue en estado pending", async () => {
    notation("usuario", "maria@acme.test");
    const p = await page();                           // navegador de Playwright, también por el proxy
    await p.goto(api.url("/pedidos/ord_01JD9"));
    check('estado visible == "pending"', await p.locator("[data-estado]").textContent(), "pending");
  });
});
```

La API completa:

| | |
|---|---|
| `defineCase(() => { … })` | Declara el caso. La función corre una vez al cargar el archivo y debe ser síncrona: el código async va dentro de los pasos. Un archivo puede tener varios `defineCase` (por ejemplo `pedidos.case.ts` con UC-04 y UC-05 que comparten servicios); `export default` es opcional. |
| `title(texto)` · `title(() => texto)` | Título del caso. Una vez por caso. |
| `id("UC-NN")` | Si el archivo tiene un solo caso, es opcional: el id sale del nombre (`UC-03.case.ts` → `UC-03`). Si tiene varios, cada caso declara el suyo. |
| `given(texto, fn?)` · `when(…)` · `then(…)` | Pasos. Se ejecutan en el orden en que se escriben. `fn` es opcional: `given("un pedido de María")` deja el paso solo como texto. |
| `defineService({ name, endpoint, … })` | Servicio URL que ya existe (`connected`). Campos: `endpoint`, `version?`, `health?`. |
| `defineService({ name, image \| build, … })` | Contenedor (`provisioned`). Campos: `image` o `build` (texto con el contexto, o `{ context, dockerfile?, args?, target? }`; rutas relativas a la raíz del proyecto), `command?`, `tmpfs?` (rutas en memoria), `ports?` (`{ container, host? }`; sin `host` se asigna uno desde 55000), `env?`, `dependsOn?` (nombres o servicios), `storage?`, `artifacts?` (`{ kind, source, description? }`), `health?`, `http?` (si habla HTTP, va por proxy). |
| `fromEnv("VAR")` | Valor de `env` que sale del entorno del host. Queda enmascarado en el reporte, y si la variable existe al correr, su valor se ofusca como con `sensitive`. |
| `sensitive(valor)` | Declara un valor o texto sensible y lo devuelve tal cual: `const password = sensitive(process.env.PEDRO_PASSWORD)`. El caso usa el valor real; en el reporte y en el HTML queda como `••••` donde aparezca (URL, headers, bodies, anotaciones, aserciones). Va en el módulo, en `defineCase` o en un paso, por ejemplo `sensitive(login.body.access_token)`. Valores de menos de 4 caracteres no se registran. |
| `servicio.get/post/put/patch/delete/fetch(ruta, opts)` | Request HTTP (Playwright) por el proxy del servicio, con `data`, `form`, `params`, `headers`. Devuelve `body` (el JSON ya parseado, o el texto), `status()` y `headers()`. |
| `servicio.url(ruta)` | URL del servicio por el proxy, para `page().goto()`. |
| `notation(nombre, valor, { response? })` | Define una anotación y devuelve el valor: `const timeAlive = notation("time alive", res.body.timeAlive)`. En el cuerpo de `defineCase` es de todo el caso. En un paso, antes de un request, la llevan los requests que siguen en ese paso. Después de un request, se une a ese request. |
| `check(expresión, actual, esperado, { response?, expectedFailure? })` | Registra una aserción y sigue. Sin `response`, se une al último request del paso, o al último del caso si el paso no hizo ninguno (por ejemplo, un `then` que revisa la respuesta del `when`). |
| `ensure(…)` | Igual que `check`, pero detiene el caso si falla. |
| `page()` | Página de Playwright. Todos sus requests llevan las etiquetas del caso y del paso. |
| `vars` | Datos compartidos entre los pasos del caso. |

Cada caso necesita `title` y al menos un `given`, un `when` y un `then`. En el reporte, los textos de pasos repetidos se unen con " y ". Cada `fn` también recibe el contexto `t` con lo mismo (`t.check`, `t.require`, `t.notation`, `t.page`, `t.vars`, `t.api(nombre)`, `t.url(nombre, ruta)`), por si prefieres no importar las utilidades.

Si dos casos usan el mismo servicio, cada script lo declara con la misma definición. Si las definiciones difieren, `run.ts` falla y dice cuál.

Reglas:

- Un caso cubre un solo comportamiento. Si la persona describe varios en una frase, sepáralos y díselo.
- Usa las palabras de la persona en `title()`, `given()`, `when()` y `then()`. No inventes reglas de negocio: si algo es ambiguo, pregunta o escribe la lectura más probable y avísale.
- Los ids `UC-NN` son estables. No renumeres casos existentes.
- Las aserciones verifican lo que dice el `then`. Si el comportamiento correcto es un error (403, 429, un `errors` de GraphQL), pídelo de forma explícita con `expectedFailure: true`.
- Las credenciales salen de variables de entorno (`process.env`, `fromEnv`), nunca escritas en el script.
- Usa siempre los servicios declarados y `page()`. No uses `fetch` ni otro cliente: sus requests no llevarían las etiquetas ni pasarían por el proxy.
- Revisa los tipos con `bun run typecheck` antes de correr.

### 3. Proveer los servicios

Los servicios salen de los `defineService` de los scripts, y se levantan con un **archivo compose** que genera `run.ts`. **Usa Podman** (`podman compose`). Usa Docker (`docker compose`) solo si Podman no está instalado, y dilo en el reporte (`proxy.engine`, `run.runtime.engine`).

```sh
cd "$WS" && node run.ts --report /ruta/al/proyecto/.testcase/report.json --plan
```

`--plan` pasa al reporte los servicios declarados (`connected` con `host` y `endpoint`; `provisioned` con `image`, `build`, `ports`, `env` enmascarado y `dependsOn`), les asigna puertos y un proxy de evidencia a cada servicio HTTP, y escribe `.testcase/compose.yaml`:

- Un servicio de compose por contenedor, con `image` o `build` (contexto relativo a la raíz del proyecto), `ports`, `environment`, `tmpfs`, `command` y `depends_on`. Los contenedores se alcanzan entre sí por su nombre (`postgres:5432`).
- Un servicio `proxy-<nombre>` (mitmdump) por cada servicio HTTP, que escribe `.testcase/evidence/<nombre>.har` al detenerse.
- Los valores de `fromEnv()` quedan como `${VAR:?…}`: compose falla con un mensaje claro si la variable no existe.

No edites `compose.yaml` a mano: cambia los scripts y vuelve a correr `--plan`. La salida dice cómo levantarlo (`podman compose -f .testcase/compose.yaml up -d`, con `--build` si hay imágenes que construir), cómo detenerlo (primero `stop` de los proxies, después `down`) y qué queda pendiente para ti.

Levanta el compose y completa lo pendiente con datos reales:

- Aplica cada artefacto (migraciones, seeds, `.proto`, stubs) y regístralo en `artifacts` con su `status`, `items` y tiempos.
- Corre cada healthcheck y guarda el resultado en `health` (`healthy`, `unhealthy` o `timeout`). Un servicio conectado se revisa a través de su proxy.
- Agrega a `timeline` los eventos `service.up`, `artifact.apply`, `service.check` y `teardown` con los tiempos que mediste.
- Si un servicio no queda sano, no ejecutes los casos que dependen de él: deja `run.status: "error"` y explica a la persona qué falló.

Un servicio `connected` ya existe: no lo levantes, no le cargues datos y no lo detengas. Solo su proxy es tuyo. Agrega `version` y `tls` si los conoces.

Todo servicio HTTP se prueba **a través de su proxy**. Nunca llames al servicio directamente. `run.ts` usa `proxy.listen` como URL base, y avisa si un servicio HTTP no tiene proxy.

### 4. Correr los casos

```sh
cd "$WS" && node run.ts --report /ruta/al/proyecto/.testcase/report.json      # todos
node run.ts --report …/report.json --only UC-03                                 # solo algunos
```

`run.ts` abre una corrida nueva en el reporte (incrementa `run.number`, fija `run.startedAt` y vacía los requests), crea o actualiza cada caso en `useCases` desde su script, copia los scripts a `.testcase/cases/` y corre cada caso. Las aserciones quedan en `.testcase/run-assertions.json`. Si un caso falla antes de hacer requests, queda `pending` con el error como mensaje.

Después:

1. Detén el compose como indica `--plan`: primero `podman compose -f .testcase/compose.yaml stop proxy-…` (mitmdump escribe el HAR al detenerse), después `down`.
2. Importa la evidencia de cada servicio:

   ```sh
   bun <skill>/scripts/import-har.ts .testcase/report.json .testcase/evidence/api.har --service api
   ```

   Agrega un request por entrada del HAR con headers, bodies, estado y tiempos reales. Enmascara los secretos, cambia la URL local por la del servicio, deja `evidence` apuntando a la entrada del HAR y une cada aserción y cada `notation` de `run-assertions.json` con su request. Omite las entradas sin caso, las de corridas anteriores y los archivos estáticos del navegador. No duplica si lo corres de nuevo.

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

Al terminar, borra el espacio de trabajo temporal (`rm -rf "$WS"`) y `.testcase/run-sensitive.json`. Los scripts quedan en `.testcase/cases/`.

## Cambios posteriores

- **La persona agrega o cambia un caso**: edita o crea su script, corre `--plan` si cambió algún servicio, levanta el compose, corre `run.ts --only UC-NN`, importa, sincroniza y genera el HTML. Una corrida con `--only` reemplaza los requests del reporte: si quieres el reporte completo, corre todos los casos.
- **La persona quita un caso**: borra su script y su elemento en `useCases`, y vuelve a correr.
- **Historial**: antes de una corrida nueva, guarda una copia como `.testcase/report-<número>.json` si la persona lo pide.

## Anotaciones

Anota todos los requests con `notation(nombre, valor)`. Sirven para que una persona entienda el reporte sin preguntar. `paso` se agrega solo.

| Clave | Cuándo |
|---|---|
| `usuario` | Siempre que el request vaya autenticado: email o id de la cuenta. |
| `perfil` | Rol de esa cuenta: `cliente`, `administrador`, `visitante`, `servicio-interno`… |
| `tenant` | Si el sistema es multi-tenant. |
| `nota` | Por qué existe el request, si no es obvio. |
| `intento` | Número de reintento. |
| `fixture` | Dato de prueba que se usó. |

Las claves van en minúsculas (se permiten tildes, ñ y espacios), con `-` o `_` y un máximo de 64 caracteres, por ejemplo `time alive`. Un valor que no es texto, número ni booleano se guarda como JSON. **Nunca** pongas secretos en una anotación: los headers y bodies se enmascaran, las anotaciones no.

## Secretos

- Declara con `sensitive()` todo valor sensible que use un caso: contraseñas, tokens que recibe, llaves, datos personales que no deben verse. `run.ts` los ofusca en `run-assertions.json` y los deja en `.testcase/run-sensitive.json` (permisos 600) para que `import-har.ts` los ofusque en la evidencia importada. El HAR crudo de `evidence/` sí los trae: no lo compartas.
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
