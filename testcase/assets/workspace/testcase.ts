/**
 * testcase.ts
 *
 * Librería de casos de uso. Cada caso es un script autocontenido en `cases/UC-NN.case.ts`: importa todo lo que
 * necesita desde aquí y declara los servicios que usa con `defineService`.
 *
 *   import { defineCase, defineService, title, given, when, then, check } from "../testcase.ts";
 *
 *   const api = await defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });
 *
 *   await defineCase(async () => {
 *     await title("Cliente no puede cancelar un pedido ajeno");
 *     const login = await given("Pedro inicia sesión", async () => api.post("/v1/auth/token", { data: { … } }));
 *     const res = await when("Pedro intenta cancelar el pedido de María", async () => api.delete("/v1/orders/ord_01JD9"));
 *     await then("la API responde 403", () => check("status == 403", res.status(), 403, { expectedFailure: true }));
 *   });
 *
 * Todo se usa con await: defineCase, title, describe, id, given, when y then. Al cargar el archivo, defineCase recorre su función
 * sin ejecutar los pasos para registrar el título y los pasos. Al correr el caso la ejecuta de nuevo: cada paso corre
 * en orden y `await given(…)` devuelve lo que devuelve su función. Dentro de un paso se usan las utilidades importadas
 * (`check`, `ensure`, `notation`, `page`, `vars`) y los métodos de sus servicios.
 * El id sale del nombre del archivo (`UC-03.case.ts` → `UC-03`) o de `id("UC-03")`.
 *
 * Cada request (de un servicio, de `t.api()` o del navegador de `page()`) pasa por el proxy de evidencia
 * y lleva headers `x-testcase-*` para que `import-har.ts` lo asocie al caso, a su paso, a sus anotaciones y a sus aserciones.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { APIRequestContext, APIResponse, Browser, BrowserContext, Page } from "playwright";

export type Paso = "given" | "when" | "then";
export type Annotations = Record<string, string | number | boolean>;

export interface RequestOptions {
  headers?: Record<string, string>;
  /**
   * Cookies del request: `{ cookies: { "my-cookie": "true" } }` envía `Cookie: my-cookie=true`.
   * También acepta las `cookies` de una respuesta anterior, para reenviarlas: `{ cookies: login.cookies }`.
   * Dentro de un caso, Playwright ya reenvía al mismo servicio las cookies que este fijó; con `cookies`, el header
   * Cookie lleva exactamente lo que se pasa y reemplaza esas cookies automáticas.
   * Los caracteres que no van en una cookie (espacios, `;`, comas, comillas, no ASCII) se codifican.
   * Se suman a un header `cookie` que ya venga en `headers`. En el reporte el header queda oculto como los demás valores sensibles.
   */
  cookies?: CookiesInit;
  /** Body JSON. */
  data?: unknown;
  /** Body de formulario. */
  form?: Record<string, string | number | boolean>;
  params?: Record<string, string | number | boolean>;
  /** Anotaciones solo para este request. Se suman a las del paso actual. */
  annotations?: Annotations;
  timeout?: number;
}

export interface TrackedResponse {
  /** Etiqueta del request en la evidencia (header x-testcase-request). */
  readonly tag: string;
  readonly raw: APIResponse;
  /** Body de la respuesta, ya leído: el JSON parseado si es JSON, el texto si no, `undefined` si viene vacío. */
  readonly body: any;
  /**
   * Cookies después de este request: las que se enviaron más las que fijó la respuesta (Set-Cookie),
   * sin las que la respuesta borró. Se reenvían con `{ cookies: res.cookies }`, también a otro servicio.
   */
  readonly cookies: Cookies;
  status(): number;
  headers(): Record<string, string>;
  json<T = any>(): Promise<T>;
  text(): Promise<string>;
}

export interface Api {
  get(path: string, opts?: RequestOptions): Promise<TrackedResponse>;
  post(path: string, opts?: RequestOptions): Promise<TrackedResponse>;
  put(path: string, opts?: RequestOptions): Promise<TrackedResponse>;
  patch(path: string, opts?: RequestOptions): Promise<TrackedResponse>;
  delete(path: string, opts?: RequestOptions): Promise<TrackedResponse>;
  fetch(path: string, opts?: RequestOptions & { method?: string }): Promise<TrackedResponse>;
}

export interface CheckOptions {
  /** Request al que pertenece la aserción. Si se omite: el último request del paso actual, o del caso si el paso no hizo ninguno. */
  response?: TrackedResponse;
  /** La prueba espera un error (403, 429…). Se marca en el reporte. */
  expectedFailure?: boolean;
}

export interface CaseContext {
  /** Cliente HTTP (Playwright APIRequestContext) hacia un servicio del reporte, a través de su proxy. */
  api(service: string): Api;
  /** Página de Playwright. Sus requests llevan las etiquetas del caso y del paso actual. */
  page(): Promise<Page>;
  /** URL de un servicio a través de su proxy, para usar con `page.goto()`. */
  url(service: string, path?: string): string;
  /** Marca el inicio de un paso (given, when, then) y sus anotaciones. */
  step(paso: Paso, annotations?: Annotations): Promise<void>;
  /** Define una anotación y devuelve el valor. Ver `notation()`. */
  notation<T>(name: string, value: T, opts?: NotationOptions): T;
  /** Registra una aserción. Devuelve si pasó. No lanza: el caso sigue corriendo. El esperado puede ser un validador. */
  check(expression: string, actual: unknown, expected: unknown, opts?: CheckOptions): boolean;
  /** Igual que `check`, pero detiene el caso si falla. */
  require(expression: string, actual: unknown, expected: unknown, opts?: CheckOptions): void;
  /** Guarda un dato entre pasos (ids creados, tokens…). */
  readonly vars: Record<string, any>;
}

