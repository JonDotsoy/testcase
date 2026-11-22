---
name: testcase
description: Crea, implementa y depura casos de uso de testmania (manifiesto YAML given/when/then, handlers en TypeScript, anotaciones y reporte JSON). Úsala cuando haya que escribir o corregir pruebas de una suite testmania, o leer un reporte de corrida para explicar un fallo.
---

# testcase

Esta skill guía al agente para escribir y mantener casos de uso de **testmania**. testmania no contiene IA: entrega la estructura (manifiesto, servicios, handlers y reporte) y el agente escribe y corrige las pruebas dentro de ella.

## Cuándo usarla

- La persona pide una prueba nueva para un flujo ("prueba que un cliente no pueda cancelar un pedido ajeno").
- Hay un handler pendiente (generado pero sin implementar) que hay que completar.
- Una corrida falló y hay que explicar por qué o corregir la prueba.
- Hay que leer un reporte `testmania run --report json` y resumirlo.

## Conceptos

| Concepto | Qué es |
|---|---|
| Manifiesto | `testmania.yaml`. Declara la suite, los servicios y los casos de uso. Es declarativo: no lleva comandos, URLs ni credenciales. |
| Caso de uso | Un comportamiento con id `UC-NN`, un título y tres frases: `given`, `when`, `then`. |
| Handler | Archivo TypeScript (`tests/**/<caso>.handler.ts`) que ejecuta el caso: hace los requests y las aserciones. |
| Servicio provisionado | Contenedor que testmania levanta con Podman, con sus artefactos (migraciones, seeds, `.proto`). Se elimina al terminar. |
| Servicio conectado | Servicio que ya existe en un host externo (por ejemplo `api.example.com`). testmania solo verifica que responda. |
| Anotaciones | Pares clave/valor libres que el handler agrega a cada request (`usuario`, `perfil`, `paso`…). Aparecen en el reporte. |
| Reporte | JSON con casos de uso, requests, servicios y línea de tiempo. El schema está en `references/report-schema.md`. |

## Flujo de trabajo

