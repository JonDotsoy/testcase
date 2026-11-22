/**
 * testcase.ts
 *
 * Librería de casos de uso. Cada caso es un script autocontenido en `cases/UC-NN.case.ts`: importa todo lo que
 * necesita desde aquí y declara los servicios que usa con `defineService`.
 *
 *   import { defineCase, defineService, title, given, when, then, check, vars } from "../testcase.ts";
 *
 *   const api = defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });
 *
 *   export default defineCase(() => {
 *     title("Cliente no puede cancelar un pedido ajeno");
 *     given("un pedido creado por María", { usuario: "pedro@acme.test" }, async () => { … });
 *     when("Pedro intenta cancelarlo", async () => { vars.res = await api.delete("/v1/orders/ord_01JD9"); });
 *     then("la API responde 403", () => { check("status == 403", vars.res.status(), 403, { expectedFailure: true }); });
 *   });
 *
 * `defineCase` llama a su función una vez, al cargar el archivo, para registrar el título y los pasos.
 * Los pasos se ejecutan después, en el orden en que se declaran. Cada paso recibe el contexto `t`, y también puede
 * usar las utilidades importadas (`check`, `ensure`, `notation`, `page`, `vars`) y los métodos de sus servicios.
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
  /** Registra una aserción. Devuelve si pasó. No lanza: el caso sigue corriendo. */
  check(expression: string, actual: unknown, expected: unknown, opts?: CheckOptions): boolean;
  /** Igual que `check`, pero detiene el caso si falla. */
  require(expression: string, actual: unknown, expected: unknown, opts?: CheckOptions): void;
  /** Guarda un dato entre pasos (ids creados, tokens…). */
  readonly vars: Record<string, any>;
}

/* ---------- sintaxis defineCase(() => { title(); given(); when(); then(); }) ---------- */

/** Función de un paso. Recibe el contexto del caso. */
export type StepFn = (t: CaseContext) => unknown | Promise<unknown>;
type Text = string | (() => string);

export interface CaseStep {
  paso: Paso;
  description: string;
  fn?: StepFn;
}

/** Caso declarado con `defineCase(() => { … })`. `run.ts` completa el id con el nombre del archivo si falta. */
export interface CaseDefinition {
  /** Id estable del caso: UC-01, UC-02… */
  id: string;
  title: string;
  given: string;
  when: string;
  then: string;
  /** Anotaciones que llevan todos los requests del caso (por ejemplo `tenant`). */
  annotations?: Annotations;
  /** Pasos en el orden declarado. */
  steps: CaseStep[];
  run(t: CaseContext): Promise<void>;
}

interface Draft {
  id?: string;
  title?: string;
  annotations: Annotations;
  steps: CaseStep[];
}

let draft: Draft | undefined;

function current(fn: string): Draft {
  if (!draft) throw new Error(`${fn}() solo se usa dentro de defineCase(() => { … }).`);
  return draft;
}

const text = (v: Text, fn: string): string => {
  const s = typeof v === "function" ? v() : v;
  if (typeof s !== "string" || !s.trim()) throw new Error(`${fn}() necesita un texto no vacío.`);
  return s.trim();
};

const definedCases: CaseDefinition[] = [];

/** Casos definidos desde la última llamada, en orden. Lo usa run.ts después de importar cada archivo. */
export function takeDefinedCases(): CaseDefinition[] {
  return definedCases.splice(0);
}

/**
 * Define un caso de uso. La función registra el título y los pasos con title(), given(), when() y then().
 * Un archivo puede definir varios casos; en ese caso cada uno declara su id("UC-NN").
 */