/* ---------- sintaxis await defineCase(async () => { await title(); await given(); … }) ---------- */

/** Función de un paso. Recibe el contexto del caso. Lo que devuelve es el valor de `await given(…)`. */
export type StepFn<T = unknown> = (t: CaseContext) => T | Promise<T>;
/** Texto de title(), describe(), id() y los pasos: un string, una promesa de string o una función que devuelve cualquiera de los dos. */
export type Text = string | Promise<string> | (() => string | Promise<string>);

export interface CaseStep {
  paso: Paso;
  description: string;
}

/** Caso declarado con `defineCase(async () => { … })`. `run.ts` completa el id con el nombre del archivo si falta. */
export interface CaseDefinition {
  /** Id estable del caso: UC-01, UC-02… */
  id: string;
  title: string;
  /** Descripción del caso, más larga que el título: contexto, reglas de negocio, por qué importa. */
  description?: string;
  given: string;
  when: string;
  then: string;
  /** Anotaciones que llevan todos los requests del caso (por ejemplo `tenant`). */
  annotations?: Annotations;
  /** Pasos en el orden en que aparecen. */
  steps: CaseStep[];
  /** Corre el caso: ejecuta la función de defineCase con los pasos de verdad. */
  run(t: CaseContext): Promise<void>;
}

interface Draft {
  id?: string;
  title?: string;
  description?: string;
  annotations: Annotations;
  steps: CaseStep[];
  /** Textos de pasos que todavía se resuelven (promesas de string). */
  pending: Promise<unknown>[];
  /** `vars` mientras se registran los pasos. */
  vars: Record<string, any>;
}

/** Corrida del cuerpo de un caso: el contexto y el paso que está en curso, si hay uno. */
interface Running {
  t: CaseContext;
  step?: string;
}

/** Registro: defineCase recorre su función sin ejecutar los pasos, para saber el título y los pasos antes de correr. */
const collecting = new AsyncLocalStorage<Draft>();
const running = new AsyncLocalStorage<Running>();
/** Paso cuya función está corriendo en este contexto async (para detectar pasos anidados). */
const inStep = new AsyncLocalStorage<string>();

/**
 * Valor que devuelve `await given(…)` mientras se registran los pasos: acepta cualquier propiedad o llamada
 * (`login.body.access_token`, `res.status()`) para que el código entre pasos no falle sin datos reales.
 */
const placeholder: any = new Proxy(function () {}, {
  get: (_, k) => (k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : k === Symbol.iterator ? function* () {} : placeholder),
  apply: () => placeholder,
  construct: () => placeholder,
  set: () => true,
});

const text = async (v: Text, fn: string): Promise<string> => {
  const s = await (typeof v === "function" ? v() : v);
  if (typeof s !== "string" || !s.trim()) throw new Error(`${fn}() necesita un texto no vacío.`);
  return s.trim();
};

const definedCases: CaseDefinition[] = [];
const pendingCases: Promise<unknown>[] = [];

/**
 * Casos definidos desde la última llamada, en orden. Lo usa run.ts después de importar cada archivo.
 * Espera a los defineCase y defineService que el archivo no esperó con await, y falla si alguno falló.
 */
export async function takeDefinedCases(): Promise<CaseDefinition[]> {
  const pending = pendingCases.splice(0);
  await Promise.all(pending);
  return definedCases.splice(0);
}

/**
 * Define un caso de uso. Se usa con await, igual que title(), id(), given(), when() y then():
 *
 *   await defineCase(async () => {
 *     await title("Cliente no puede cancelar un pedido ajeno");
 *     const login = await given("Pedro inicia sesión", async () => api.post("/v1/auth/token", { data }));
 *     const res = await when("Pedro intenta cancelar el pedido de María", async () => api.delete(…));
 *     await then("la API responde 403", () => check("status == 403", res.status(), 403));
 *   });
 *
 * Al cargar el archivo, defineCase recorre la función sin ejecutar los pasos para registrar el título y los pasos
 * (cada `await given(…)` devuelve un valor vacío). Al correr el caso, la vuelve a ejecutar y cada paso corre en orden,
 * y devuelve lo que devuelve su función. Un archivo puede definir varios casos; cada uno declara su id("UC-NN").
 */
