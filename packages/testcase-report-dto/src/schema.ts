/**
 * Esquema del reporte de testcase (reportVersion "1.0") en zod.
 *
 * Es la misma estructura que documenta references/report-schema.md (y su JSON Schema 2020-12), con los mismos
 * campos obligatorios, enums, patrones y reglas condicionales. Los objetos son estrictos: un campo que el esquema no
 * conoce es un error, igual que `additionalProperties: false`. Los valores por defecto del JSON Schema
 * (`secretsIncluded: false`, `open: false`…) no se agregan al parsear: el reporte sale tal cual entró.
 */
import { z } from "zod";

// ---------- primitivos ----------

/** Milisegundos (duración u offset desde el inicio de la corrida). */
export const msSchema = z.number().min(0);
/** Conteo entero no negativo. */
export const countSchema = z.number().int().min(0);
export const protocolSchema = z.enum(["http", "grpc", "graphql", "ws", "sql"]);
export const useCaseIdSchema = z.string().regex(/^UC-[0-9]{2,}$/);
export const requestIdSchema = z.number().int().min(1);
export const secretRefSchema = z.string().regex(/^sec_[0-9]+$/);
const dateTime = z.iso.datetime({ offset: true });

export const handlerRefSchema = z.strictObject({
  /** Archivo del handler, o "agente" cuando el agente ejecutó el request directamente. */
  file: z.string(),
  line: z.number().int().min(1).optional(),
});

/** Pares clave/valor libres definidos por el desarrollador. testcase no los interpreta. */
export const annotationsSchema = z.record(
  z.string().max(64).regex(/^[a-z0-9áéíóúñü][a-z0-9áéíóúñü _-]*$/),
  z.union([z.string(), z.number(), z.boolean()]),
);

// ---------- request / response ----------

export const headerSchema = z
  .strictObject({
    name: z.string(),
    value: z.string().nullable(),
    sensitive: z.boolean().optional(),
    secretRef: secretRefSchema.optional(),
  })
  .refine((h) => h.sensitive !== true || h.secretRef !== undefined, { message: "un header sensible necesita secretRef", path: ["secretRef"] });

export const redactionSchema = z.strictObject({
  /** JSONPath dentro de body.value, p. ej. $.password */
  path: z.string(),
  secretRef: secretRefSchema,
});

export const bodySchema = z.strictObject({
  encoding: z.enum(["none", "json", "text", "protobuf-json", "graphql", "sql"]),
  contentType: z.string().optional(),
  value: z.unknown(),
  sizeBytes: countSchema.optional(),
  truncated: z.boolean().optional(),
  redactions: z.array(redactionSchema).optional(),
});

export const frameSchema = z.strictObject({
  direction: z.enum(["in", "out"]),
  offsetMs: msSchema,
  opcode: z.enum(["text", "binary", "ping", "pong", "close"]),
  data: z.unknown(),
});

/** Estado de la respuesta según el protocolo. Todos llevan `label`, el texto listo para mostrar. */
export const statusSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("http"), label: z.string(), code: z.number().int().min(100).max(599), reason: z.string().optional() }),
  z.strictObject({ kind: z.literal("grpc"), label: z.string(), code: z.number().int().min(0).max(16), name: z.string(), message: z.string().optional() }),
  z.strictObject({ kind: z.literal("graphql"), label: z.string(), httpCode: z.number().int(), hasData: z.boolean(), errorCount: countSchema }),
  z.strictObject({ kind: z.literal("ws"), label: z.string(), event: z.enum(["handshake", "frame", "close"]), httpCode: z.number().int().optional(), closeCode: z.number().int().optional() }),
  z.strictObject({ kind: z.literal("sql"), label: z.string(), command: z.string(), rowCount: countSchema }),
]);

export const assertionSchema = z.strictObject({
  id: z.string(),
  expression: z.string(),
  passed: z.boolean(),
  /** La prueba esperaba un estado de error (403, 429, FAILED_PRECONDITION…). */
  expectedFailure: z.boolean().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});

