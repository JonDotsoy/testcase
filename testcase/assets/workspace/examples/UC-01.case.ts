// Ejemplo: copia este archivo a cases/ y ajústalo. Un archivo por caso de uso.
import { defineCase } from "../testcase.ts";

export default defineCase({
  id: "UC-01",
  title: "Cliente no puede cancelar un pedido ajeno",
  given: "un pedido creado por María",
  when: "Pedro intenta cancelarlo",
  then: "la API responde 403 y el pedido sigue en estado pending",
  annotations: { tenant: "tienda-norte" },

  async run(t) {
    const api = t.api("api");

    // given
    await t.step("given", { usuario: "pedro@acme.test", perfil: "cliente" });
    const login = await api.post("/v1/auth/token", {
      data: { email: "pedro@acme.test", password: process.env.PEDRO_PASSWORD ?? "" },
    });
    t.require("status == 200", login.status(), 200, { response: login });
    const { access_token } = await login.json();

    // when
    await t.step("when", { usuario: "pedro@acme.test", perfil: "cliente", "dueño-del-recurso": "maria@acme.test" });
    const del = await api.delete("/v1/orders/ord_01JD9", { headers: { authorization: `Bearer ${access_token}` } });
    t.check("status == 403", del.status(), 403, { response: del, expectedFailure: true });

    // then: la vista del pedido en el navegador sigue mostrando "pending"
    await t.step("then", { usuario: "maria@acme.test", perfil: "cliente" });
    const page = await t.page();
    await page.goto(t.url("api", "/pedidos/ord_01JD9"));
    t.check("estado visible == \"pending\"", await page.locator("[data-estado]").textContent(), "pending");
  },
});
