/**
 * testcase.ts
 *
 * Librería de casos de uso. El agente escribe un archivo por caso en `cases/UC-NN.case.ts`:
 *
 *   import { defineCase, title, annotations, given, when, then } from "../testcase.ts";
 *
 *   export default defineCase(() => {
 *     title(() => "Cliente no puede cancelar un pedido ajeno");
 *     annotations({ tenant: "tienda-norte" });
 *
 *     given("un pedido creado por María", { usuario: "pedro@acme.test" }, async (t) => { … });
 *     when("Pedro intenta cancelarlo", async (t) => { … });
 *     then("la API responde 403", async (t) => { … });
 *     then("el pedido sigue en estado pending", async (t) => { … });
 *   });
 *
 * `defineCase` llama a su función una vez, al cargar el archivo, para registrar el título y los pasos.
 * Los pasos se ejecutan después, en el orden en que se declaran, y cada uno recibe el contexto `t`.
 * El id sale del nombre del archivo (`UC-03.case.ts` → `UC-03`) o de `id("UC-03")`.
 *
 * Cada request que hace el caso (con `t.api()` o con el navegador de `t.page()`) pasa por el proxy del servicio
 * y lleva headers `x-testcase-*` para que `import-har.ts` lo asocie al caso, a su paso, a sus anotaciones y a sus aserciones.
 */
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
  /** Suma anotaciones al paso actual. */
  annotate(annotations: Annotations): Promise<void>;
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
  annotations?: Annotations;
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

/** Define un caso de uso. La función registra el título y los pasos con title(), given(), when() y then(). */
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
  return {
    id: d.id ?? "",
    title: d.title,
    given: join("given"),
    when: join("when"),
    then: join("then"),
    annotations: Object.keys(d.annotations).length ? d.annotations : undefined,
    steps,
    async run(t) {
      for (const s of steps) {
        await t.step(s.paso, s.annotations);
        if (s.fn) await s.fn(t);
      }
    },
  };
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

/** Anotaciones de todo el caso (por ejemplo `{ tenant: "tienda-norte" }`). Se suman si se llama más de una vez. */
export function annotations(value: Annotations): void {
  Object.assign(current("annotations").annotations, value);
}

function addStep(paso: Paso, description: Text, a?: Annotations | StepFn, b?: StepFn): void {
  const d = current(paso);
  const fn = typeof a === "function" ? a : b;
  const ann = typeof a === "object" && a !== null ? a : undefined;
  if (fn !== undefined && typeof fn !== "function") throw new Error(`${paso}(): el último argumento debe ser una función.`);
  d.steps.push({ paso, description: text(description, paso), ...(ann ? { annotations: ann } : {}), ...(fn ? { fn } : {}) });
}

/** Paso given: prepara el estado. `given(texto, fn)` o `given(texto, anotaciones, fn)`. */
export function given(description: Text, fn?: StepFn): void;
export function given(description: Text, annotations: Annotations, fn?: StepFn): void;
export function given(description: Text, a?: Annotations | StepFn, b?: StepFn): void {
  addStep("given", description, a, b);
}

/** Paso when: la acción que se prueba. `when(texto, fn)` o `when(texto, anotaciones, fn)`. */
export function when(description: Text, fn?: StepFn): void;
export function when(description: Text, annotations: Annotations, fn?: StepFn): void;
export function when(description: Text, a?: Annotations | StepFn, b?: StepFn): void {
  addStep("when", description, a, b);
}

/** Paso then: lo que se verifica. `then(texto, fn)` o `then(texto, anotaciones, fn)`. */
export function then(description: Text, fn?: StepFn): void;
export function then(description: Text, annotations: Annotations, fn?: StepFn): void;
export function then(description: Text, a?: Annotations | StepFn, b?: StepFn): void {
  addStep("then", description, a, b);
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
  requestTags: string[];
}) {
  const { def, services, checks, requestTags } = opts;
  let paso: Paso = "given";
  let stepTag = randomUUID();
  let stepAnnotations: Annotations = {};
  let lastRequestTag: string | undefined;
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
      return {
        tag,
        raw,
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
      paso = p;
      stepAnnotations = annotations ?? {};
      stepTag = randomUUID();
      lastRequestTag = undefined;
      await refreshBrowserHeaders();
    },
    async annotate(annotations) {
      stepAnnotations = { ...stepAnnotations, ...annotations };
      await refreshBrowserHeaders();
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