export const requestSchema = z.strictObject({
  id: requestIdSchema,
  useCaseId: useCaseIdSchema,
  protocol: protocolSchema,
  /** Detalle legible: HTTP/1.1, HTTP/2 unary, events.v1… */
  transport: z.string().optional(),
  /** Verbo HTTP, método gRPC, QUERY/MUTATION, CONNECT/MESSAGE o comando SQL. */
  method: z.string(),
  /** Ruta, método completo gRPC, operationName o sentencia resumida, tal cual se invocó. */
  target: z.string(),
  url: z.string(),
  services: z.array(z.string()).min(1),
  startOffsetMs: msSchema,
  durationMs: msSchema,
  /** Conexión que siguió abierta (WebSocket). */
  open: z.boolean().optional(),
  /** Para frames WS: la conexión que los recibió. */
  parentRequestId: requestIdSchema.optional(),
  passed: z.boolean(),
  handler: handlerRefSchema,
  annotations: annotationsSchema,
  request: z.strictObject({ headers: z.array(headerSchema), body: bodySchema }),
  response: z.strictObject({
    status: statusSchema,
    headers: z.array(headerSchema),
    trailers: z.array(headerSchema).optional(),
    body: bodySchema,
    frames: z.array(frameSchema).optional(),
    sizeBytes: countSchema.optional(),
  }),
  assertions: z.array(assertionSchema),
  reproduce: z
    .strictObject({
      tool: z.enum(["curl", "grpcurl", "websocat", "psql", "none"]),
      command: z.string(),
      /** Variables que reemplazan secretos: TOKEN, SERVICE_TOKEN… */
      env: z.array(z.string()).optional(),
    })
    .optional(),
  /** De dónde sale la evidencia del request. */
  evidence: z
    .strictObject({
      source: z.enum(["proxy", "agent", "runner"]),
      /** Archivo de evidencia, relativo al reporte (por ejemplo evidence/api.har). */
      file: z.string().optional(),
      /** Índice de la entrada dentro del archivo. */
      entry: z.number().int().min(0).optional(),
    })
    .optional(),
});

// ---------- casos de uso ----------

export const pasoSchema = z.enum(["given", "when", "then"]);
export const useCaseStatusSchema = z.enum(["passed", "failed", "pending", "running"]);

export const useCaseSchema = z
  .strictObject({
    id: useCaseIdSchema,
    title: z.string(),
    /** Descripción del caso (describe() en el script). */
    description: z.string().optional(),
    /** Pasos declarados con given.skip(), when.skip() o then.skip(): están en el caso pero no se ejecutaron. */
    skippedSteps: z.array(z.strictObject({ paso: pasoSchema, description: z.string() })).optional(),
    /** `running`: el caso se estaba ejecutando cuando se escribió el reporte. */
    status: useCaseStatusSchema,
    running: z.strictObject({ message: z.string().optional() }).optional(),
    given: z.string(),
    when: z.string(),
    then: z.string(),
    handler: handlerRefSchema,
    startOffsetMs: msSchema.optional(),
    durationMs: msSchema.optional(),
    requestIds: z.array(requestIdSchema),
    /** Inventario de URLs y métodos invocados tal cual, sin templates. Se agrupan solo llamadas idénticas. */
    invocations: z.array(z.strictObject({ protocol: protocolSchema, method: z.string(), target: z.string(), count: z.number().int().min(1) })),
    failure: z
      .strictObject({
        /** Texto determinista generado desde las aserciones, sin IA. */
        explanation: z.string(),
        requestIds: z.array(requestIdSchema).min(1),
        assertionIds: z.array(z.string()).min(1),
      })
      .optional(),
    pending: z.strictObject({ reason: z.enum(["handler-not-implemented", "skipped"]), message: z.string().optional() }).optional(),
  })
  .superRefine((u, ctx) => {
    if (u.status === "failed" && !u.failure) ctx.addIssue({ code: "custom", message: "un caso failed necesita failure", path: ["failure"] });
    if (u.status === "pending" && !u.pending) ctx.addIssue({ code: "custom", message: "un caso pending necesita pending", path: ["pending"] });
  });

// ---------- servicios ----------