1. **Lee el manifiesto** y los handlers que ya existen. Reutiliza fixtures y helpers antes de crear otros nuevos.
2. **Escribe o ajusta el caso de uso** en el manifiesto. Un caso cubre un solo comportamiento. Escribe `given`, `when` y `then` en lenguaje natural, como lo diría una persona del negocio.
3. **Implementa el handler.** Sigue el orden given → when → then dentro del archivo y anota cada request (ver más abajo).
4. **Corre la suite** con `testmania run --report json`, o solo el caso con el filtro que ofrezca la CLI.
5. **Lee el reporte** empezando por `useCases` (ver [Leer el reporte](#leer-el-reporte)).
6. **Corrige** la prueba o informa el bug, según lo que muestre el reporte. No relajes una aserción para que pase si el comportamiento esperado está escrito en `then`.

## Manifiesto

La sintaxis exacta la define la versión del manifiesto (`version: "1.0"`). Esta es la forma de un caso de uso:

```yaml
version: "1.0"
suite: api-pedidos

services:
  postgres:
    image: postgres:16.4-alpine
    artifacts:
      - migrations: ./db/migrations/*.sql
      - seed: ./db/seeds/usuarios.sql
  api:
    connect: https://api.example.com

cases:
  - id: UC-03
    title: Cliente no puede cancelar un pedido ajeno
    given: un pedido creado por otro cliente
    when: intenta cancelarlo
    then: la API responde 403 y el pedido no cambia
```

Reglas:

- No pongas URLs, tokens ni contraseñas en el manifiesto. Los endpoints salen de `services` y las credenciales salen de `.env` o se infieren para imágenes conocidas.
- Los ids `UC-NN` son estables. No renumeres casos que ya existen.
- Si el caso todavía no tiene handler, déjalo así: el reporte lo mostrará como pendiente.

## Handler

```ts
// tests/pedidos/cancelar-ajeno.handler.ts
export default handler("Cliente no puede cancelar un pedido ajeno", async (ctx) => {
  // given
  const maria = await ctx.fixtures.user("maria.gonzalez@acme.test");
  const pedro = await ctx.fixtures.user("pedro.soto@acme.test");
  const pedido = await ctx.fixtures.order({ owner: maria });

  // when
  const res = await ctx.http.delete(`/v1/orders/${pedido.id}`, {
    auth: pedro.token,
    annotations: {
      usuario: pedro.email,
      perfil: "cliente",
      paso: "when",
      "dueño-del-recurso": maria.email,
    },
  });

  // then
  ctx.expect(res.status).toBe(403);
  const despues = await ctx.http.get(`/v1/orders/${pedido.id}`, {
    auth: maria.token,
    annotations: { usuario: maria.email, perfil: "cliente", paso: "then" },
  });
  ctx.expect(despues.body.status).toBe(pedido.status);
});
```

Clientes disponibles según el protocolo: `ctx.http`, `ctx.grpc`, `ctx.graphql`, `ctx.ws` y `ctx.sql`. Todos aceptan `annotations`.

## Anotaciones

Anota **todos** los requests. Sirven para que una persona entienda el reporte sin leer el código.

| Clave | Cuándo usarla |
|---|---|
| `usuario` | Siempre que el request vaya autenticado. Usa el email o el id de la cuenta. |
| `perfil` | Rol de esa cuenta: `cliente`, `administrador`, `visitante`, `servicio-interno`… |
| `paso` | `given`, `when` o `then`. |
| `tenant` | Si la API es multi-tenant. |
| `nota` | Por qué existe el request, si no es obvio ("reserva mayor al stock"). |
| `intento` | Número de reintento en pruebas de rate limit o reintentos. |
| `fixture` / `tarjeta` | Dato de prueba que se usó. |

Reglas:

- Las claves van en minúsculas (se permiten tildes y ñ), con `-` o `_` en vez de espacios y un máximo de 64 caracteres.
- **Nunca** pongas tokens, contraseñas ni llaves en una anotación. testmania enmascara headers y bodies sensibles, pero no las anotaciones.
- No repitas en las anotaciones datos que el reporte ya trae (caso, handler, run, request-id).

## Errores esperados

Si el comportamiento correcto es un error (403, 401, 429, `FAILED_PRECONDITION`, un `errors` de GraphQL), la aserción lo debe pedir de forma explícita. En el reporte, esa aserción queda con `expectedFailure: true` y el request cuenta como exitoso.

## Leer el reporte

El reporte (`testmania run --report json`) sigue el schema de `references/report-schema.md`. Léelo en este orden:

1. `run.status` y `summary`: cuántos casos fallaron y cuántos están pendientes.
2. `useCases`: para cada caso con `status: "failed"`, lee `failure.explanation`. Es un texto determinista que se arma desde las aserciones.
3. `failure.requestIds` → `requests[]`: revisa `assertions` (`expected` frente a `actual`), `response.status`, `response.body` y `annotations` para saber con qué usuario y perfil se hizo la llamada.
4. Si el fallo parece de infraestructura, revisa `services[].health` y los `artifacts` con `status` distinto de `applied`.

Al explicar un fallo a la persona:

- Nombra el caso de uso por su título y su id.
- Di qué se esperaba y qué llegó, con los valores del reporte.
- Di si es un bug del servicio o un error de la prueba, y con qué evidencia.
- Cita las URLs tal cual aparecen en el reporte (`/v1/orders/ord_01JD3K8Q2Z7W4M`). No las conviertas en templates como `/v1/orders/{id}`.

## Qué no hacer

- No desactives, saltes ni borres una prueba para que la suite pase.
- No cambies `then` para que calce con lo que hace el servicio sin confirmarlo con la persona.
- No pidas ni imprimas secretos. Si necesitas reproducir un request, usa `reproduce.command` del reporte, que usa variables de entorno (`$TOKEN`).