export function defineCase(body: () => unknown | Promise<unknown>): Promise<CaseDefinition> {
  if (collecting.getStore() || running.getStore()) throw new Error("defineCase() no se puede anidar.");
  if (typeof body !== "function") throw new Error("defineCase() necesita una función.");
  const d: Draft = { annotations: {}, steps: [], pending: [], vars: {} };
  const p = collecting.run(d, async () => {
    await body();
    await Promise.all(d.pending); // pasos sin await y textos que eran promesas
    if (!d.title) throw new Error("Falta title() en defineCase().");
    for (const paso of ["given", "when", "then"] as const) {
      if (!d.steps.some((s) => s.paso === paso)) throw new Error(`"${d.title}": falta al menos un ${paso}().`);
    }
    const join = (paso: Paso) => d.steps.filter((s) => s.paso === paso).map((s) => s.description).join(" y ");
    const def: CaseDefinition = {
      id: d.id ?? "",
      title: d.title,
      ...(d.description ? { description: d.description } : {}),
      given: join("given"),
      when: join("when"),
      then: join("then"),
      annotations: Object.keys(d.annotations).length ? d.annotations : undefined,
      steps: d.steps,
      async run(t) {
        const r: Running = { t };
        await running.run(r, async () => {
          await body();
          if (r.step) throw new Error(`Falta await antes de ${r.step}: el caso terminó con el paso todavía corriendo.`);
        });
      },
    };
    definedCases.push(def);
    return def;
  });
  p.catch(() => {}); // run.ts lo informa desde takeDefinedCases(), aunque el archivo no use await
  pendingCases.push(p);
  return p;
}

function draftOrRun(fn: string): { d?: Draft; r?: Running } {
  const d = collecting.getStore();
  const r = running.getStore();
  if (!d && !r) throw new Error(`${fn}() solo se usa dentro de defineCase(async () => { … }).`);
  const nested = inStep.getStore();
  if (nested) throw new Error(`${fn}() no se usa dentro de un paso (${nested}).`);
  if (r?.step) throw new Error(`Falta await antes de ${r.step}: ${fn}() empezó con el paso anterior todavía corriendo.`);
  return { d, r };
}

/** Título del caso, en palabras de la persona. Acepta un texto, una promesa de texto o una función que devuelve cualquiera de los dos. */
export async function title(value: Text): Promise<void> {
  const { d } = draftOrRun("title");
  if (!d) return;
  if (d.title) throw new Error("title() se declara una sola vez por caso.");
  d.title = await text(value, "title");
}

/**
 * Descripción del caso, más larga que el título: el contexto, la regla de negocio o por qué importa.
 * Opcional, una vez por caso. Acepta un texto, una promesa de texto o una función que devuelve cualquiera de los dos.
 * Aparece en el reporte bajo el título.
 */
export async function describe(value: Text): Promise<void> {
  const { d } = draftOrRun("describe");
  if (!d) return;
  if (d.description) throw new Error("describe() se declara una sola vez por caso.");
  d.description = await text(value, "describe");
}

/** Id del caso (UC-NN). Opcional: por defecto sale del nombre del archivo. */
export async function id(value: Text): Promise<void> {
  const { d } = draftOrRun("id");
  if (d) d.id = await text(value, "id");
}

function runStep<T>(paso: Paso, description: Text, fn?: StepFn<T>): Promise<T> {
  if (fn !== undefined && typeof fn !== "function") throw new Error(`${paso}(): el segundo argumento debe ser una función.`);
  // El texto puede ser una promesa: para los errores inmediatos se usa el texto si ya es un string
  const quick = typeof description === "string" ? description.trim() : "…";
  const r0 = running.getStore();
  // Se revisa antes de devolver la promesa: un paso sin await deja el anterior en curso
  if (r0?.step && !inStep.getStore()) throw new Error(`Falta await antes de ${r0.step}: ${paso}("${quick}") empezó con el paso anterior todavía corriendo.`);
  const { d, r } = draftOrRun(paso);
  if (d) {
    // El lugar del paso se reserva ya, para conservar el orden aunque el texto sea una promesa
    const step: CaseStep = { paso, description: quick };
    d.steps.push(step);
    const p = text(description, paso).then((desc) => ((step.description = desc), placeholder as T));
    d.pending.push(p);
    p.catch(() => {}); // defineCase lo informa
    return p;
  }
  r!.step = `${paso}("${quick}")`; // marca el paso en curso ya, antes de resolver el texto
  const p = (async () => {
    try {
      const desc = await text(description, paso);
      const label = `${paso}("${desc}")`;
      r!.step = label;
      const t = r!.t;
      await t.step(paso);
      return fn ? await inStep.run(label, () => active.run(t, () => fn(t))) : (undefined as T);
    } finally {
      r!.step = undefined;
    }
  })();
  p.catch(() => {}); // si falta el await, el error que importa es el de "Falta await"
  return p;
}

/** Paso given: prepara el estado. Se usa con await y devuelve lo que devuelve su función. */
export function given<T = void>(description: Text, fn?: StepFn<T>): Promise<T> {
  return runStep("given", description, fn);
}

/** Paso when: la acción que se prueba. Se usa con await y devuelve lo que devuelve su función. */
export function when<T = void>(description: Text, fn?: StepFn<T>): Promise<T> {
  return runStep("when", description, fn);
}

/** Paso then: lo que se verifica. Se usa con await y devuelve lo que devuelve su función. */
export function then<T = void>(description: Text, fn?: StepFn<T>): Promise<T> {
  return runStep("then", description, fn);
}

/* ---------- servicios: defineService ---------- */

