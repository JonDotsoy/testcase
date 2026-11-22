/**
 * testcase.ts
 *
 * Tipos y contexto que recibe cada caso de uso. El agente escribe un archivo por caso en `cases/`:
 *
 *   import { defineCase } from "../testcase.ts";
 *
 *   export default defineCase({
 *     id: "UC-03",
 *     title: "Cliente no puede cancelar un pedido ajeno",
 *     given: "un pedido creado por otro cliente",
 *     when: "intenta cancelarlo",
 *     then: "la API responde 403 y el pedido no cambia",
 *     async run(t) { … },
 *   });
 *
 * Cada request que hace el caso (con `t.api()` o con el navegador de `t.page()`) pasa por el proxy del servicio
 * y lleva headers `x-testcase-*` para que `import-har.ts` lo asocie al caso, a sus anotaciones y a sus aserciones.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { APIRequestContext, APIResponse, Browser, BrowserContext, Page } from "playwright";

export type Paso = "given" | "when" | "then";
export type Annotations = Record<string, string | number | boolean>;

export interface CaseDefinition {
  /** Id estable del caso: UC-01, UC-02… */
  id: string;
  title: string;
  given: string;
  when: string;
  then: string;
  /** Anotaciones que llevan todos los requests del caso (por ejemplo `tenant`). */
  annotations?: Annotations;
  run(t: CaseContext): Promise<void>;
}

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
  /** Request al que pertenece la aserción. Si se omite: el último request del paso actual. */
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

export function defineCase(def: CaseDefinition): CaseDefinition {
  return def;
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
    const byResponse = o.response?.tag;
    checks.push({
      tag: byResponse ?? (page ? stepTag : lastRequestTag ?? stepTag),
      tagKind: byResponse || (!page && lastRequestTag) ? "request" : "step",
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

  return { t, close, lastTag: () => lastRequestTag ?? stepTag };
}
