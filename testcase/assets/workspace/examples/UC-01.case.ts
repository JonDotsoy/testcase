// Ejemplo: copia este archivo a cases/ y ajústalo. Un archivo por caso de uso; el id sale del nombre (UC-01).
import { defineCase, title, annotations, given, when, then } from "../testcase.ts";

export default defineCase(() => {
  title(() => "Cliente no puede cancelar un pedido ajeno");
  annotations({ tenant: "tienda-norte" });

  given("un pedido creado por María", { usuario: "pedro@acme.test", perfil: "cliente" }, async (t) => {
    const login = await t.api("api").post("/v1/auth/token", {
      data: { email: "pedro@acme.test", password: process.env.PEDRO_PASSWORD ?? "" },
    });
    t.require("status == 200", login.status(), 200, { response: login });
    t.vars.token = (await login.json()).access_token;
  });

  when("Pedro intenta cancelarlo", { usuario: "pedro@acme.test", perfil: "cliente", "dueño-del-recurso": "maria@acme.test" }, async (t) => {
    t.vars.cancel = await t.api("api").delete("/v1/orders/ord_01JD9", {
      headers: { authorization: `Bearer ${t.vars.token}` },
    });
  });

  then("la API responde 403", async (t) => {
    t.check("status == 403", t.vars.cancel.status(), 403, { response: t.vars.cancel, expectedFailure: true });
  });

  then("el pedido sigue en estado pending", { usuario: "maria@acme.test", perfil: "cliente" }, async (t) => {
    const page = await t.page();
    await page.goto(t.url("api", "/pedidos/ord_01JD9"));
    t.check('estado visible == "pending"', await page.locator("[data-estado]").textContent(), "pending");
  });
});
