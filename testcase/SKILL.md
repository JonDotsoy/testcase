---
name: testcase
description: Convierte los casos de prueba que describe la persona en un reporte HTML de testmania. El agente mantiene un JSON con los casos de uso, provisiona los servicios, ejecuta los requests, registra los resultados y genera el HTML. Úsala cuando la persona describa casos de prueba, pida probar un flujo de una API o pida el reporte de pruebas.
---

# testcase

El resultado de esta skill es un **reporte HTML** de pruebas. Para llegar a él:

- **La persona describe los casos de prueba** en lenguaje natural ("un cliente no puede cancelar el pedido de otro").
- **El agente mantiene un JSON** (`.testcase/report.json`) que sigue el schema de `references/report-schema.md`. Es la única fuente de verdad.
- **El agente provee los servicios, su configuración y los estados**: levanta los contenedores con Podman, pone un proxy delante de cada servicio URL para capturar evidencia, ejecuta los requests, registra lo que respondieron y decide si cada aserción pasó.
- **Los scripts** recalculan los totales y generan el HTML desde el JSON. El agente no escribe HTML a mano.

```text
persona: describe casos
   └─▶ agente: escribe useCases y services en .testcase/report.json
         └─▶ podman: servicios + proxy de evidencia ──▶ requests ──▶ .testcase/evidence/*.har
               └─▶ import-har.ts + aserciones ──▶ sync-report.ts ──▶ render-report.ts ──▶ .testcase/report.html
```

## Archivos de la skill

| Archivo | Para qué |
|---|---|
| `references/report-schema.md` | Schema del JSON: tablas por objeto, lectura por protocolo, secretos y JSON Schema completo. Léelo antes de editar el JSON por primera vez. |
| `assets/report.empty.json` | JSON inicial para un proyecto nuevo. |
| `assets/report.example.json` | Reporte completo de ejemplo (9 casos, 24 requests HTTP, gRPC, GraphQL, WebSocket y SQL). Úsalo como modelo. |
| `assets/report.template.html` | Plantilla del HTML. No la edites para un reporte puntual. |
| `scripts/sync-report.ts` | Recalcula los campos derivados del JSON (estados, totales, línea de tiempo, inventario de invocaciones). |
| `scripts/import-har.ts` | Importa al JSON la evidencia (HAR) que capturó el proxy de un servicio URL. |
| `scripts/render-report.ts` | Valida las referencias del JSON y genera el HTML. |

Los scripts no tienen dependencias. Córrelos con `bun <script>` o con `node <script>` (Node 22.6 o superior). En los comandos de abajo, `<skill>` es la carpeta donde está instalada esta skill.

## Flujo

### 1. Preparar el JSON

Si no existe `.testcase/report.json`, cópialo desde `assets/report.empty.json` y completa `manifest.suite` con el nombre del sistema que se prueba. Si existe, léelo completo antes de cambiar algo.

### 2. Escribir los casos de uso que describe la persona

Por cada caso, agrega o actualiza un elemento en `useCases`:

```json
{
  "id": "UC-03",
  "title": "Cliente no puede cancelar un pedido ajeno",
  "status": "pending",
  "given": "un pedido creado por otro cliente",
  "when": "intenta cancelarlo",
  "then": "la API responde 403 y el pedido no cambia",
  "handler": { "file": "agente" },
  "requestIds": [],
  "invocations": []
}
```

- Un caso cubre un solo comportamiento. Si la persona describe varios en una frase, sepáralos y díselo.
- Usa las palabras de la persona en `title`, `given`, `when` y `then`. No inventes reglas de negocio: si algo es ambiguo, pregunta o escribe la lectura más probable y avísale.
- Los ids `UC-NN` son estables. No renumeres casos existentes.
- Un caso nuevo queda `pending` hasta que ejecutes sus requests.

### 3. Proveer los servicios

Declara en `services` cada servicio que usan los casos. **Usa Podman para todo contenedor.** Usa Docker solo si Podman no está instalado, y dilo en el reporte (`proxy.engine`, `run.runtime.engine`).

- **`provisioned`**: lo levantas tú con `podman run -d --rm --name tc-<servicio> …`. Registra `image`, `ports`, `env` (marca las credenciales como sensibles), `dependsOn`, `storage` y los `artifacts` que cargaste (migraciones, seeds, `.proto`, stubs) con su `status`.
- **`connected`**: es un servicio URL que ya existe (por ejemplo `https://api.example.com`). Registra `host`, `endpoint`, `version` y `tls` si aplica. No lo levantes, no le cargues datos y no lo detengas.

#### Proxy de evidencia para servicios URL

Todo servicio `connected` se prueba **a través de un contenedor proxy** que captura cada request y response como evidencia. Nunca llames al servicio directamente.

```sh
mkdir -p .testcase/evidence
podman run -d --rm --name tc-proxy-api -p 18080:8080 \
  -v "$PWD/.testcase/evidence:/evidence:Z" \
  docker.io/mitmproxy/mitmproxy:11.0.2 \
  mitmdump --mode reverse:https://api.example.com --listen-port 8080 \
  --set hardump=/evidence/api.har
```