/** Variable de entorno con un secreto. En el reporte queda enmascarada. */
export interface FromEnv {
  fromEnv: string;
}
/** Lee el valor de una variable de entorno del host al levantar el servicio. Se marca como sensible. */
export function fromEnv(name: string): FromEnv {
  sensitive(process.env[name]);
  return { fromEnv: name };
}

export interface ArtifactDefinition {
  kind: "migration" | "seed" | "proto" | "stub" | "file";
  source: string;
  description?: string;
}

interface ServiceBase {
  /** Nombre del servicio en el reporte. */
  name: string;
  /** Healthcheck que corre el agente (por ejemplo `GET /healthz` o `pg_isready`). */
  health?: string;
}

/** Servicio que ya existe (por ejemplo `https://api.example.com`). No se levanta ni se le cargan datos. */
export interface ConnectedServiceDefinition extends ServiceBase {
  endpoint: string;
  version?: string;
}

/** Cómo construir la imagen. Un texto es el contexto; las rutas son relativas a la raíz del proyecto. */
export type BuildDefinition = string | { context: string; dockerfile?: string; args?: Record<string, string>; target?: string };

/**
 * Contenedor que se levanta con Podman, con sus artefactos (migraciones, seeds…).
 * Lleva `image`, `build` o los dos (la imagen construida queda con ese nombre). `run.ts --plan` lo escribe en compose.yaml.
 */
export interface ProvisionedServiceDefinition extends ServiceBase {
  /** Imagen con su tag, por ejemplo `docker.io/library/postgres:16.4-alpine`. */
  image?: string;
  /** Construye la imagen desde un Dockerfile del proyecto. */
  build?: BuildDefinition;
  /** Comando del contenedor, si no es el de la imagen. */
  command?: string | string[];
  /** Puertos del contenedor. Sin `host`, se asigna uno libre desde 55000. */
  ports?: Array<{ container: number; host?: number; protocol?: string }>;
  env?: Record<string, string | FromEnv>;
  dependsOn?: Array<string | Service>;
  storage?: "tmpfs" | "volume" | "none";
  /** Rutas del contenedor montadas en memoria, por ejemplo `/var/lib/postgresql/data`. Implica `storage: "tmpfs"`. */
  tmpfs?: string[];
  artifacts?: ArtifactDefinition[];
  /** El servicio habla HTTP: sus requests pasan por el proxy de evidencia. Por defecto false. */
  http?: boolean;
}

/**
 * Proceso local: un comando de shell que levanta el servicio en esta máquina, sin contenedor.
 * `scripts/local.ts up` lo corre en `cwd`, guarda su PID en el reporte y su salida en `.testcase/logs/<name>.log`.
 */
export interface ProcessServiceDefinition extends ServiceBase {
  /** Comando de shell, por ejemplo `bun run dev`. */
  command: string;
  /** Carpeta donde corre, relativa a la raíz del proyecto. Por defecto, la raíz. */
  cwd?: string;
  /** Puerto local donde escucha. Con puerto, el servicio habla HTTP y tiene proxy de evidencia (local). */
  port?: number;
  env?: Record<string, string | FromEnv>;
  dependsOn?: Array<string | Service>;
  artifacts?: ArtifactDefinition[];
  /** Por defecto true si declara `port`. */
  http?: boolean;
}

export type ServiceDefinition = ConnectedServiceDefinition | ProvisionedServiceDefinition | ProcessServiceDefinition;

/** Tipo de servicio según su definición: endpoint → connected, image/build → provisioned, command solo → process. */
export function serviceKind(def: ServiceDefinition): "connected" | "provisioned" | "process" {
  if ("endpoint" in def && def.endpoint) return "connected";
  if (("image" in def && def.image) || ("build" in def && def.build)) return "provisioned";
  return "process";
}

/** El servicio habla HTTP: tiene proxy de evidencia y métodos get/post… */
export function isHttpService(def: ServiceDefinition): boolean {
  const kind = serviceKind(def);
  if (kind === "connected") return true;
  if (kind === "process") return (def as ProcessServiceDefinition).http ?? (def as ProcessServiceDefinition).port != null;
  return !!(def as ProvisionedServiceDefinition).http;
}

/** Servicio declarado en el script. Sus métodos HTTP pasan por el proxy y quedan como evidencia del caso. */
export interface Service extends Api {
  readonly name: string;
  readonly definition: ServiceDefinition;
  /** URL del servicio a través de su proxy, para `page.goto()`. */
  url(path?: string): string;
}

const declared = new Map<string, ServiceDefinition>();

/** Servicios declarados con defineService en los scripts cargados. Lo usa run.ts. */
export function declaredServices(): ServiceDefinition[] {
  return [...declared.values()];
}

/**
 * Declara un servicio que usa el caso. Va en el mismo script (o en un módulo que el script importa).
 *
 * Se usa con await, igual que defineCase(); devuelve el servicio:
 *
 *   const api = await defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });
 *   const db = await defineService({ name: "postgres", image: "docker.io/library/postgres:16.4-alpine", ports: [{ container: 5432 }] });
 *   const svc = await defineService({ name: "pedidos-svc", build: "./services/pedidos", ports: [{ container: 8080 }], dependsOn: [db], http: true });
 *   const web = await defineService({ name: "web", command: "bun run dev", cwd: "./apps/web", port: 3000 });
 */
