/**
 * @jondotsoy/testcase/runner: lo que usa el runner (run.ts, la CLI o testmania) para cargar y correr los casos.
 * No es parte de la API de los casos: un `*.case.ts` importa desde `@jondotsoy/testcase`.
 */
export {
  takeDefinedCases,
  declaredServices,
  createContext,
  CaseAbort,
  serviceKind,
  isHttpService,
  sensitiveValues,
  maskSensitive,
  encodeHeaderJson,
  parseEnvFile,
  graphqlOperations,
} from "./testcase.ts";

export type { CaseDefinition, CaseStep, RecordedCheck, RecordedNotation, ServiceDefinition, ServiceTarget } from "./testcase.ts";