/** Proxy que captura la evidencia: un contenedor (podman o docker, con image) o un proceso local (engine local). */
export const proxySchema = z
  .strictObject({
    engine: z.enum(["podman", "docker", "local"]).optional(),
    /** Imagen del contenedor proxy. No aplica con engine local. */
    image: z.string().optional(),
    container: z.string().optional(),
    /** PID del proxy local mientras corre. */
    pid: z.number().int().optional(),
    /** Dirección local a la que se envían los requests, por ejemplo http://localhost:18080. */
    listen: z.string(),
    upstream: z.string(),
    /** Archivo de evidencia que escribe el proxy, relativo al reporte. */
    evidence: z.string().optional(),
    /** El proxy no verifica el certificado del upstream https (certificado propio de un servicio local). */
    insecure: z.literal(true).optional(),
    /** CA adicional en PEM, relativa a la raíz del proyecto, en la que confía el proxy al verificar el upstream. */
    ca: z.string().optional(),
  })
  .refine((p) => p.engine === "local" || p.image !== undefined, { message: "un proxy en contenedor (podman o docker) necesita image", path: ["image"] });

export const artifactSchema = z.strictObject({
  kind: z.enum(["migration", "seed", "proto", "stub", "file"]),
  source: z.string(),
  description: z.string().optional(),
  items: countSchema.optional(),
  startOffsetMs: msSchema,
  durationMs: msSchema,
  status: z.enum(["applied", "failed", "skipped"]),
});

export const healthSchema = z.strictObject({
  check: z.string(),
  status: z.enum(["healthy", "unhealthy", "timeout"]),
  durationMs: msSchema,
});

export const serviceEnvSchema = z.strictObject({
  name: z.string(),
  source: z.enum(["manifest", "env-file", "inferred", "service-ref"]),
  value: z.string().optional(),
  sensitive: z.boolean().optional(),
  secretRef: secretRefSchema.optional(),
  /** Variable del entorno de la que sale el valor (fromEnv en defineService). */
  fromEnv: z.string().optional(),
  /** Archivo .env del que sale el valor (fromEnvFile en defineService), relativo a la raíz del proyecto. */
  envFile: z.string().optional(),
});

const serviceBase = {
  name: z.string(),
  endpoint: z.string(),
  health: healthSchema,
  requestCount: countSchema,
};

