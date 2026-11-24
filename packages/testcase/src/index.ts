/**
 * @jondotsoy/testcase: API de los casos de uso (`*.case.ts`).
 *
 *   import { defineCase, defineService, title, given, when, then, check } from "@jondotsoy/testcase";
 *
 *   const api = await defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });
 *
 *   await defineCase(async () => {
 *     await title("Cliente no puede cancelar un pedido ajeno");
 *     const res = await when("Pedro intenta cancelar el pedido de María", () => api.http.delete("/v1/orders/ord_01JD9"));
 *     await then("la API responde 403", () => check("status == 403", res.status(), 403, { expectedFailure: true }));
 *   });
 *
 * Lo que usa el runner para cargar y correr los casos está en `@jondotsoy/testcase/runner`.
 */
export {
  // Casos y pasos
  defineCase,
  title,
  describe,
  id,
  given,
  when,
  then,
  // Servicios
  defineService,
  fromEnv,
  fromEnvFile,
  // Utilidades dentro de los pasos
  sensitive,
  notation,
  vars,
  page,
  check,
  ensure,
  satisfies,
  instanceOf,
  between,
  Cookies,
  withCookies,
} from "./testcase.ts";

export type {
  Annotations,
  Api,
  ArtifactDefinition,
  BuildDefinition,
  CaseContext,
  CaseDefinition,
  CaseStep,
  CheckOptions,
  ConnectedServiceDefinition,
  CookiesInit,
  FromEnv,
  GraphQL,
  GraphQLError,
  GraphQLOptions,
  GraphQLResponse,
  NotationOptions,
  Paso,
  ProcessServiceDefinition,
  ProvisionedServiceDefinition,
  RequestOptions,
  Service,
  ServiceDefinition,
  StepFn,
  Text,
  TlsDefinition,
  TrackedResponse,
  Validator,
} from "./testcase.ts";
