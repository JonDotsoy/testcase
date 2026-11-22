// Ejemplo: copia este archivo a cases/ y ajústalo. Un archivo por caso de uso; el id sale del nombre (UC-01).
// El script es autocontenido: importa lo que usa y declara sus servicios.
import { defineCase, defineService, fromEnv, title, given, when, then, notation, check, ensure, page, vars } from "../testcase.ts";

// Servicio URL que ya existe: sus requests pasan por el proxy de evidencia.
const api = defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });

// Contenedor que se levanta con Podman, con sus migraciones y seeds.
const db = defineService({
  name: "postgres",
  image: "docker.io/library/postgres:16.4-alpine",
  ports: [{ container: 5432 }],
  env: { POSTGRES_DB: "pedidos_test", POSTGRES_PASSWORD: fromEnv("PG_PASSWORD") },
  tmpfs: ["/var/lib/postgresql/data"], // datos en memoria, se descartan al terminar
  artifacts: [
    { kind: "migration", source: "./db/migrations/*.sql" },
    { kind: "seed", source: "./db/seeds/usuarios.sql" },
  ],
  health: "pg_isready",
});

// Contenedor construido desde un Dockerfile del proyecto (las rutas son relativas a la raíz del proyecto).
const pedidos = defineService({
  name: "pedidos-svc",
  build: { context: "./services/pedidos", dockerfile: "Dockerfile" },
  ports: [{ container: 8080 }],
  env: { DATABASE_URL: "postgres://app@postgres:5432/pedidos_test" },
  dependsOn: [db],
  http: true, // habla HTTP: tiene proxy de evidencia y métodos get/post…
  health: "GET /healthz",
});

export default defineCase(() => {
  title(() => "Cliente no puede cancelar un pedido ajeno");
  notation("tenant", "tienda-norte"); // anotación de todo el caso
  notation("db", db.name);
  notation("backend", pedidos.name);

  given("un pedido creado por María", async () => {
    notation("usuario", "pedro@acme.test"); // antes del request: la lleva el request que sigue
    notation("perfil", "cliente");
    const login = await api.post("/v1/auth/token", {
      data: { email: "pedro@acme.test", password: process.env.PEDRO_PASSWORD ?? "" },
    });
    ensure("status == 200", login.status(), 200);
    vars.token = login.body.access_token;
    notation("rol", login.body.user.role); // después del request: se une a ese request
  });

  when("Pedro intenta cancelarlo", async () => {
    notation("usuario", "pedro@acme.test");
    notation("dueño del recurso", "maria@acme.test");
    vars.cancel = await api.delete("/v1/orders/ord_01JD9", { headers: { authorization: `Bearer ${vars.token}` } });
  });

  then("la API responde 403", () => {
    check("status == 403", vars.cancel.status(), 403, { expectedFailure: true });
  });

  then("el pedido sigue en estado pending", async () => {
    notation("usuario", "maria@acme.test");
    const p = await page();
    await p.goto(api.url("/pedidos/ord_01JD9"));
    check('estado visible == "pending"', await p.locator("[data-estado]").textContent(), "pending");
  });
});
