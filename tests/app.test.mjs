import test from "node:test";
import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import { testApp, until, photo } from "./helpers.mjs";

test("empty detection stays visible and manual entry uses the saved photo", async (t) => {
  const app = await testApp(t); app.codex.result = { items: [] };
  const id = (await app.upload(false)).value.jobs[0].id;
  await until(async () => (await app.store.job(id)).stages.analysis.status === "failed");
  const visible = (await app.api("/api/import/jobs")).value;
  assert.equal(visible.length, 1); assert.equal(visible[0].id, id);
  assert.match(visible[0].stages.analysis.error, /No clothing detected/);
  assert.equal((await fetch(app.base + `/api/import/jobs/${id}/package`)).status, 200);
  const manual = await app.api(`/api/import/jobs/${id}/manual`, "POST");
  assert.equal(manual.status, 200); assert.equal(manual.value.stages.crop.status, "review");
  assert.equal(manual.value.stages.analysis.error, null); assert.equal(manual.value.noClothingDetected, false);
  assert.equal((await fetch(app.base + manual.value.stages.crop.assetUrl)).status, 200);
  await app.approveImport(id, "crop");
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
  assert.equal((await app.approveImport(id, "garment")).status, 200);
  assert.equal((await app.store.json("library.json", [])).length, 1);
});

test("retrying empty detection makes a fresh analysis instead of replaying its empty receipt", async (t) => {
  const app = await testApp(t); app.codex.result = { items: [] };
  const id = (await app.upload(false)).value.jobs[0].id;
  await until(async () => (await app.store.job(id)).stages.analysis.status === "failed");
  assert.equal(app.codex.calls.length, 1);
  delete app.codex.result;
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/analysis/retry`, "POST")).status, 200);
  await until(async () => (await app.store.job(id)).status === "complete");
  assert.equal(app.codex.calls.length, 2);
  const children = (await app.api("/api/import/jobs")).value;
  assert.equal(children.length, 1); assert.equal(children[0].parentId, id);
  assert.equal(children[0].stages.crop.status, "review");
});

test("multipart camera import, optional modeled photo, approvals and concurrent server edits preserve records", async (t) => {
  const app = await testApp(t);
  const first = (await app.upload()).value.jobs[0];
  const second = (await app.upload()).value.jobs[0];
  assert.equal(first.stages.crop.status, "review");
  assert.equal((await app.approveImport(first.id, "crop")).status, 200);
  assert.equal((await app.approveImport(second.id, "crop")).status, 200);
  await until(async () => (await app.store.job(first.id)).stages.garment.status === "review");
  await until(async () => (await app.store.job(second.id)).stages.garment.status === "review");
  for (const job of [first, second]) assert.equal((await app.approveImport(job.id, "garment", { generateModeled: false })).status, 200);
  const ids = [first, second].map((j) => `import-${j.id}`);
  await Promise.all(ids.map((id, index) => app.api(`/api/import/wardrobe/${id}`, "PATCH", { metadata: { name: `Saved ${index}` } })));
  const library = (await app.api("/api/import/wardrobe")).value;
  assert.equal(library.length, 2); assert.deepEqual(new Set(library.map((r) => r.name)), new Set(["Saved 0", "Saved 1"]));
  assert.equal(app.codex.calls.length, 2); // single queue, one image call per garment
  assert.equal(app.codex.maxActive, 1);
  assert.ok(await readFile(app.store.file(`jobs/${first.id}/upload.bin`)));
  const image = await fetch(app.base + library[0].image + "?w=160"); assert.equal(image.status, 200); assert.equal(image.headers.get("content-type"), "image/webp");
  assert.equal((await app.api("/api/import/config")).value.hasModelReference, false);
  assert.equal((await app.api(`/api/import/jobs/${first.id}/stages/modeled/regenerate`, "POST")).status, 200);
  await until(async () => (await app.store.job(first.id)).stages.modeled.status === "failed");
  assert.equal(app.codex.calls.length, 2); // no image call without identity
});

test("analysis saves originals first and creates separate crop reviews", async (t) => {
  const app = await testApp(t); const parent = (await app.upload(false)).value.jobs[0];
  assert.ok(await readFile(app.store.file(`jobs/${parent.id}/upload.bin`)));
  await until(async () => (await app.store.job(parent.id)).status === "complete");
  const jobs = (await app.api("/api/import/jobs")).value;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].parentId, parent.id); assert.equal(jobs[0].metadata.name, "Red tee"); assert.equal(jobs[0].stages.crop.status, "review");
});

test("disconnected uploads remain durable and permit manual entry", async (t) => {
  const app = await testApp(t); app.codex.status.connected = false;
  const job = (await app.upload(false)).value.jobs[0];
  await until(() => app.jobs.status.paused);
  assert.equal((await app.store.job(job.id)).stages.analysis.status, "queued");
  assert.equal((await app.api(`/api/import/jobs/${job.id}/manual`, "POST")).status, 200);
  assert.equal((await app.store.job(job.id)).stages.crop.status, "review"); assert.equal(app.codex.calls.length, 0);
});

test("reject cross-origin mutations, symlink asset escapes and invalid decoded images", async (t) => {
  const app = await testApp(t);
  const response = await fetch(app.base + "/api/reference", { method: "POST", headers: { Origin: "https://untrusted.example", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 403);
  await symlink(app.root + "/package.json", app.store.file("imported/escape.png"));
  assert.equal((await fetch(app.base + "/api/import/library/escape.png")).status, 422);
  const form = new FormData(); form.append("image", new Blob(["not an image"], { type: "image/png" }), "bad.png");
  assert.equal((await app.api("/api/import/jobs", "POST", form)).status, 422);
  assert.equal((await app.store.jobs()).length, 0);
});

test("SSE reports other-device mutations, migration is explicit and sources survive cancellation", async (t) => {
  const app = await testApp(t); const controller = new AbortController();
  const response = await fetch(app.base + "/api/events", { signal: controller.signal });
  const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /event: change/);
  const job = (await app.upload()).value.jobs[0];
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: change/); controller.abort();
  await app.api(`/api/import/jobs/${job.id}/cancel`, "POST");
  assert.ok(await readFile(app.store.file(`jobs/${job.id}/upload.bin`))); assert.equal((await app.api("/api/import/jobs")).value.length, 0);
  await app.store.lock(() => app.store.write("library.json", [{ id: "legacy", name: "Old", part: "upperbody", color: "#ffffff", tags: [] }]));
  assert.equal((await app.api("/api/import/wardrobe")).value[0].name, "Old");
  const migration = await app.api("/api/import/migrate", "POST", { edits: { legacy: { name: "Migrated" } }, deleted: [] });
  assert.equal(migration.status, 200); assert.equal((await app.api("/api/import/wardrobe")).value[0].name, "Migrated");
});