- Usa un proxy y un puerto local por servicio (`18080`, `18081`…), y registra el proxy en `services[].proxy` (`engine`, `image`, `container`, `listen`, `upstream`, `evidence`).
- Envía los requests a `listen` (`http://localhost:18080/...`) y marca cada uno con dos headers que el proxy deja en la evidencia:
  - `x-testcase-uc: UC-03` (obligatorio)
  - `x-testcase-annotations: {"usuario":"pedro@acme.test","perfil":"cliente","paso":"when"}`
- Al terminar, detén el proxy con `podman stop tc-proxy-api`. mitmdump escribe el HAR al detenerse.
- Importa la evidencia al JSON:

  ```sh
  bun <skill>/scripts/import-har.ts .testcase/report.json .testcase/evidence/api.har --service api
  ```

  El import agrega un request por entrada del HAR con headers, bodies, estado y tiempos reales, enmascara los secretos, cambia la URL local por la del servicio y deja `evidence` apuntando a la entrada del HAR. Las entradas sin `x-testcase-uc` se omiten. Puedes correrlo más de una vez: no duplica.
- Después agrega las `assertions` de cada request importado.

El HAR cubre HTTP y GraphQL. Para gRPC, WebSocket o SQL registra los requests a mano desde la salida de la herramienta (`grpcurl`, `websocat`, `psql`) con `evidence.source: "agent"`.

Para cada servicio ejecuta un healthcheck real y guarda el resultado en `health` (`healthy`, `unhealthy` o `timeout`). Agrega a `timeline` los eventos `service.up`, `artifact.apply`, `service.check` y `teardown` con los tiempos que mediste.

Si un servicio no queda sano, no ejecutes los casos que dependen de él: deja `run.status: "error"` y explica a la persona qué falló.

### 4. Ejecutar los requests y registrar los resultados

Para cada caso, ejecuta los pasos given → when → then con la herramienta del protocolo (`curl`, `grpcurl`, `websocat`, `psql` o la que corresponda). Los requests a servicios URL pasan por su proxy y entran al JSON con `import-har.ts`. El resto los agregas tú a `requests`. Cada request lleva:

- `protocol`, `method`, `target` y `url` con **la URL o el método exacto que invocaste**. Nunca escribas templates como `/v1/orders/{id}`.
- `startOffsetMs` y `durationMs` medidos desde `run.startedAt`.
- `request.headers` y `request.body` tal como se enviaron. `response.status`, `response.headers`, `response.body` (y `trailers` en gRPC, `frames` en WebSocket) tal como llegaron.
- `annotations` con el contexto del request (ver más abajo).
- `assertions` con lo que verifica el `then` del caso: `expression`, `passed` y, si falla, `expected` y `actual` con los valores reales.
- `reproduce` con el comando equivalente, usando variables de entorno para los secretos (`$TOKEN`).

**Nunca inventes una respuesta.** Todo `response` del JSON debe venir de una ejecución real. Si no pudiste ejecutar un request, no lo agregues: el caso queda `pending` y le dices a la persona por qué.

Si el comportamiento correcto es un error (403, 429, `FAILED_PRECONDITION`, un `errors` de GraphQL), la aserción lo pide de forma explícita y lleva `expectedFailure: true`.

### 5. Sincronizar y generar el HTML

```sh
bun <skill>/scripts/sync-report.ts .testcase/report.json
bun <skill>/scripts/render-report.ts .testcase/report.json -o .testcase/report.html
```

`sync-report.ts` recalcula `requests[].passed`, el estado de cada caso, `requestIds`, `invocations`, `failure` (con una explicación determinista si no escribiste una), `services[].requestCount`, los eventos `request` de la línea de tiempo, `summary` y `run`. No edites esos campos a mano: edita los datos de origen y corre el script.

`render-report.ts` revisa que los ids se crucen bien y falla con un mensaje claro si algo no calza. Corrige el JSON y vuelve a correrlo.

### 6. Entregar el reporte

Entrega `.testcase/report.html` a la persona y resume en pocas frases:

- Cuántos casos pasaron, fallaron o quedaron pendientes.
- Para cada fallo: el caso por título e id, qué se esperaba y qué llegó, y si parece un bug del servicio o un error del caso.

## Cambios posteriores

- **La persona agrega o cambia un caso**: edita solo ese caso y sus requests, vuelve a ejecutarlos, sincroniza y genera el HTML.
- **La persona quita un caso**: borra el caso y sus requests, sincroniza y genera el HTML.
- **Nueva corrida completa**: incrementa `run.number`, actualiza `run.id` y `run.startedAt`, y reemplaza los requests y los eventos de la línea de tiempo con los de la nueva ejecución. Si la persona quiere historial, guarda antes una copia como `.testcase/report-<número>.json`.

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
- No borres los archivos de `.testcase/evidence/`: son la evidencia del reporte.