export function defineService(def: ServiceDefinition): Promise<Service> {
  const p = (async () => registerService(def))();
  p.catch(() => {}); // run.ts lo informa desde takeDefinedCases(), aunque el archivo no use await
  pendingCases.push(p);
  return p;
}

function registerService(def: ServiceDefinition): Service {
  if (!def?.name) throw new Error("defineService() necesita un name.");
  const isConnected = "endpoint" in def && !!def.endpoint;
  const isProvisioned = ("image" in def && !!def.image) || ("build" in def && !!def.build);
  const isProcess = !isConnected && !isProvisioned && "command" in def && typeof def.command === "string" && def.command.trim() !== "";
  if ([isConnected, isProvisioned, isProcess].filter(Boolean).length !== 1 || (isConnected && (isProvisioned || "command" in def))) {
    throw new Error(`defineService("${def.name}"): declara endpoint (servicio conectado), image/build (contenedor) o command (proceso local), solo uno.`);
  }
  if (isProcess) {
    const port = (def as ProcessServiceDefinition).port;
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error(`defineService("${def.name}"): port debe ser un entero entre 1 y 65535.`);
    if ((def as ProcessServiceDefinition).http && port == null) throw new Error(`defineService("${def.name}"): un proceso http necesita port.`);
  }
  const prev = declared.get(def.name);
  if (prev && !isDeepStrictEqual(normalizeDef(prev), normalizeDef(def))) {
    throw new Error(`El servicio "${def.name}" está declarado dos veces con definiciones distintas. Usa la misma definición en todos los scripts que lo declaran.`);
  }
  declared.set(def.name, def);
  const http = (): Api => context("las llamadas a un servicio").api(def.name);
  return {
    name: def.name,
    definition: def,
    url: (path) => context("url()").url(def.name, path),
    get: (p, o) => http().get(p, o),
    post: (p, o) => http().post(p, o),
    put: (p, o) => http().put(p, o),
    patch: (p, o) => http().patch(p, o),
    delete: (p, o) => http().delete(p, o),
    fetch: (p, o) => http().fetch(p, o),
  };
}

function normalizeDef(def: ServiceDefinition): unknown {
  const d: any = { ...def };
  if (Array.isArray(d.dependsOn)) d.dependsOn = d.dependsOn.map((x: any) => (typeof x === "string" ? x : x.name));
  return d;
}

/* ---------- valores sensibles ---------- */

const sensitiveSet = new Set<string>();

/**
 * Declara un valor o texto sensible y lo devuelve tal cual, para usarlo en la misma línea:
 *
 *   const password = sensitive(process.env.PEDRO_PASSWORD ?? "");
 *   await api.post("/v1/auth/token", { data: { email, password } });
 *
 * El caso usa el valor real. En el reporte y en el HTML queda ofuscado (`••••`) en todo lugar donde aparezca:
 * URL, headers, bodies, anotaciones y aserciones. Funciona en el módulo, en defineCase o dentro de un paso.
 * Valores de menos de 4 caracteres no se registran, porque ofuscarlos taparía texto común.
 */
export function sensitive<T extends string | number | null | undefined>(value: T): T {
  if (value != null) {
    const v = String(value);
    if (v.length >= 4) sensitiveSet.add(v);
  }
  return value;
}

/** Valores declarados con sensitive() (y los de fromEnv que existen en el entorno). Lo usa run.ts. */
export function sensitiveValues(): string[] {
  return [...sensitiveSet];
}

/** Reemplaza los valores sensibles de un texto por `••••`. */
export function maskSensitive(text: string): string {
  let out = text;
  for (const v of [...sensitiveSet].sort((a, b) => b.length - a.length)) out = out.split(v).join("••••");
  return out;
}

/* ---------- utilidades para usar dentro de los pasos sin `t` ---------- */

const active = new AsyncLocalStorage<CaseContext>();

function context(what: string): CaseContext {
  const t = active.getStore();
  if (!t) throw new Error(`${what} solo funciona dentro de un paso: given(), when() o then().`);
  return t;
}

/**
 * Validador para el esperado de check() y ensure(): recibe el valor real y devuelve true si pasa.
 * Si devuelve false o lanza un error, la aserción falla. En el reporte, el esperado queda como su descripción.
 */
export type Validator<T = any> = ((actual: T) => boolean) & { description?: string };

/** Validador con una descripción legible para el reporte: `satisfies("par", (n) => n % 2 === 0)`. */
export function satisfies<T = any>(description: string, fn: (actual: T) => boolean): Validator<T> {
  return Object.assign((actual: T) => fn(actual), { description });
}

/** El valor es instancia de la clase: `check("creado es fecha", body.creado, instanceOf(Date))`. */
export function instanceOf(cls: abstract new (...args: any[]) => unknown): Validator {
  return satisfies(`instancia de ${cls.name || "la clase"}`, (v) => v instanceof cls);
}

/** El número está en el rango, con los extremos incluidos: `check("latencia", ms, between(0, 500))`. */
export function between(min: number, max: number): Validator<number> {
  return satisfies(`entre ${min} y ${max}`, (v) => typeof v === "number" && v >= min && v <= max);
}