export function defineCase(build: () => void): CaseDefinition {
  if (draft) throw new Error("defineCase() no se puede anidar.");
  const d: Draft = { annotations: {}, steps: [] };
  draft = d;
  try {
    const r = build() as unknown;
    if (r instanceof Promise) throw new Error("La función de defineCase() debe ser síncrona: el código async va dentro de given(), when() y then().");
  } finally {
    draft = undefined;
  }
  if (!d.title) throw new Error("Falta title() en defineCase().");
  for (const p of ["given", "when", "then"] as const) {
    if (!d.steps.some((s) => s.paso === p)) throw new Error(`"${d.title}": falta al menos un ${p}().`);
  }
  const join = (p: Paso) => d.steps.filter((s) => s.paso === p).map((s) => s.description).join(" y ");
  const steps = d.steps;
  const def: CaseDefinition = {
    id: d.id ?? "",
    title: d.title,
    given: join("given"),
    when: join("when"),
    then: join("then"),
    annotations: Object.keys(d.annotations).length ? d.annotations : undefined,
    steps,
    async run(t) {
      await active.run(t, async () => {
        for (const s of steps) {
          await t.step(s.paso);
          if (s.fn) await s.fn(t);
        }
      });
    },
  };
  definedCases.push(def);
  return def;
}

/** Título del caso, en palabras de la persona. Acepta un texto o una función que lo devuelve. */
export function title(value: Text): void {
  const d = current("title");
  if (d.title) throw new Error("title() se declara una sola vez por caso.");
  d.title = text(value, "title");
}

/** Id del caso (UC-NN). Opcional: por defecto sale del nombre del archivo. */
export function id(value: string): void {
  current("id").id = text(value, "id");
}

function addStep(paso: Paso, description: Text, fn?: StepFn): void {
  const d = current(paso);
  if (fn !== undefined && typeof fn !== "function") throw new Error(`${paso}(): el segundo argumento debe ser una función.`);
  d.steps.push({ paso, description: text(description, paso), ...(fn ? { fn } : {}) });
}

/** Paso given: prepara el estado. */
export function given(description: Text, fn?: StepFn): void {
  addStep("given", description, fn);
}

/** Paso when: la acción que se prueba. */
export function when(description: Text, fn?: StepFn): void {
  addStep("when", description, fn);
}

/** Paso then: lo que se verifica. */
export function then(description: Text, fn?: StepFn): void {
  addStep("then", description, fn);
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

export type ServiceDefinition = ConnectedServiceDefinition | ProvisionedServiceDefinition;

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
 *   const api = defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });
 *   const db = defineService({ name: "postgres", image: "docker.io/library/postgres:16.4-alpine", ports: [{ container: 5432 }] });
 *   const svc = defineService({ name: "pedidos-svc", build: "./services/pedidos", ports: [{ container: 8080 }], dependsOn: [db], http: true });
 */
export function defineService(def: ServiceDefinition): Service {
  if (!def?.name) throw new Error("defineService() necesita un name.");
  const isConnected = "endpoint" in def && !!def.endpoint;
  const isProvisioned = ("image" in def && !!def.image) || ("build" in def && !!def.build);
  if (isConnected === isProvisioned) throw new Error(`defineService("${def.name}"): declara endpoint (servicio conectado) o image/build (contenedor), no los dos.`);
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

/** Registra una aserción y sigue. Igual que `t.check`. */
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
  if (draft) {
    draft.annotations[annotationKey(name)] = annotationValue(value);
    return value;
  }
  throw new Error("notation() solo se usa dentro de defineCase(() => { … }) o de un paso.");
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
export const vars: Record<string, any> = new Proxy({} as Record<string, any>, {
  get: (_, k) => context("vars").vars[k as string],
  set: (_, k, v) => ((context("vars").vars[k as string] = v), true),
  has: (_, k) => k in context("vars").vars,
  deleteProperty: (_, k) => delete context("vars").vars[k as string],
  ownKeys: () => Reflect.ownKeys(context("vars").vars),
  getOwnPropertyDescriptor: (_, k) => Reflect.getOwnPropertyDescriptor(context("vars").vars, k),
});

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
}) {
  const { def, services, checks, notations, requestTags } = opts;
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
      const raw = await ctx.fetch(path.replace(/^\//, ""), {
        method,
        headers: {
          ...(o.headers ?? {}),
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
      return {
        tag,
        raw,
        body,
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

  function check(expression: string, actual: unknown, expected: unknown, o: CheckOptions = {}): boolean {
    const passed = isDeepStrictEqual(actual, expected);
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
