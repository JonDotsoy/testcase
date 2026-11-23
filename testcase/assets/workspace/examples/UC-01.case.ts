// Ejemplo: copia este archivo a cases/ y ajústalo. Un archivo por caso de uso; el id sale del nombre (UC-01).
// El script es autocontenido: importa lo que usa y declara sus servicios.
import { defineCase, defineService, fromEnv, sensitive, title, describe, given, when, then, notation, check, ensure, between, page } from "../testcase.ts";

// Servicio URL que ya existe: sus requests pasan por el proxy de evidencia.
const api = await defineService({ name: "api", endpoint: "https://api.example.com", health: "GET /healthz" });

// Contenedor que se levanta con Podman, con sus migraciones y seeds.
const db = await defineService({
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
const pedidos = await defineService({
  name: "pedidos-svc",
  build: { context: "./services/pedidos", dockerfile: "Dockerfile" },
  ports: [{ container: 8080 }],
  env: { DATABASE_URL: "postgres://app@postgres:5432/pedidos_test" },
  dependsOn: [db],
  http: true, // habla HTTP: tiene proxy de evidencia y métodos get/post…
  health: "GET /healthz",
});

await defineCase(async () => {
  await title(() => "Cliente no puede cancelar un pedido ajeno");
  await describe("Un cliente solo puede cancelar sus propios pedidos. La API rechaza la cancelación y el pedido no cambia.");
  notation("tenant", "tienda-norte"); // anotación de todo el caso
  notation("db", db.name);
  notation("backend", pedidos.name);

  // Cada paso se espera con await y devuelve lo que devuelve su función.
  const token = await given("un pedido creado por María", async () => {
    notation("usuario", "pedro@acme.test"); // antes del request: la lleva el request que sigue
    notation("perfil", "cliente");
    const password = sensitive(process.env.PEDRO_PASSWORD ?? ""); // en el HTML queda oculto
    const login = await api.http.post("/v1/auth/token", { data: { email: "pedro@acme.test", password } });
    ensure("status == 200", login.status(), 200);
    notation("rol", login.body.user.role); // después del request: se une a ese request
    return sensitive(login.body.access_token as string);
  });

  const cancel = await when("Pedro intenta cancelarlo", async () => {
    notation("usuario", "pedro@acme.test");
    notation("dueño del recurso", "maria@acme.test");
    return api.http.delete("/v1/orders/ord_01JD9", { headers: { authorization: `Bearer ${token}` } });
  });

  await then("la API responde 403", () => {
    check("status == 403", cancel.status(), 403, { expectedFailure: true });
    check("el body trae detail", cancel.body.detail, (d: unknown) => typeof d === "string" && d.length > 0); // validador
    check("es un error del cliente (4xx)", cancel.status(), between(400, 499), { expectedFailure: true });
  });

  await then("el pedido sigue en estado pending", async () => {
    notation("usuario", "maria@acme.test");
    const p = await page();
    await p.goto(api.url("/pedidos/ord_01JD9"));
    check('estado visible == "pending"', await p.locator("[data-estado]").textContent(), "pending");
  });
});