/** Cómo queda en el reporte el esperado de un validador: su descripción o su código. */
function describeValidator(fn: Validator): string {
  if (fn.description) return fn.description;
  // Con TypeScript sin compilar, los tipos quedan como espacios: "(n: number) =>" se lee "(n         ) =>".
  const src = Function.prototype.toString.call(fn).replace(/\s+/g, " ").replace(/ ([),;\]}])/g, "$1").trim();
  return src.length > 200 ? src.slice(0, 199) + "…" : src;
}

/** Compara el valor real con el esperado. Un esperado que es función se usa como validador. */
function evaluate(actual: unknown, expected: unknown): { passed: boolean; expected: unknown } {
  if (typeof expected !== "function") return { passed: isDeepStrictEqual(actual, expected), expected };
  const fn = expected as Validator;
  const desc = describeValidator(fn);
  let r: unknown;
  try {
    r = fn(actual);
  } catch (e) {
    return { passed: false, expected: `${desc} (lanzó: ${(e as Error)?.message ?? String(e)})` };
  }
  if (r instanceof Promise) throw new Error(`El validador de check() no puede ser async: ${desc}`);
  if (typeof r !== "boolean") throw new Error(`El validador de check() debe devolver true o false: ${desc}`);
  return { passed: r, expected: desc };
}

/**
 * Registra una aserción y sigue. Igual que `t.check`.
 * El esperado es un valor (se compara en profundidad) o un validador: `check("total", body.total, (n) => n > 0)`.
 */
export function check(expression: string, actual: unknown, expected: unknown, opts?: CheckOptions): boolean {
  return context("check()").check(expression, actual, expected, opts);
}

/** Registra una aserción y detiene el caso si falla. Igual que `t.require`. */
export function ensure(expression: string, actual: unknown, expected: unknown, opts?: CheckOptions): void {
  context("ensure()").require(expression, actual, expected, opts);
}

/** Página de Playwright del caso. Igual que `t.page()`. */
export function page(): Promise<Page> {
  return context("page()").page();
}

/**
 * Define una anotación y devuelve el valor, para usarlo en la misma línea:
 *
 *   const timeAlive = notation("time alive", res.body.timeAlive);
 *
 * - En el cuerpo de defineCase (fuera de los pasos): anotación de todo el caso, por ejemplo `notation("tenant", "tienda-norte")`.
 * - En un paso, después de un request: se une a ese request (o al de `{ response }`).
 * - En un paso, antes de cualquier request: la llevan los requests que siguen en ese paso, por ejemplo `notation("usuario", "pedro@acme.test")`.
 */
export function notation<T>(name: string, value: T, opts?: NotationOptions): T {
  const t = active.getStore();
  if (t) return t.notation(name, value, opts);
  const d = collecting.getStore();
  if (d) {
    d.annotations[annotationKey(name)] = annotationValue(value);
    return value;
  }
  if (running.getStore()) return value; // anotación del caso: ya quedó registrada
  throw new Error("notation() solo se usa dentro de defineCase(async () => { … }) o de un paso.");
}

export interface NotationOptions {
  /** Request al que pertenece la anotación. Si se omite: el último request del paso actual. */
  response?: TrackedResponse;
}

const KEY = /^[a-z0-9áéíóúñü][a-z0-9áéíóúñü _-]*$/;
function annotationKey(name: string): string {
  const k = String(name).trim().toLowerCase();
  if (!KEY.test(k) || k.length > 64) throw new Error(`notation("${name}"): el nombre usa letras, números, espacios, - o _ (hasta 64).`);
  return k;
}
function annotationValue(v: unknown): string | number | boolean {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v) ?? String(v);
}

/** Datos compartidos entre los pasos del caso que está corriendo. Igual que `t.vars`. */
const varsStore = (): Record<string, any> => {
  const t = active.getStore() ?? running.getStore()?.t;
  if (t) return t.vars;
  const d = collecting.getStore();
  if (d) return d.vars;
  return context("vars").vars;
};
export const vars: Record<string, any> = new Proxy({} as Record<string, any>, {
  get: (_, k) => varsStore()[k as string],
  set: (_, k, v) => ((varsStore()[k as string] = v), true),
  has: (_, k) => k in varsStore(),
  deleteProperty: (_, k) => delete varsStore()[k as string],
  ownKeys: () => Reflect.ownKeys(varsStore()),
  getOwnPropertyDescriptor: (_, k) => Reflect.getOwnPropertyDescriptor(varsStore(), k),
});

/* ---------- cookies ---------- */

export type CookiesInit = Cookies | Record<string, string | number | boolean> | Iterable<readonly [string, string]>;

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Codifica solo lo que no puede ir en el valor de una cookie; el resto queda tal cual (por ejemplo el `=` de un token base64). */
const cookieValue = (v: string) => v.replace(/[^\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]/gu, (c) => encodeURIComponent(c));

/**
 * Cookies de un request o de una respuesta, por nombre. Se pasan tal cual en la opción `cookies` de otro request:
 *
 *   const login = await api.post("/login", { data });
 *   const perfil = await api.get("/perfil", { cookies: login.cookies });
 */
