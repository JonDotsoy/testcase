# Schema del reporte JSON de testmania

**Versión del reporte:** `1.0` · **Estado:** propuesta · **Fecha:** 22 nov 2026
**`$id`:** `https://testmania.dev/schemas/report/1.0.json` (JSON Schema draft 2020-12)

Este documento define el JSON que genera `testmania run --report json`. El reporte HTML se construye a partir de este mismo JSON: todo lo que se ve en el HTML (casos de uso, línea de tiempo, detalle de cada request, servicios y anotaciones) sale de los campos descritos aquí.

Archivos junto a este documento:

- `report.schema.json`: el JSON Schema completo, igual al del final de este documento.
- `example.json`: un reporte recortado que valida contra el schema. Es el mismo ejemplo del final.
- `report-run-148.json`: el reporte completo de la corrida #148 (9 casos de uso y 24 requests), con secretos incluidos. Es el JSON que genera el HTML publicado.
- `scripts/render-report.ts` y `assets/report.template.html`: el script que convierte el JSON en HTML. Ver [Generar el HTML](#generar-el-html).

## Principios

1. **Los casos de uso van primero.** `useCases` es la entrada principal del reporte. Los requests, servicios y eventos de la línea de tiempo se relacionan con los casos de uso por id.
2. **URLs tal cual se invocaron.** `target`, `url` e `invocations` guardan la URL o el método exacto que se llamó (`/v1/orders/ord_01JD3K8Q2Z7W4M`). Nunca se guardan templates como `/v1/orders/{id}`, porque testmania no puede inferirlos.
3. **Sin IA.** `failure.explanation` es un texto determinista que se arma a partir de las aserciones fallidas.
4. **Secretos ocultos por defecto.** Los valores sensibles se reemplazan por `••••` y se marcan con `sensitive` y `secretRef`. Los valores reales solo se incluyen en `secrets` cuando se corre con `--include-secrets`.
5. **Tiempos relativos.** Todos los `*OffsetMs` se miden en milisegundos desde `run.startedAt`.

## Estructura general

```text
report
├── $schema, reportVersion, tool
├── run            corrida: id, comando, estado, duración, runtime
├── manifest       archivo, versión de sintaxis y suite
├── summary        totales de casos de uso, requests, aserciones y fases
├── useCases[]     casos de uso (given / when / then) e inventario de invocaciones
├── requests[]     cada request con su request, response, anotaciones y aserciones
├── services[]     servicios provisionados (Podman) y conectados (hosts externos)
├── timeline[]     eventos ordenados: provisionamiento, checks, build, requests, desmontaje
└── secrets?       solo con --include-secrets
```

## Raíz

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `$schema` | string (uri) | sí | URL del schema, `https://testmania.dev/schemas/report/1.0.json`. |
| `reportVersion` | `"1.0"` | sí | Versión del formato del reporte. Es independiente de la versión de sintaxis del manifiesto. |
| `tool` | object | sí | `name` (`"testmania"`) y `version` del binario que generó el reporte. |
| `run` | [Run](#run) | sí | Datos de la corrida. |
| `manifest` | [Manifest](#manifest) | sí | Manifiesto usado. |
| `summary` | [Summary](#summary) | sí | Totales precalculados. |
| `useCases` | [UseCase](#usecase)[] | sí | Casos de uso en el orden del manifiesto. |
| `requests` | [Request](#request)[] | sí | Requests en orden de inicio. |
| `services` | [Service](#service)[] | sí | Servicios declarados en `services` del manifiesto. |
| `timeline` | [TimelineEvent](#timelineevent)[] | sí | Todos los eventos con tiempo, ordenados por `startOffsetMs`. |
| `secrets` | object | no | Mapa `sec_N` → valor real. Solo existe si `run.secretsIncluded` es `true`. |

## Run

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `id` | string | sí | Identificador, con el formato `run_<número>`. |
| `number` | integer | sí | Número correlativo de la corrida. |
| `command` | string | sí | Comando ejecutado, por ejemplo `testmania run --report json`. |
| `mode` | `"local"` | sí | En 1.0 solo existe ejecución local. La ejecución remota llega en 2.0. |
| `status` | `passed` \| `failed` \| `error` | sí | `failed` si algún caso de uso falló. `error` si la corrida no pudo completarse (por ejemplo, un servicio no quedó sano). |
| `exitCode` | integer | sí | Código de salida del proceso. |
| `startedAt` / `finishedAt` | date-time | sí | En UTC. |
| `durationMs` | number | sí | Duración total. |
| `secretsIncluded` | boolean | no | `true` si se usó `--include-secrets`. Por defecto es `false`. |
| `runtime` | object | sí | `engine` (`"podman"`) y `version`. |

## Manifest

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `path` | string | sí | Ruta del manifiesto, relativa al proyecto. |
| `version` | string | sí | Valor de `version` del manifiesto (`"1"`, `"1.0"`, `"1.5"`…). |
| `suite` | string | sí | Nombre de la suite. |
| `envFiles` | string[] | no | Archivos `.env` cargados. |

## Summary

| Campo | Tipo | Descripción |
|---|---|---|
| `useCases` | `{ total, passed, failed, pending }` | Conteo por estado. |
| `requests` | `{ total, byProtocol }` | `byProtocol` usa las claves `http`, `grpc`, `graphql`, `ws` y `sql`. |
| `assertions` | `{ total, passed, failed }` | Suma de las aserciones de todos los requests. |
| `phases` | `{ provisioningMs, buildMs, testsMs, teardownMs }` | Tiempo de cada fase de la corrida. |

## UseCase

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `id` | string `UC-NN` | sí | Id estable del caso de uso. |
| `title` | string | sí | Título que aparece en el manifiesto. |
| `status` | `passed` \| `failed` \| `pending` | sí | `pending` indica que el handler todavía no está implementado. |
| `given` / `when` / `then` | string | sí | Texto del manifiesto, sin cambios. |
| `handler` | `{ file, line? }` | sí | Archivo TypeScript del handler. |
| `startOffsetMs` / `durationMs` | number | no | No existen si el caso no se ejecutó. |
| `requestIds` | integer[] | sí | Requests del caso, en orden. |
| `invocations` | Invocation[] | sí | Inventario de lo que se invocó: `{ protocol, method, target, count }`. Se agrupan solo las llamadas con el mismo protocolo, método y `target` exacto. |
| `failure` | object | si `failed` | `explanation` (texto sin IA), `requestIds` y `assertionIds` que causaron el fallo. |
| `pending` | object | si `pending` | `reason` (`handler-not-implemented` \| `skipped`) y `message`. |

## Request

Campos comunes a todos los protocolos:

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `id` | integer | sí | Número correlativo dentro de la corrida (1, 2, 3…). |
| `useCaseId` | string | sí | Caso de uso al que pertenece. |
| `protocol` | `http` \| `grpc` \| `graphql` \| `ws` \| `sql` | sí | Define cómo se leen `method`, `target`, `body` y `status`. |
| `transport` | string | no | Detalle legible, por ejemplo `HTTP/1.1`, `HTTP/2 unary` o `WebSocket events.v1`. |
| `method` | string | sí | Ver la tabla por protocolo. |
| `target` | string | sí | Ver la tabla por protocolo. Siempre es el valor invocado, nunca un template. |
| `url` | string | sí | URL completa, incluido el host (`https://api.example.com/...`, `grpc://localhost:50051/...`). |
| `services` | string[] | sí | Servicios que participaron, en orden, por ejemplo `["api", "payments"]`. |
| `startOffsetMs` / `durationMs` | number | sí | Posición en la línea de tiempo. |
| `open` | boolean | no | `true` si la conexión siguió abierta (WebSocket). |
| `parentRequestId` | integer | no | En un frame de WebSocket, el id de la conexión que lo recibió. |
| `passed` | boolean | sí | `false` si alguna aserción falló. |
| `handler` | `{ file, line }` | sí | Línea del handler que hizo la llamada. |
| `annotations` | object | sí | [Anotaciones del desarrollador](#anotaciones). Puede ser `{}`. |
| `request` | `{ headers, body }` | sí | Lo que se envió. |
| `response` | `{ status, headers, trailers?, body, frames?, sizeBytes? }` | sí | Lo que se recibió. |
| `assertions` | [Assertion](#assertion)[] | sí | Aserciones evaluadas sobre este request. |
| `reproduce` | `{ tool, command, env? }` | no | Comando equivalente. Los secretos se reemplazan por variables de entorno, listadas en `env`. |
| `evidence` | `{ source, file?, entry? }` | no | Origen de la evidencia: `proxy` (capturada por el proxy de un servicio URL), `agent` (registrada por el agente) o `runner` (testmania). `file` y `entry` apuntan a la entrada del archivo de evidencia, por ejemplo un HAR. |

### Lectura por protocolo

| `protocol` | `method` | `target` | `request.headers` | `request.body.encoding` | `response.status` |
|---|---|---|---|---|---|
| `http` | Verbo HTTP (`GET`, `POST`…) | Ruta invocada (`/v1/orders/ord_01JD…`) | Headers HTTP | `json`, `text` o `none` | `{ kind:"http", code, reason }` |
| `grpc` | Método (`ReserveStock`) | Método completo (`inventory.v1.InventoryService/ReserveStock`) | Metadata | `protobuf-json` (decodificado con el `.proto`) | `{ kind:"grpc", code, name, message }` y, además, `response.trailers` |
| `graphql` | `QUERY` \| `MUTATION` \| `SUBSCRIPTION` | `operationName` | Headers HTTP | `graphql`: `{ operationName, query, variables }` | `{ kind:"graphql", httpCode, hasData, errorCount }` |
| `ws` | `CONNECT` \| `MESSAGE` | URL `wss://…` o nombre del evento | Headers del handshake | `json` o `text` (frame enviado) | `{ kind:"ws", event, httpCode?, closeCode? }` y, además, `response.frames` |
| `sql` | Comando (`SELECT`, `INSERT`…) | Resumen de la sentencia | Datos de conexión (sin password visible) | `sql`: `{ statement, params }` | `{ kind:"sql", command, rowCount }` |

Todos los `status` llevan `label`, el texto listo para mostrar (`"201 Created"`, `"9 FAILED_PRECONDITION"`, `"1 fila"`).

### Header

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `name` | string | sí | En minúsculas para HTTP y gRPC. |
| `value` | string \| null | sí | `"••••"` si es sensible y no se incluyeron secretos. |
| `sensitive` | boolean | no | `true` en tokens, contraseñas, cookies y llaves de servicio. |
| `secretRef` | string `sec_N` | si `sensitive` | Clave para buscar el valor real en `secrets`. |

### Body

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `encoding` | `none` \| `json` \| `text` \| `protobuf-json` \| `graphql` \| `sql` | sí | Cómo interpretar `value`. |
| `contentType` | string | no | Content type original. |
| `value` | any | sí | Contenido. Es `null` si `encoding` es `none`. |
| `sizeBytes` | integer | no | Tamaño original. |
| `truncated` | boolean | no | `true` si `value` se recortó por tamaño. |
| `redactions` | `{ path, secretRef }[]` | no | Campos sensibles dentro de `value` (JSONPath, por ejemplo `$.password`). |

### Assertion

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `id` | string | sí | Con el formato `r<requestId>.a<n>`. |
| `expression` | string | sí | Lo que se verificó, en forma legible. |
| `passed` | boolean | sí | Resultado. |
| `expectedFailure` | boolean | no | `true` si la prueba esperaba un error (403, 429, `FAILED_PRECONDITION`…). Un error esperado cuenta como éxito. |
| `expected` / `actual` | any | no | Se llenan cuando `passed` es `false`. Alimentan la explicación del fallo. |

## Anotaciones

`annotations` es un objeto libre que el desarrollador llena desde el handler:

```ts
await ctx.http.post("/v1/orders", {
  body,
  annotations: { usuario: maria.email, perfil: "cliente", tenant: "tienda-norte", paso: "when" },
});
```

- Las claves usan minúsculas (con tildes y ñ), números, espacios, `-` y `_`, con un máximo de 64 caracteres. Por ejemplo, `dueño del recurso` o `time alive`. En los scripts se definen con `notation("time alive", valor)`.
- Los valores son string, number o boolean.
- testmania no las interpreta, solo las guarda y las muestra. Las claves más comunes en la práctica son `usuario`, `perfil`, `tenant`, `paso`, `nota`, `intento` y `fixture`.
- Las anotaciones no deben llevar secretos. testmania no las enmascara.

Los datos del sistema (caso, handler, run, request-id) no van en `annotations`: ya están en `useCaseId`, `handler`, `run.id` e `id`.

## Service

Campos comunes:

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `name` | string | sí | Nombre en el manifiesto. |
| `mode` | `provisioned` \| `connected` | sí | `provisioned` es un contenedor que levanta testmania. `connected` es un servicio que ya existe y testmania no gestiona. |
| `endpoint` | string | sí | Dirección usada por las pruebas. |
| `health` | `{ check, status, durationMs }` | sí | Healthcheck ejecutado (`pg_isready`, `GET /healthz`…). `status` puede ser `healthy`, `unhealthy` o `timeout`. |
| `requestCount` | integer | sí | Requests de la corrida que pasaron por este servicio. |

Campos de `provisioned`:

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `image` | string | sí | Imagen de Podman con su tag. Si se construyó, el nombre que quedó (por ejemplo `localhost/testcase-pedidos-svc:latest`). |
| `build` | `{ context, dockerfile? }` | no | La imagen se construyó desde un Dockerfile del proyecto. |
| `ports` | `{ host, container, protocol? }[]` | no | Puertos publicados. |
| `env` | `{ name, source, value?, sensitive?, secretRef? }[]` | no | Origen de cada variable: `manifest`, `env-file`, `inferred` (credenciales inferidas para imágenes conocidas) o `service-ref`. |
| `dependsOn` | string[] | no | Servicios que deben estar listos antes. |
| `storage` | `tmpfs` \| `volume` \| `none` | no | Almacenamiento del contenedor. |
| `readyMs` | number | no | Tiempo hasta quedar listo, con los artefactos aplicados. |
| `artifacts` | [Artifact](#artifact)[] | sí | Artefactos provisionados. Puede ser `[]`. |
| `proxy` | igual que en `connected` | no | Proxy de evidencia delante del contenedor, si el servicio habla HTTP. `upstream` apunta al puerto publicado del contenedor. |

Campos de `connected`:

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `host` | string | sí | Host externo, por ejemplo `api.example.com`. |
| `version` | string | no | Versión que reporta el servicio. |
| `tls` | `{ version, validUntil }` | no | Datos del certificado, si el servicio usa TLS. |
| `proxy` | `{ engine?, image, container?, listen, upstream, evidence? }` | no | Contenedor proxy (Podman por defecto) que se interpone entre las pruebas y el servicio para capturar la evidencia de cada request y response. Las pruebas llaman a `listen` y el proxy reenvía a `upstream`. |

testmania no carga artefactos en un servicio `connected`, no lo levanta y no lo detiene. Sí puede levantar un proxy delante de él: el proxy es suyo y se elimina al terminar, el servicio no.

### Artifact

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `kind` | `migration` \| `seed` \| `proto` \| `stub` \| `file` | sí | Tipo de artefacto. |
| `source` | string | sí | Ruta o glob en el proyecto. |
| `description` | string | no | Resumen, por ejemplo `001_init … 012_payments`. |
| `items` | integer | no | Cantidad aplicada (migraciones, filas, SKU…). |
| `startOffsetMs` / `durationMs` | number | sí | Posición en la línea de tiempo. |
| `status` | `applied` \| `failed` \| `skipped` | sí | Resultado. |

## TimelineEvent

| Campo | Tipo | Req. | Descripción |
|---|---|---|---|
| `kind` | `request` \| `service.up` \| `artifact.apply` \| `service.check` \| `build` \| `teardown` | sí | Tipo de evento. |
| `label` | string | sí | Texto para mostrar. |
| `ref` | string \| integer | no | `requestId`, nombre del servicio o `source` del artefacto. |
| `useCaseId` | string | no | Solo en eventos `request`. |
| `startOffsetMs` / `durationMs` | number | sí | Posición en la línea de tiempo. |

El HTML muestra primero los eventos `request` agrupados por caso de uso y después la infraestructura.

## Secretos

- Por defecto, todo valor sensible se guarda como `"••••"`, con `sensitive: true` y un `secretRef`.
- Con `testmania run --include-secrets`, el reporte agrega `secrets: { "sec_1": "<valor>" }` y `run.secretsIncluded: true`. El botón "Mostrar valores sensibles" del HTML usa este mapa. Si `secrets` no existe, el botón no aparece.
- Un mismo secreto usado en varios lugares comparte su `secretRef`.
- `reproduce.command` siempre usa variables de entorno (`$TOKEN`). El HTML las reemplaza solo cuando se muestran los valores sensibles.

## Compatibilidad

- Los cambios que solo agregan campos opcionales mantienen `reportVersion: "1.0"`.
- Quitar campos, renombrarlos o cambiar su tipo obliga a subir a `"2.0"`.
- Quien consuma el reporte debe ignorar los campos que no conozca. El schema publicado es estricto (`additionalProperties: false`) para detectar errores en testmania.

## Puntos abiertos

- Si `requests[].id` debe ser un número o un id global (por ejemplo `run_148.17`) para cruzar corridas.
- Si los bodies grandes deben guardarse en archivos aparte (`body.file`) en lugar de recortarse.
- Si `--include-secrets` debe pedir confirmación o estar disponible solo en ejecución local.
- Si `SUBSCRIPTION` de GraphQL usa `ws` como protocolo o `graphql` con `frames`.

## Generar el HTML

`render-report.ts` lee el JSON y escribe un HTML de un solo archivo. El script no tiene dependencias y corre con Node 22.6 o superior, que ejecuta TypeScript directamente.

```sh
node scripts/render-report.ts report-run-148.json                     # escribe report-run-148.html
node scripts/render-report.ts report-run-148.json -o reporte.html
node scripts/render-report.ts report-run-148.json --strip-secrets     # quita "secrets" aunque el JSON los traiga
node scripts/render-report.ts report-run-148.json --fragment          # solo el contenido, sin <html> ni <head>
```

Qué hace el script:

1. Lee el JSON y revisa la estructura mínima: la versión del reporte, que los ids de casos de uso, requests y servicios se crucen bien, y que todo caso fallido traiga `failure`. Para validar el schema completo se usa `report.schema.json` con cualquier validador de JSON Schema 2020-12.
2. Incrusta el JSON en la plantilla, dentro de `<script type="application/json" id="report-data">`, escapando `<`, `>` y `&`.
3. Escribe el HTML. Toda la presentación se arma en el navegador a partir de ese JSON. El botón "Mostrar valores sensibles" aparece solo si el JSON trae `secrets`.

Con Node más antiguo se puede usar `npx tsx scripts/render-report.ts …`. En testmania este script sería la implementación de `testmania run --report html`: el comando escribe el JSON y después genera el HTML con la misma plantilla.

## Ejemplo

Ejemplo recortado: 3 de 9 casos de uso, 5 de 24 requests (HTTP, SQL, WebSocket, GraphQL y gRPC), 2 servicios y algunos eventos. Valida contra el schema, pero como faltan requests y servicios, los ids no se cruzan y `render-report.ts` lo rechaza. Para generar el HTML usa `report-run-148.json`.

```json
{
  "$schema": "https://testmania.dev/schemas/report/1.0.json",
  "reportVersion": "1.0",
  "tool": { "name": "testmania", "version": "1.0.0" },
  "run": {
    "id": "run_148",
    "number": 148,
    "command": "testmania run --report json",
    "mode": "local",
    "status": "failed",
    "exitCode": 1,
    "startedAt": "2026-11-22T15:10:04.120Z",
    "finishedAt": "2026-11-22T15:10:11.470Z",
    "durationMs": 7350,
    "secretsIncluded": false,
    "runtime": { "engine": "podman", "version": "5.2.1" }
  },
  "manifest": { "path": "testmania.yaml", "version": "1.0", "suite": "api-pedidos", "envFiles": [".env.test"] },
  "summary": {
    "useCases": { "total": 9, "passed": 6, "failed": 2, "pending": 1 },
    "requests": { "total": 24, "byProtocol": { "http": 15, "grpc": 4, "graphql": 2, "ws": 2, "sql": 1 } },
    "assertions": { "total": 44, "passed": 41, "failed": 3 },
    "phases": { "provisioningMs": 3460, "buildMs": 518, "testsMs": 2690, "teardownMs": 650 }
  },
  "useCases": [
    {
      "id": "UC-01",
      "title": "Cliente crea un pedido",
      "status": "passed",
      "given": "un cliente autenticado con stock disponible de 2 productos",
      "when": "crea un pedido con ambos productos",
      "then": "el pedido queda en estado pending y el stock queda reservado",
      "handler": { "file": "tests/pedidos/crear-pedido.handler.ts" },
      "startOffsetMs": 4010,
      "durationMs": 284,
      "requestIds": [1, 2, 3, 4, 5],
      "invocations": [
        { "protocol": "http", "method": "POST", "target": "/v1/auth/token", "count": 1 },
        { "protocol": "grpc", "method": "GetStock", "target": "inventory.v1.InventoryService/GetStock", "count": 2 },
        { "protocol": "http", "method": "POST", "target": "/v1/orders", "count": 1 },
        { "protocol": "sql", "method": "SELECT", "target": "orders WHERE id = $1", "count": 1 }
      ]
    },
    {
      "id": "UC-06",
      "title": "Reservar stock sin disponibilidad devuelve error",
      "status": "failed",
      "given": "un producto con 2 unidades en stock",
      "when": "se reservan 5 unidades",
      "then": "inventory responde FAILED_PRECONDITION",
      "handler": { "file": "tests/inventario/reserva-sin-stock.handler.ts" },
      "startOffsetMs": 5810,
      "durationMs": 26,
      "requestIds": [16, 17],
      "invocations": [
        { "protocol": "grpc", "method": "SetStock", "target": "inventory.v1.InventoryService/SetStock", "count": 1 },
        { "protocol": "grpc", "method": "ReserveStock", "target": "inventory.v1.InventoryService/ReserveStock", "count": 1 }
      ],
      "failure": {
        "explanation": "Se esperaba el código gRPC FAILED_PRECONDITION (9) y el servicio respondió OK (0). El stock era 2 y la reserva de 5 unidades fue aceptada, dejando available: -3.",
        "requestIds": [17],
        "assertionIds": ["r17.a1", "r17.a2"]
      }
    },
    {
      "id": "UC-08",
      "title": "Listar pedidos con paginación",
      "status": "pending",
      "given": "un cliente con 25 pedidos",
      "when": "pide la página 2 con limit=10",
      "then": "recibe 10 pedidos y un cursor a la página 3",
      "handler": { "file": "tests/pedidos/listar-paginado.handler.ts" },
      "requestIds": [],
      "invocations": [],
      "pending": { "reason": "handler-not-implemented", "message": "El handler se generó con su estructura pero todavía no tiene implementación." }
    }
  ],
  "requests": [
    {
      "id": 3,
      "useCaseId": "UC-01",
      "protocol": "http",
      "transport": "HTTP/1.1",
      "method": "POST",
      "target": "/v1/orders",
      "url": "https://api.example.com/v1/orders",
      "services": ["api"],
      "startOffsetMs": 4120,
      "durationMs": 146,
      "passed": true,
      "handler": { "file": "tests/pedidos/crear-pedido.handler.ts", "line": 24 },
      "annotations": { "usuario": "maria.gonzalez@acme.test", "perfil": "cliente", "tenant": "tienda-norte", "paso": "when", "idempotency": "crear-pedido-01" },
      "request": {
        "headers": [
          { "name": "authorization", "value": "Bearer ••••", "sensitive": true, "secretRef": "sec_1" },
          { "name": "content-type", "value": "application/json" },
          { "name": "idempotency-key", "value": "8c1d2f0a-6b7e-4f15-9a0e-3c2b6d1e7f40" },
          { "name": "x-tenant", "value": "tienda-norte" }
        ],
        "body": {
          "encoding": "json",
          "contentType": "application/json",
          "sizeBytes": 142,
          "value": { "items": [{ "sku": "CAF-ETI-250", "qty": 1 }, { "sku": "TAZ-CER-01", "qty": 1 }], "shipping": { "method": "standard", "address_id": "adr_331" }, "currency": "CLP" }
        }
      },
      "response": {
        "status": { "kind": "http", "label": "201 Created", "code": 201, "reason": "Created" },
        "headers": [
          { "name": "content-type", "value": "application/json; charset=utf-8" },
          { "name": "location", "value": "/v1/orders/ord_01JD3K8Q2Z7W4M" },
          { "name": "x-request-id", "value": "req_7f2a9e10" }
        ],
        "body": {
          "encoding": "json",
          "contentType": "application/json",
          "value": { "id": "ord_01JD3K8Q2Z7W4M", "status": "pending", "total": 24470, "currency": "CLP" }
        },
        "sizeBytes": 1229
      },
      "assertions": [
        { "id": "r3.a1", "expression": "status == 201", "passed": true },
        { "id": "r3.a2", "expression": "body.status == \"pending\"", "passed": true }
      ],
      "reproduce": {
        "tool": "curl",
        "command": "curl -X POST 'https://api.example.com/v1/orders' -H 'authorization: Bearer $TOKEN' -H 'content-type: application/json' -d '{\"items\":[...]}'",
        "env": ["TOKEN"]
      }
    },
    {
      "id": 5,
      "useCaseId": "UC-01",
      "protocol": "sql",
      "transport": "PostgreSQL",
      "method": "SELECT",
      "target": "orders WHERE id = $1",
      "url": "postgres://localhost:55432/pedidos_test",
      "services": ["postgres"],
      "startOffsetMs": 4290,
      "durationMs": 4,
      "passed": true,
      "handler": { "file": "tests/pedidos/crear-pedido.handler.ts", "line": 38 },
      "annotations": { "paso": "then", "nota": "verificación directa en base" },
      "request": {
        "headers": [
          { "name": "usuario", "value": "postgres" },
          { "name": "password", "value": "••••", "sensitive": true, "secretRef": "sec_4" }
        ],
        "body": { "encoding": "sql", "value": { "statement": "SELECT id, status, total, currency FROM orders WHERE id = $1", "params": ["ord_01JD3K8Q2Z7W4M"] } }
      },
      "response": {
        "status": { "kind": "sql", "label": "1 fila", "command": "SELECT", "rowCount": 1 },
        "headers": [],
        "body": { "encoding": "json", "value": [{ "id": "ord_01JD3K8Q2Z7W4M", "status": "pending", "total": 24470, "currency": "CLP" }] }
      },
      "assertions": [{ "id": "r5.a1", "expression": "rows[0].status == \"pending\"", "passed": true }],
      "reproduce": { "tool": "psql", "command": "psql 'postgres://postgres:$PGPASSWORD@localhost:55432/pedidos_test' -c \"SELECT ...\"", "env": ["PGPASSWORD"] }
    },
    {
      "id": 10,
      "useCaseId": "UC-04",
      "protocol": "ws",
      "transport": "WebSocket events.v1",
      "method": "CONNECT",
      "target": "wss://api.example.com/v1/events",
      "url": "wss://api.example.com/v1/events",
      "services": ["api"],
      "startOffsetMs": 4475,
      "durationMs": 1240,
      "open": true,
      "passed": true,
      "handler": { "file": "tests/admin/cambiar-estado.handler.ts", "line": 12 },
      "annotations": { "usuario": "lucia.ramos@acme.test", "perfil": "administrador", "paso": "given" },
      "request": {
        "headers": [
          { "name": "upgrade", "value": "websocket" },
          { "name": "sec-websocket-protocol", "value": "events.v1" },
          { "name": "authorization", "value": "Bearer ••••", "sensitive": true, "secretRef": "sec_2" }
        ],
        "body": { "encoding": "json", "value": { "type": "subscribe", "channel": "orders", "filter": { "order_id": "ord_01JD3K8Q2Z7W4M" } } }
      },
      "response": {
        "status": { "kind": "ws", "label": "101 Switching Protocols", "event": "handshake", "httpCode": 101 },
        "headers": [{ "name": "sec-websocket-protocol", "value": "events.v1" }],
        "body": { "encoding": "none", "value": null },
        "frames": [
          { "direction": "in", "offsetMs": 0, "opcode": "text", "data": { "type": "subscribed", "channel": "orders" } },
          { "direction": "in", "offsetMs": 176, "opcode": "text", "data": { "type": "order.status_changed", "from": "pending", "to": "shipped" } },
          { "direction": "out", "offsetMs": 1240, "opcode": "close", "data": "1000" }
        ]
      },
      "assertions": [{ "id": "r10.a1", "expression": "handshake 101", "passed": true }]
    },
    {
      "id": 15,
      "useCaseId": "UC-05",
      "protocol": "graphql",
      "method": "QUERY",
      "target": "SearchProductsInvalid",
      "url": "https://api.example.com/graphql",
      "services": ["api"],
      "startOffsetMs": 5792,
      "durationMs": 11,
      "passed": true,
      "handler": { "file": "tests/catalogo/buscar.handler.ts", "line": 21 },
      "annotations": { "usuario": "anónimo", "perfil": "visitante", "paso": "then" },
      "request": {
        "headers": [{ "name": "content-type", "value": "application/json" }],
        "body": { "encoding": "graphql", "value": { "operationName": "SearchProductsInvalid", "query": "query SearchProductsInvalid { products(search: \"etiopía\") { nodes { sku weightGrams } } }", "variables": {} } }
      },
      "response": {
        "status": { "kind": "graphql", "label": "200 OK · errors", "httpCode": 200, "hasData": false, "errorCount": 1 },
        "headers": [{ "name": "content-type", "value": "application/graphql-response+json" }],
        "body": { "encoding": "json", "value": { "errors": [{ "message": "Cannot query field \"weightGrams\" on type \"Product\".", "extensions": { "code": "GRAPHQL_VALIDATION_FAILED" } }] } }
      },
      "assertions": [{ "id": "r15.a1", "expression": "errors[0].extensions.code == \"GRAPHQL_VALIDATION_FAILED\"", "passed": true, "expectedFailure": true }]
    },
    {
      "id": 17,
      "useCaseId": "UC-06",
      "protocol": "grpc",
      "transport": "HTTP/2 unary",
      "method": "ReserveStock",
      "target": "inventory.v1.InventoryService/ReserveStock",
      "url": "grpc://localhost:50051/inventory.v1.InventoryService/ReserveStock",
      "services": ["inventory"],
      "startOffsetMs": 5822,
      "durationMs": 14,
      "passed": false,
      "handler": { "file": "tests/inventario/reserva-sin-stock.handler.ts", "line": 13 },
      "annotations": { "usuario": "maria.gonzalez@acme.test", "perfil": "cliente", "paso": "when", "nota": "reserva mayor al stock" },
      "request": {
        "headers": [
          { "name": "content-type", "value": "application/grpc+proto" },
          { "name": "x-service-token", "value": "svc_••••", "sensitive": true, "secretRef": "sec_3" }
        ],
        "body": { "encoding": "protobuf-json", "value": { "sku": "TAZ-CER-01", "quantity": 5, "order_id": "ord_01JD3KB0R7" } }
      },
      "response": {
        "status": { "kind": "grpc", "label": "0 OK", "code": 0, "name": "OK", "message": "" },
        "headers": [{ "name": "content-type", "value": "application/grpc+proto" }],
        "trailers": [{ "name": "grpc-status", "value": "0" }],
        "body": { "encoding": "protobuf-json", "value": { "reservation_id": "rsv_5512", "reserved": 5, "available": -3 } }
      },
      "assertions": [
        { "id": "r17.a1", "expression": "grpc-status == FAILED_PRECONDITION", "passed": false, "expected": "FAILED_PRECONDITION (9)", "actual": "OK (0)" },
        { "id": "r17.a2", "expression": "response.available >= 0", "passed": false, "expected": ">= 0", "actual": -3 }
      ],
      "reproduce": { "tool": "grpcurl", "command": "grpcurl -plaintext -H 'x-service-token: $SERVICE_TOKEN' -d '{\"sku\":\"TAZ-CER-01\",\"quantity\":5}' localhost:50051 inventory.v1.InventoryService/ReserveStock", "env": ["SERVICE_TOKEN"] }
    }
  ],
  "services": [
    {
      "name": "postgres",
      "mode": "provisioned",
      "image": "docker.io/library/postgres:16.4-alpine",
      "endpoint": "localhost:55432",
      "ports": [{ "host": 55432, "container": 5432, "protocol": "tcp" }],
      "env": [
        { "name": "POSTGRES_DB", "source": "env-file", "value": "pedidos_test" },
        { "name": "POSTGRES_PASSWORD", "source": "inferred", "value": "••••", "sensitive": true, "secretRef": "sec_4" }
      ],
      "storage": "tmpfs",
      "health": { "check": "pg_isready", "status": "healthy", "durationMs": 2140 },
      "readyMs": 2700,
      "requestCount": 1,
      "artifacts": [
        { "kind": "migration", "source": "./db/migrations/*.sql", "description": "001_init … 012_payments", "items": 12, "startOffsetMs": 2140, "durationMs": 470, "status": "applied" },
        { "kind": "seed", "source": "./db/seeds/usuarios.sql", "description": "2 clientes, 1 admin, 1 de servicio", "items": 4, "startOffsetMs": 2610, "durationMs": 50, "status": "applied" }
      ]
    },
    {
      "name": "api",
      "mode": "connected",
      "host": "api.example.com",
      "endpoint": "https://api.example.com",
      "version": "api-pedidos 2.14.0 · commit 9f3c1ab",
      "tls": { "version": "1.3", "validUntil": "2027-02-14" },
      "health": { "check": "GET /healthz", "status": "healthy", "durationMs": 84 },
      "requestCount": 19
    }
  ],
  "timeline": [
    { "kind": "service.up", "label": "postgres", "ref": "postgres", "startOffsetMs": 0, "durationMs": 2140 },
    { "kind": "artifact.apply", "label": "postgres · migraciones", "ref": "./db/migrations/*.sql", "startOffsetMs": 2140, "durationMs": 470 },
    { "kind": "service.check", "label": "api", "ref": "api", "startOffsetMs": 3460, "durationMs": 84 },
    { "kind": "build", "label": "handlers (tsx)", "startOffsetMs": 3472, "durationMs": 518 },
    { "kind": "request", "label": "POST /v1/orders", "ref": 3, "useCaseId": "UC-01", "startOffsetMs": 4120, "durationMs": 146 },
    { "kind": "teardown", "label": "contenedores provisionados", "startOffsetMs": 6700, "durationMs": 650 }
  ]
}
```

## JSON Schema completo

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://testmania.dev/schemas/report/1.0.json",
  "title": "testmania run report",
  "type": "object",
  "required": [
    "$schema",
    "reportVersion",
    "tool",
    "run",
    "manifest",
    "summary",
    "useCases",
    "requests",
    "services",
    "timeline"
  ],
  "additionalProperties": false,
  "properties": {
    "$schema": {
      "type": "string",
      "format": "uri"
    },
    "reportVersion": {
      "const": "1.0"
    },
    "tool": {
      "type": "object",
      "required": [
        "name",
        "version"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "const": "testmania"
        },
        "version": {
          "type": "string"
        }
      }
    },
    "run": {
      "type": "object",
      "required": [
        "id",
        "number",
        "command",
        "mode",
        "status",
        "exitCode",
        "startedAt",
        "finishedAt",
        "durationMs",
        "runtime"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string",
          "pattern": "^run_[0-9]+$"
        },
        "number": {
          "type": "integer",
          "minimum": 1
        },
        "command": {
          "type": "string"
        },
        "mode": {
          "enum": [
            "local"
          ]
        },
        "status": {
          "enum": [
            "passed",
            "failed",
            "error"
          ]
        },
        "exitCode": {
          "type": "integer"
        },
        "startedAt": {
          "type": "string",
          "format": "date-time"
        },
        "finishedAt": {
          "type": "string",
          "format": "date-time"
        },
        "durationMs": {
          "$ref": "#/$defs/ms"
        },
        "secretsIncluded": {
          "type": "boolean",
          "default": false
        },
        "runtime": {
          "type": "object",
          "required": [
            "engine",
            "version"
          ],
          "additionalProperties": false,
          "properties": {
            "engine": {
              "enum": [
                "podman"
              ]
            },
            "version": {
              "type": "string"
            }
          }
        }
      }
    },
    "manifest": {
      "type": "object",
      "required": [
        "path",
        "version",
        "suite"
      ],
      "additionalProperties": false,
      "properties": {
        "path": {
          "type": "string"
        },
        "version": {
          "type": "string"
        },
        "suite": {
          "type": "string"
        },
        "envFiles": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "summary": {
      "type": "object",
      "required": [
        "useCases",
        "requests",
        "assertions",
        "phases"
      ],
      "additionalProperties": false,
      "properties": {
        "useCases": {
          "type": "object",
          "required": [
            "total",
            "passed",
            "failed",
            "pending"
          ],
          "additionalProperties": false,
          "properties": {
            "total": {
              "$ref": "#/$defs/count"
            },
            "passed": {
              "$ref": "#/$defs/count"
            },
            "failed": {
              "$ref": "#/$defs/count"
            },
            "pending": {
              "$ref": "#/$defs/count"
            }
          }
        },
        "requests": {
          "type": "object",
          "required": [
            "total",
            "byProtocol"
          ],
          "additionalProperties": false,
          "properties": {
            "total": {
              "$ref": "#/$defs/count"
            },
            "byProtocol": {
              "type": "object",
              "propertyNames": {
                "$ref": "#/$defs/protocol"
              },
              "additionalProperties": {
                "$ref": "#/$defs/count"
              }
            }
          }
        },
        "assertions": {
          "type": "object",
          "required": [
            "total",
            "passed",
            "failed"
          ],
          "additionalProperties": false,
          "properties": {
            "total": {
              "$ref": "#/$defs/count"
            },
            "passed": {
              "$ref": "#/$defs/count"
            },
            "failed": {
              "$ref": "#/$defs/count"
            }
          }
        },
        "phases": {
          "type": "object",
          "required": [
            "provisioningMs",
            "buildMs",
            "testsMs",
            "teardownMs"
          ],
          "additionalProperties": false,
          "properties": {
            "provisioningMs": {
              "$ref": "#/$defs/ms"
            },
            "buildMs": {
              "$ref": "#/$defs/ms"
            },
            "testsMs": {
              "$ref": "#/$defs/ms"
            },
            "teardownMs": {
              "$ref": "#/$defs/ms"
            }
          }
        }
      }
    },
    "useCases": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/useCase"
      }
    },
    "requests": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/request"
      }
    },
    "services": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/service"
      }
    },
    "timeline": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/timelineEvent"
      }
    },
    "secrets": {
      "description": "Solo presente con --include-secrets. Mapa secretRef → valor real.",
      "type": "object",
      "propertyNames": {
        "pattern": "^sec_[0-9]+$"
      },
      "additionalProperties": {
        "type": "string"
      }
    }
  },
  "$defs": {
    "ms": {
      "type": "number",
      "minimum": 0
    },
    "count": {
      "type": "integer",
      "minimum": 0
    },
    "protocol": {
      "enum": [
        "http",
        "grpc",
        "graphql",
        "ws",
        "sql"
      ]
    },
    "useCaseId": {
      "type": "string",
      "pattern": "^UC-[0-9]{2,}$"
    },
    "requestId": {
      "type": "integer",
      "minimum": 1
    },
    "handlerRef": {
      "type": "object",
      "required": [
        "file"
      ],
      "additionalProperties": false,
      "properties": {
        "file": {
          "type": "string",
          "description": "Archivo del handler, o \"agente\" cuando el agente ejecutó el request directamente."
        },
        "line": {
          "type": "integer",
          "minimum": 1
        }
      }
    },
    "annotations": {
      "description": "Pares clave/valor libres definidos por el desarrollador. testmania no los interpreta.",
      "type": "object",
      "propertyNames": {
        "pattern": "^[a-z0-9áéíóúñü][a-z0-9áéíóúñü _-]*$",
        "maxLength": 64
      },
      "additionalProperties": {
        "type": [
          "string",
          "number",
          "boolean"
        ]
      }
    },
    "header": {
      "type": "object",
      "required": [
        "name",
        "value"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string"
        },
        "value": {
          "type": [
            "string",
            "null"
          ]
        },
        "sensitive": {
          "type": "boolean",
          "default": false
        },
        "secretRef": {
          "type": "string",
          "pattern": "^sec_[0-9]+$"
        }
      },
      "if": {
        "properties": {
          "sensitive": {
            "const": true
          }
        },
        "required": [
          "sensitive"
        ]
      },
      "then": {
        "required": [
          "secretRef"
        ]
      }
    },
    "redaction": {
      "type": "object",
      "required": [
        "path",
        "secretRef"
      ],
      "additionalProperties": false,
      "properties": {
        "path": {
          "type": "string",
          "description": "JSONPath dentro de body.value, p. ej. $.password"
        },
        "secretRef": {
          "type": "string",
          "pattern": "^sec_[0-9]+$"
        }
      }
    },
    "body": {
      "type": "object",
      "required": [
        "encoding",
        "value"
      ],
      "additionalProperties": false,
      "properties": {
        "encoding": {
          "enum": [
            "none",
            "json",
            "text",
            "protobuf-json",
            "graphql",
            "sql"
          ]
        },
        "contentType": {
          "type": "string"
        },
        "value": {},
        "sizeBytes": {
          "$ref": "#/$defs/count"
        },
        "truncated": {
          "type": "boolean",
          "default": false
        },
        "redactions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/redaction"
          }
        }
      }
    },
    "frame": {
      "type": "object",
      "required": [
        "direction",
        "offsetMs",
        "opcode",
        "data"
      ],
      "additionalProperties": false,
      "properties": {
        "direction": {
          "enum": [
            "in",
            "out"
          ]
        },
        "offsetMs": {
          "$ref": "#/$defs/ms"
        },
        "opcode": {
          "enum": [
            "text",
            "binary",
            "ping",
            "pong",
            "close"
          ]
        },
        "data": {}
      }
    },
    "status": {
      "type": "object",
      "required": [
        "kind",
        "label"
      ],
      "properties": {
        "kind": {
          "$ref": "#/$defs/protocol"
        },
        "label": {
          "type": "string"
        }
      },
      "oneOf": [
        {
          "properties": {
            "kind": {
              "const": "http"
            },
            "label": {
              "type": "string"
            },
            "code": {
              "type": "integer",
              "minimum": 100,
              "maximum": 599
            },
            "reason": {
              "type": "string"
            }
          },
          "required": [
            "code"
          ],
          "additionalProperties": false
        },
        {
          "properties": {
            "kind": {
              "const": "grpc"
            },
            "label": {
              "type": "string"
            },
            "code": {
              "type": "integer",
              "minimum": 0,
              "maximum": 16
            },
            "name": {
              "type": "string"
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "code",
            "name"
          ],
          "additionalProperties": false
        },
        {
          "properties": {
            "kind": {
              "const": "graphql"
            },
            "label": {
              "type": "string"
            },
            "httpCode": {
              "type": "integer"
            },
            "hasData": {
              "type": "boolean"
            },
            "errorCount": {
              "$ref": "#/$defs/count"
            }
          },
          "required": [
            "httpCode",
            "hasData",
            "errorCount"
          ],
          "additionalProperties": false
        },
        {
          "properties": {
            "kind": {
              "const": "ws"
            },
            "label": {
              "type": "string"
            },
            "event": {
              "enum": [
                "handshake",
                "frame",
                "close"
              ]
            },
            "httpCode": {
              "type": "integer"
            },
            "closeCode": {
              "type": "integer"
            }
          },
          "required": [
            "event"
          ],
          "additionalProperties": false
        },
        {
          "properties": {
            "kind": {
              "const": "sql"
            },
            "label": {
              "type": "string"
            },
            "command": {
              "type": "string"
            },
            "rowCount": {
              "$ref": "#/$defs/count"
            }
          },
          "required": [
            "command",
            "rowCount"
          ],
          "additionalProperties": false
        }
      ]
    },
    "assertion": {
      "type": "object",
      "required": [
        "id",
        "expression",
        "passed"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "type": "string"
        },
        "expression": {
          "type": "string"
        },
        "passed": {
          "type": "boolean"
        },
        "expectedFailure": {
          "type": "boolean",
          "default": false,
          "description": "La prueba esperaba un estado de error (403, 429, FAILED_PRECONDITION…)."
        },
        "expected": {},
        "actual": {}
      }
    },
    "useCase": {
      "type": "object",
      "required": [
        "id",
        "title",
        "status",
        "given",
        "when",
        "then",
        "handler",
        "requestIds",
        "invocations"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "$ref": "#/$defs/useCaseId"
        },
        "title": {
          "type": "string"
        },
        "status": {
          "enum": [
            "passed",
            "failed",
            "pending"
          ]
        },
        "given": {
          "type": "string"
        },
        "when": {
          "type": "string"
        },
        "then": {
          "type": "string"
        },
        "handler": {
          "$ref": "#/$defs/handlerRef"
        },
        "startOffsetMs": {
          "$ref": "#/$defs/ms"
        },
        "durationMs": {
          "$ref": "#/$defs/ms"
        },
        "requestIds": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/requestId"
          }
        },
        "invocations": {
          "description": "Inventario de URLs y métodos invocados tal cual, sin templates. Se agrupan solo llamadas idénticas.",
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "protocol",
              "method",
              "target",
              "count"
            ],
            "additionalProperties": false,
            "properties": {
              "protocol": {
                "$ref": "#/$defs/protocol"
              },
              "method": {
                "type": "string"
              },
              "target": {
                "type": "string"
              },
              "count": {
                "type": "integer",
                "minimum": 1
              }
            }
          }
        },
        "failure": {
          "type": "object",
          "required": [
            "explanation",
            "requestIds",
            "assertionIds"
          ],
          "additionalProperties": false,
          "properties": {
            "explanation": {
              "type": "string",
              "description": "Texto determinista generado desde las aserciones, sin IA."
            },
            "requestIds": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/requestId"
              },
              "minItems": 1
            },
            "assertionIds": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "minItems": 1
            }
          }
        },
        "pending": {
          "type": "object",
          "required": [
            "reason"
          ],
          "additionalProperties": false,
          "properties": {
            "reason": {
              "enum": [
                "handler-not-implemented",
                "skipped"
              ]
            },
            "message": {
              "type": "string"
            }
          }
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "status": {
                "const": "failed"
              }
            }
          },
          "then": {
            "required": [
              "failure"
            ]
          }
        },
        {
          "if": {
            "properties": {
              "status": {
                "const": "pending"
              }
            }
          },
          "then": {
            "required": [
              "pending"
            ]
          }
        }
      ]
    },
    "request": {
      "type": "object",
      "required": [
        "id",
        "useCaseId",
        "protocol",
        "method",
        "target",
        "url",
        "services",
        "startOffsetMs",
        "durationMs",
        "passed",
        "handler",
        "annotations",
        "request",
        "response",
        "assertions"
      ],
      "additionalProperties": false,
      "properties": {
        "id": {
          "$ref": "#/$defs/requestId"
        },
        "useCaseId": {
          "$ref": "#/$defs/useCaseId"
        },
        "protocol": {
          "$ref": "#/$defs/protocol"
        },
        "transport": {
          "type": "string",
          "description": "Detalle legible: HTTP/1.1, HTTP/2 unary, events.v1…"
        },
        "method": {
          "type": "string",
          "description": "Verbo HTTP, método gRPC, QUERY/MUTATION, CONNECT/MESSAGE o comando SQL."
        },
        "target": {
          "type": "string",
          "description": "Ruta, método completo gRPC, operationName o sentencia resumida, tal cual se invocó."
        },
        "url": {
          "type": "string"
        },
        "services": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1
        },
        "startOffsetMs": {
          "$ref": "#/$defs/ms"
        },
        "durationMs": {
          "$ref": "#/$defs/ms"
        },
        "open": {
          "type": "boolean",
          "default": false,
          "description": "Conexión que siguió abierta (WebSocket)."
        },
        "parentRequestId": {
          "$ref": "#/$defs/requestId",
          "description": "Para frames WS: la conexión que los recibió."
        },
        "passed": {
          "type": "boolean"
        },
        "handler": {
          "$ref": "#/$defs/handlerRef"
        },
        "annotations": {
          "$ref": "#/$defs/annotations"
        },
        "request": {
          "type": "object",
          "required": [
            "headers",
            "body"
          ],
          "additionalProperties": false,
          "properties": {
            "headers": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/header"
              }
            },
            "body": {
              "$ref": "#/$defs/body"
            }
          }
        },
        "response": {
          "type": "object",
          "required": [
            "status",
            "headers",
            "body"
          ],
          "additionalProperties": false,
          "properties": {
            "status": {
              "$ref": "#/$defs/status"
            },
            "headers": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/header"
              }
            },
            "trailers": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/header"
              }
            },
            "body": {
              "$ref": "#/$defs/body"
            },
            "frames": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/frame"
              }
            },
            "sizeBytes": {
              "$ref": "#/$defs/count"
            }
          }
        },
        "assertions": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/assertion"
          }
        },
        "reproduce": {
          "type": "object",
          "required": [
            "tool",
            "command"
          ],
          "additionalProperties": false,
          "properties": {
            "tool": {
              "enum": [
                "curl",
                "grpcurl",
                "websocat",
                "psql",
                "none"
              ]
            },
            "command": {
              "type": "string"
            },
            "env": {
              "type": "array",
              "items": {
                "type": "string"
              },
              "description": "Variables que reemplazan secretos: TOKEN, SERVICE_TOKEN…"
            }
          }
        },
        "evidence": {
          "type": "object",
          "required": [
            "source"
          ],
          "additionalProperties": false,
          "description": "De dónde sale la evidencia del request.",
          "properties": {
            "source": {
              "enum": [
                "proxy",
                "agent",
                "runner"
              ]
            },
            "file": {
              "type": "string",
              "description": "Archivo de evidencia, relativo al reporte (por ejemplo evidence/api.har)."
            },
            "entry": {
              "type": "integer",
              "minimum": 0,
              "description": "Índice de la entrada dentro del archivo."
            }
          }
        }
      }
    },
    "artifact": {
      "type": "object",
      "required": [
        "kind",
        "source",
        "startOffsetMs",
        "durationMs",
        "status"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "enum": [
            "migration",
            "seed",
            "proto",
            "stub",
            "file"
          ]
        },
        "source": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "items": {
          "$ref": "#/$defs/count"
        },
        "startOffsetMs": {
          "$ref": "#/$defs/ms"
        },
        "durationMs": {
          "$ref": "#/$defs/ms"
        },
        "status": {
          "enum": [
            "applied",
            "failed",
            "skipped"
          ]
        }
      }
    },
    "service": {
      "type": "object",
      "required": [
        "name",
        "mode",
        "endpoint",
        "health",
        "requestCount"
      ],
      "properties": {
        "name": {
          "type": "string"
        },
        "mode": {
          "enum": [
            "provisioned",
            "connected"
          ]
        },
        "endpoint": {
          "type": "string"
        },
        "health": {
          "type": "object",
          "required": [
            "check",
            "status",
            "durationMs"
          ],
          "additionalProperties": false,
          "properties": {
            "check": {
              "type": "string"
            },
            "status": {
              "enum": [
                "healthy",
                "unhealthy",
                "timeout"
              ]
            },
            "durationMs": {
              "$ref": "#/$defs/ms"
            }
          }
        },
        "requestCount": {
          "$ref": "#/$defs/count"
        }
      },
      "oneOf": [
        {
          "properties": {
            "name": true,
            "endpoint": true,
            "health": true,
            "requestCount": true,
            "mode": {
              "const": "provisioned"
            },
            "image": {
              "type": "string"
            },
            "build": {
              "type": "object",
              "required": [
                "context"
              ],
              "additionalProperties": false,
              "description": "La imagen se construyó desde un Dockerfile del proyecto. `image` es el nombre que quedó.",
              "properties": {
                "context": {
                  "type": "string"
                },
                "dockerfile": {
                  "type": "string"
                }
              }
            },
            "ports": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "host",
                  "container"
                ],
                "additionalProperties": false,
                "properties": {
                  "host": {
                    "type": "integer"
                  },
                  "container": {
                    "type": "integer"
                  },
                  "protocol": {
                    "type": "string"
                  }
                }
              }
            },
            "env": {
              "type": "array",
              "items": {
                "type": "object",
                "required": [
                  "name",
                  "source"
                ],
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "source": {
                    "enum": [
                      "manifest",
                      "env-file",
                      "inferred",
                      "service-ref"
                    ]
                  },
                  "value": {
                    "type": "string"
                  },
                  "sensitive": {
                    "type": "boolean"
                  },
                  "secretRef": {
                    "type": "string",
                    "pattern": "^sec_[0-9]+$"
                  }
                }
              }
            },
            "dependsOn": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "storage": {
              "enum": [
                "tmpfs",
                "volume",
                "none"
              ]
            },
            "readyMs": {
              "$ref": "#/$defs/ms"
            },
            "artifacts": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/artifact"
              }
            },
            "proxy": {
              "type": "object",
              "required": [
                "image",
                "listen",
                "upstream"
              ],
              "additionalProperties": false,
              "description": "Contenedor proxy que captura la evidencia de los requests hacia este servicio. En un servicio provisionado, solo si habla HTTP.",
              "properties": {
                "engine": {
                  "enum": [
                    "podman",
                    "docker"
                  ],
                  "default": "podman"
                },
                "image": {
                  "type": "string"
                },
                "container": {
                  "type": "string"
                },
                "listen": {
                  "type": "string",
                  "description": "Dirección local a la que se envían los requests, por ejemplo http://localhost:18080."
                },
                "upstream": {
                  "type": "string"
                },
                "evidence": {
                  "type": "string",
                  "description": "Archivo de evidencia que escribe el proxy, relativo al reporte."
                }
              }
            }
          },
          "required": [
            "image",
            "artifacts"
          ],
          "additionalProperties": false
        },
        {
          "properties": {
            "name": true,
            "endpoint": true,
            "health": true,
            "requestCount": true,
            "mode": {
              "const": "connected"
            },
            "host": {
              "type": "string"
            },
            "version": {
              "type": "string"
            },
            "tls": {
              "type": "object",
              "required": [
                "version",
                "validUntil"
              ],
              "additionalProperties": false,
              "properties": {
                "version": {
                  "type": "string"
                },
                "validUntil": {
                  "type": "string",
                  "format": "date"
                }
              }
            },
            "proxy": {
              "type": "object",
              "required": [
                "image",
                "listen",
                "upstream"
              ],
              "additionalProperties": false,
              "description": "Contenedor proxy que captura la evidencia de los requests hacia este servicio.",
              "properties": {
                "engine": {
                  "enum": [
                    "podman",
                    "docker"
                  ],
                  "default": "podman"
                },
                "image": {
                  "type": "string"
                },
                "container": {
                  "type": "string"
                },
                "listen": {
                  "type": "string",
                  "description": "Dirección local a la que se envían los requests, por ejemplo http://localhost:18080."
                },
                "upstream": {
                  "type": "string"
                },
                "evidence": {
                  "type": "string",
                  "description": "Archivo de evidencia que escribe el proxy, relativo al reporte."
                }
              }
            }
          },
          "required": [
            "host"
          ],
          "additionalProperties": false
        }
      ]
    },
    "timelineEvent": {
      "type": "object",
      "required": [
        "kind",
        "label",
        "startOffsetMs",
        "durationMs"
      ],
      "additionalProperties": false,
      "properties": {
        "kind": {
          "enum": [
            "request",
            "service.up",
            "artifact.apply",
            "service.check",
            "build",
            "teardown"
          ]
        },
        "label": {
          "type": "string"
        },
        "ref": {
          "type": [
            "string",
            "integer"
          ],
          "description": "requestId, nombre del servicio o source del artefacto."
        },
        "useCaseId": {
          "$ref": "#/$defs/useCaseId"
        },
        "startOffsetMs": {
          "$ref": "#/$defs/ms"
        },
        "durationMs": {
          "$ref": "#/$defs/ms"
        }
      }
    }
  }
}
```
