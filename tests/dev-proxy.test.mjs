import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import viteConfig from "../vite.config.mjs";
import { testApp, photo } from "./helpers.mjs";

test("Vite proxy permits same-origin browser mutations and rejects foreign origins", async (t) => {
  const app = await testApp(t);
  const proxy = { ...viteConfig().server.proxy["/api"], target: app.base };
  const vite = await createServer({ configFile: false, root: app.root, server: { host: "127.0.0.1", port: 0, proxy: { "/api": proxy } } });
  t.after(() => vite.close()); await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  assert.equal((await fetch(origin + "/api/health")).status, 200);
  const form = new FormData(); form.append("image", new Blob([await photo()], { type: "image/png" }), "photo.png");
  const result = await fetch(origin + "/api/reference", { method: "POST", headers: { Origin: origin }, body: form });
  assert.equal(result.status, 200, await result.text());
  const foreign = await fetch(origin + "/api/reference", { method: "POST", headers: { Origin: "https://untrusted.example" }, body: "{}" });
  assert.equal(foreign.status, 403);
});