export class Cookies implements Iterable<[string, string]> {
  #map = new Map<string, string>();

  constructor(init?: CookiesInit) {
    if (init) this.merge(init);
  }

  /** Suma cookies (otro Cookies, un objeto o pares nombre/valor). Las que ya existen se reemplazan. */
  merge(init: CookiesInit): this {
    const entries = init instanceof Cookies ? init.entries() : Symbol.iterator in Object(init) ? (init as Iterable<readonly [string, string]>) : Object.entries(init as Record<string, unknown>);
    for (const [k, v] of entries) this.set(k, v as string);
    return this;
  }

  get(name: string): string | undefined {
    return this.#map.get(name);
  }
  has(name: string): boolean {
    return this.#map.has(name);
  }
  set(name: string, value: string | number | boolean): this {
    if (!COOKIE_NAME.test(name)) throw new Error(`cookies: "${name}" no es un nombre de cookie válido.`);
    this.#map.set(name, cookieValue(String(value)));
    return this;
  }
  delete(name: string): boolean {
    return this.#map.delete(name);
  }
  get size(): number {
    return this.#map.size;
  }
  entries(): IterableIterator<[string, string]> {
    return this.#map.entries();
  }
  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.#map.entries();
  }
  /** Valor del header Cookie: `a=1; b=2`. */
  toString(): string {
    return [...this.#map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  toJSON(): Record<string, string> {
    return Object.fromEntries(this.#map);
  }

  /** Aplica los headers Set-Cookie de una respuesta: fija las nuevas y borra las vencidas (Max-Age=0 o Expires pasado). */
  applySetCookie(lines: string[]): this {
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      if (!COOKIE_NAME.test(name)) continue;
      let value = pair.slice(eq + 1).trim();
      if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
      const attr = (n: string) => attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith(n + "="))?.slice(n.length + 1);
      const maxAge = attr("max-age");
      const expires = attr("expires");
      const gone = (maxAge != null && Number(maxAge) <= 0) || (maxAge == null && expires != null && Date.parse(expires) <= Date.now());
      if (gone) this.#map.delete(name);
      else this.#map.set(name, value);
    }
    return this;
  }
}

/** Une las cookies del request con un header `cookie` que ya venga en headers (sin importar mayúsculas). */
export function withCookies(headers: Record<string, string> = {}, cookies?: CookiesInit): Record<string, string> {
  const jar = cookies ? new Cookies(cookies) : undefined;
  if (!jar?.size) return headers;
  const out: Record<string, string> = {};
  const prev: string[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "cookie") prev.push(v);
    else out[k] = v;
  }
  out.cookie = [...prev, jar.toString()].join("; ");
  return out;
}

/** Cookies que lleva un header Cookie (`a=1; b=2`). */
function parseCookieHeader(value: string | undefined): Array<[string, string]> {
  if (!value) return [];
  return value
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p): Array<[string, string]> => {
      const eq = p.indexOf("=");
      const name = eq > 0 ? p.slice(0, eq).trim() : "";
      return COOKIE_NAME.test(name) ? [[name, p.slice(eq + 1).trim()]] : [];
    });
}

/** Headers Set-Cookie de una respuesta de Playwright (cada uno por separado). */
function setCookieLines(raw: APIResponse): string[] {
  const arr = typeof (raw as any).headersArray === "function" ? (raw as any).headersArray() : undefined;
  if (Array.isArray(arr)) return arr.filter((h: any) => String(h.name).toLowerCase() === "set-cookie").map((h: any) => String(h.value));
  const joined = raw.headers()["set-cookie"];
  return joined ? joined.split("\n") : [];
}

/* ---------- implementación usada por run.ts ---------- */

export interface RecordedCheck {
  tag: string;
  tagKind: "request" | "step";
  expression: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  expectedFailure?: boolean;
}

export interface RecordedNotation {
  tag: string;
  name: string;
  value: string | number | boolean;
}

export interface ServiceTarget {
  name: string;
  baseURL: string;
  viaProxy: boolean;
}

export class CaseAbort extends Error {}