/** Servicio que testcase levanta como contenedor. */
export const provisionedServiceSchema = z.strictObject({
  ...serviceBase,
  mode: z.literal("provisioned"),
  image: z.string(),
  /** La imagen se construyó desde un Dockerfile del proyecto. `image` es el nombre que quedó. */
  build: z.strictObject({ context: z.string(), dockerfile: z.string().optional() }).optional(),
  ports: z.array(z.strictObject({ host: z.number().int(), container: z.number().int(), protocol: z.string().optional() })).optional(),
  env: z.array(serviceEnvSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  storage: z.enum(["tmpfs", "volume", "none"]).optional(),
  readyMs: msSchema.optional(),
  artifacts: z.array(artifactSchema),
  proxy: proxySchema.optional(),
});

/** Servicio que ya existe en un host externo: testcase solo verifica que responda. */
export const connectedServiceSchema = z.strictObject({
  ...serviceBase,
  mode: z.literal("connected"),
  host: z.string(),
  version: z.string().optional(),
  tls: z.strictObject({ version: z.string(), validUntil: z.iso.date() }).optional(),
  proxy: proxySchema.optional(),
});

/** Servicio que corre como proceso local (comando de shell). */
export const processServiceSchema = z.strictObject({
  ...serviceBase,
  mode: z.literal("process"),
  /** Comando de shell que levanta el servicio. */
  command: z.string(),
  /** Carpeta donde corre el comando, relativa a la raíz del proyecto. */
  cwd: z.string().optional(),
  /** Puerto local donde escucha el proceso. */
  port: z.number().int().optional(),
  env: z.array(serviceEnvSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
  readyMs: msSchema.optional(),
  artifacts: z.array(artifactSchema).optional(),
  /** Proceso que levantó el runner. */
  process: z
    .strictObject({
      pid: z.number().int(),
      startedAt: dateTime,
      stoppedAt: dateTime.optional(),
      exitCode: z.number().int().nullable().optional(),
      signal: z.string().nullable().optional(),
      /** Salida del proceso, relativa al reporte. */
      log: z.string().optional(),
    })
    .optional(),
  proxy: proxySchema.optional(),
});

export const serviceSchema = z.discriminatedUnion("mode", [provisionedServiceSchema, connectedServiceSchema, processServiceSchema]);

// ---------- línea de tiempo ----------

export const timelineEventSchema = z.strictObject({
  kind: z.enum(["request", "service.up", "artifact.apply", "service.check", "build", "teardown"]),
  label: z.string(),
  /** requestId, nombre del servicio o source del artefacto. */
  ref: z.union([z.string(), z.number().int()]).optional(),
  useCaseId: useCaseIdSchema.optional(),
  startOffsetMs: msSchema,
  durationMs: msSchema,
});

// ---------- reporte ----------

export const summarySchema = z.strictObject({
  useCases: z.strictObject({ total: countSchema, passed: countSchema, failed: countSchema, pending: countSchema, running: countSchema.optional() }),
  requests: z.strictObject({ total: countSchema, byProtocol: z.partialRecord(protocolSchema, countSchema) }),
  assertions: z.strictObject({ total: countSchema, passed: countSchema, failed: countSchema }),
  phases: z.strictObject({ provisioningMs: msSchema, buildMs: msSchema, testsMs: msSchema, teardownMs: msSchema }),
});

export const runSchema = z.strictObject({
  id: z.string().regex(/^run_[0-9]+$/),
  number: z.number().int().min(1),
  command: z.string(),
  mode: z.literal("local"),
  status: z.enum(["passed", "failed", "error"]),
  exitCode: z.number().int(),
  startedAt: dateTime,
  finishedAt: dateTime,
  durationMs: msSchema,
  secretsIncluded: z.boolean().optional(),
  runtime: z.strictObject({ engine: z.literal("podman"), version: z.string() }),
});

export const manifestSchema = z.strictObject({
  path: z.string(),
  version: z.string(),
  suite: z.string(),
  envFiles: z.array(z.string()).optional(),
});

export const REPORT_VERSION = "1.0" as const;

export const reportSchema = z.strictObject({
  $schema: z.url(),
  reportVersion: z.literal(REPORT_VERSION),
  tool: z.strictObject({ name: z.literal("testmania"), version: z.string() }),
  run: runSchema,
  manifest: manifestSchema,
  summary: summarySchema,
  useCases: z.array(useCaseSchema),
  requests: z.array(requestSchema),
  services: z.array(serviceSchema),
  timeline: z.array(timelineEventSchema),
  /** Mapa secretRef → valor real. Se omite en las copias para compartir (--strip-secrets). */
  secrets: z.record(secretRefSchema, z.string()).optional(),
});

// ---------- tipos ----------

export type Protocol = z.infer<typeof protocolSchema>;
export type HandlerRef = z.infer<typeof handlerRefSchema>;
export type Annotations = z.infer<typeof annotationsSchema>;
export type Header = z.infer<typeof headerSchema>;
export type Redaction = z.infer<typeof redactionSchema>;
export type Body = z.infer<typeof bodySchema>;
export type Frame = z.infer<typeof frameSchema>;
export type Status = z.infer<typeof statusSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type Request = z.infer<typeof requestSchema>;
export type UseCaseStatus = z.infer<typeof useCaseStatusSchema>;
export type UseCase = z.infer<typeof useCaseSchema>;
export type Proxy = z.infer<typeof proxySchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Health = z.infer<typeof healthSchema>;
export type ServiceEnv = z.infer<typeof serviceEnvSchema>;
export type ProvisionedService = z.infer<typeof provisionedServiceSchema>;
export type ConnectedService = z.infer<typeof connectedServiceSchema>;
export type ProcessService = z.infer<typeof processServiceSchema>;
export type Service = z.infer<typeof serviceSchema>;
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type Run = z.infer<typeof runSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Report = z.infer<typeof reportSchema>;