/** Codifica un JSON para un header HTTP (los headers no admiten tildes ni ñ). */
export function encodeHeaderJson(value: unknown): string {
  return "b64:" + Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createContext(opts: {
  def: CaseDefinition;
  services: Map<string, ServiceTarget>;
  newApi: (baseURL: string) => Promise<APIRequestContext>;
  getBrowser: () => Promise<Browser>;
  checks: RecordedCheck[];
  notations: RecordedNotation[];
  requestTags: string[];
  /** Corrida del reporte (header x-testcase-run): import-har.ts omite la evidencia de otras corridas. */
  runId?: string;
}) {
  const { def, services, checks, notations, requestTags } = opts;
  const runHeader: Record<string, string> = opts.runId ? { "x-testcase-run": opts.runId } : {};
  let paso: Paso = "given";
  let stepTag = randomUUID();
  let stepAnnotations: Annotations = {};
  let lastRequestTag: string | undefined;
  let pendingHeaders: Promise<void> = Promise.resolve();
  /** Último request del caso, de cualquier paso: un then() sin requests verifica lo que trajo el when(). */
  let lastCaseRequestTag: string | undefined;
  let browserContext: BrowserContext | undefined;
  let page: Page | undefined;
  const apis = new Map<string, APIRequestContext>();
  const vars: Record<string, any> = {};

  const currentAnnotations = (extra?: Annotations): Annotations => ({ ...(def.annotations ?? {}), paso, ...stepAnnotations, ...(extra ?? {}) });

  const stepHeaders = () => ({
    ...runHeader,
    "x-testcase-uc": def.id,
    "x-testcase-step": stepTag,
    "x-testcase-annotations": encodeHeaderJson(currentAnnotations()),
  });

  function target(service: string): ServiceTarget {
    const s = services.get(service);
    if (!s) throw new Error(`El servicio "${service}" no está en el reporte. Servicios disponibles: ${[...services.keys()].join(", ") || "ninguno"}`);
    return s;
  }

  async function refreshBrowserHeaders() {
    if (browserContext) await browserContext.setExtraHTTPHeaders(stepHeaders());
  }

  function api(service: string): Api {
    const s = target(service);
    const call = async (method: string, path: string, o: RequestOptions = {}): Promise<TrackedResponse> => {
      await pendingHeaders;
      let ctx = apis.get(service);
      if (!ctx) {
        ctx = await opts.newApi(s.baseURL);
        apis.set(service, ctx);
      }
      const tag = randomUUID();
      lastRequestTag = tag;
      lastCaseRequestTag = tag;
      requestTags.push(tag);
      const reqHeaders = withCookies(o.headers, o.cookies);
      const raw = await ctx.fetch(path.replace(/^\//, ""), {
        method,
        headers: {
          ...reqHeaders,
          ...runHeader,
          "x-testcase-uc": def.id,
          "x-testcase-step": stepTag,
          "x-testcase-request": tag,
          "x-testcase-annotations": encodeHeaderJson(currentAnnotations(o.annotations)),
        },
        data: o.data as any,
        form: o.form,
        params: o.params,
        timeout: o.timeout,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      const text = await raw.text().catch(() => "");
      let body: any = text === "" ? undefined : text;
      if (text && /json/i.test(raw.headers()["content-type"] ?? "")) {
        try {
          body = JSON.parse(text);
        } catch {
          /* no era JSON válido: queda el texto */
        }
      }
      // Las enviadas a mano, con los Set-Cookie aplicados, más las que Playwright guarda para este servicio
      const cookies = new Cookies(parseCookieHeader(reqHeaders.cookie)).applySetCookie(setCookieLines(raw));
      if (typeof (ctx as any).storageState === "function") {
        const state = await ctx.storageState().catch(() => undefined);
        for (const c of state?.cookies ?? []) cookies.merge([[c.name, c.value]]);
      }
      return {
        tag,
        raw,
        body,
        cookies,
        status: () => raw.status(),
        headers: () => raw.headers(),
        json: () => raw.json(),
        text: () => raw.text(),
      };
    };
    return {
      get: (p, o) => call("GET", p, o),
      post: (p, o) => call("POST", p, o),
      put: (p, o) => call("PUT", p, o),
      patch: (p, o) => call("PATCH", p, o),
      delete: (p, o) => call("DELETE", p, o),
      fetch: (p, o = {}) => call(o.method ?? "GET", p, o),
    };
  }

  function check(expression: string, actual: unknown, expectedArg: unknown, o: CheckOptions = {}): boolean {
    const { passed, expected } = evaluate(actual, expectedArg);
    const byRequest = o.response?.tag ?? (page ? undefined : lastRequestTag ?? lastCaseRequestTag);
    checks.push({
      tag: byRequest ?? stepTag,
      tagKind: byRequest ? "request" : "step",
      expression,
      passed,
      expected,
      actual,
      ...(o.expectedFailure ? { expectedFailure: true } : {}),
    });
    return passed;
  }

  const t: CaseContext = {
    api,
    async page() {
      await pendingHeaders;
      if (!page) {
        const browser = await opts.getBrowser();
        browserContext = await browser.newContext({ extraHTTPHeaders: stepHeaders() });
        page = await browserContext.newPage();
      }
      return page;
    },
    url(service, path = "/") {
      return new URL(path, target(service).baseURL).toString();
    },
    async step(p, annotations) {
      await pendingHeaders;
      paso = p;
      stepAnnotations = annotations ?? {};
      stepTag = randomUUID();
      lastRequestTag = undefined;
      await refreshBrowserHeaders();
    },
    notation(name, value, o = {}) {
      const key = annotationKey(name);
      const v = annotationValue(value);
      const tag = o.response?.tag ?? lastRequestTag;
      if (tag) notations.push({ tag, name: key, value: v });
      else {
        stepAnnotations = { ...stepAnnotations, [key]: v };
        pendingHeaders = refreshBrowserHeaders();
      }
      return value;
    },
    check,
    require(expression, actual, expected, o) {
      if (!check(expression, actual, expected, o)) throw new CaseAbort(`Falló una aserción obligatoria: ${expression}`);
    },
    vars,
  };

  async function close() {
    await Promise.all([...apis.values()].map((a) => a.dispose()));
    if (browserContext) await browserContext.close();
  }

  return { t, close, lastTag: () => lastRequestTag ?? lastCaseRequestTag ?? stepTag };
}
