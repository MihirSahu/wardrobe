import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Store, atomicJson, atomicWrite, stage, now } from "../server/store.mjs";
import { Jobs } from "../server/jobs.mjs";
import { fixture, FakeCodex, cutout, until, testApp, photo } from "./helpers.mjs";

for (const recovery of ["manual", "retry"]) test(`startup restores access to previously hidden empty detections for ${recovery}`, async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init();
  const codex = new FakeCodex(root); const id = "44444444-4444-4444-a444-444444444444";
  await store.lock(async () => {
    await mkdir(store.file(`jobs/${id}`)); await store.asset(`jobs/${id}/original.png`, await photo()); await store.asset(`jobs/${id}/crop.png`, await photo());
    await store.saveJob({ id, kind: "import", status: "complete", noClothingDetected: true, childIds: [], createdAt: now(), internal: { originalFile: "original.png", cropFile: "crop.png" },
      stages: { analysis: stage("complete"), crop: { ...stage(), assetUrl: `/api/import/assets/${id}/crop.png` }, garment: stage(), modeled: stage() } });
  });
  const jobs = await new Jobs(store, codex, path.join(root, "state")).init(); t.after(() => jobs.close());
  const job = await store.job(id);
  assert.equal(job.status, "active"); assert.equal(job.stages.analysis.status, "failed");
  assert.equal(job.stages.analysis.freshGeneration, true); assert.equal(codex.calls.length, 0);
  if (recovery === "manual") assert.equal((await jobs.manual(id)).stages.crop.status, "review");
  else {
    await store.lock(async () => { const current = await store.job(id); current.stages.analysis.status = "queued"; await store.saveJob(current); });
    await until(async () => (await store.job(id)).status === "complete");
    const children = (await store.jobs()).filter((j) => j.parentId === id);
    assert.equal(children.length, 1); assert.match(children[0].id, /^[a-f0-9-]{36}$/);
    assert.equal(children[0].stages.crop.status, "review"); assert.equal(children[0].noClothingDetected, false);
    assert.equal(codex.calls.length, 1);
  }
});

test("restart marks uncertain requests failed but recovers completed image bytes without another AI call", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init(); const codex = new FakeCodex(root); const state = path.join(root, "state");
  const ids = ["11111111-1111-4111-a111-111111111111", "22222222-2222-4222-a222-222222222222"];
  await store.lock(async () => { for (const id of ids) { await mkdir(store.file(`jobs/${id}`)); await store.saveJob({ id, kind: "import", status: "active", metadata: { name: "Tee", color: "#b72b30" }, stages: { garment: { ...stage("processing"), attempts: 1 } }, createdAt: now() }); } });
  await mkdir(path.join(state, "receipts"), { recursive: true });
  const filename = `${ids[1]}-garment-1.png`; await atomicWrite(path.join(state, "receipts", filename), await cutout());
  await atomicJson(path.join(state, "receipts", `${ids[1]}-garment-1.json`), { type: "image", file: filename });
  const jobs = await new Jobs(store, codex, state).init(); t.after(() => jobs.close());
  assert.equal((await store.job(ids[0])).stages.garment.status, "failed");
  await until(async () => (await store.job(ids[1])).stages.garment.status === "review");
  assert.equal(codex.calls.length, 0); assert.ok(await readFile(store.file(`jobs/${ids[1]}/garment-1-source.png`)));
});

test("restored data can finalize a raw image without the operational volume or ChatGPT login", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init(); const codex = new FakeCodex(root); codex.status.connected = false;
  const id = "33333333-3333-4333-a333-333333333333";
  await store.lock(async () => {
    await mkdir(store.file(`jobs/${id}`)); await store.asset(`jobs/${id}/garment-1-source.png`, await cutout());
    await store.saveJob({ id, kind: "import", status: "active", metadata: { name: "Tee", color: "#b72b30" }, stages: { garment: { ...stage("processing"), attempts: 1, rawAsset: "garment-1-source.png" } }, createdAt: now() });
  });
  const jobs = await new Jobs(store, codex, path.join(root, "fresh-state")).init(); t.after(() => jobs.close());
  await until(async () => (await store.job(id)).stages.garment.status === "review"); assert.equal(codex.calls.length, 0);
});

test("modeled photos can be added to a legacy item without changing its ID or creating duplicates", async (t) => {
  const app = await testApp(t);
  await app.store.lock(async () => { await app.store.asset("imported/legacy.png", await cutout()); await app.store.write("library.json", [{ id: "legacy-top", name: "Original", part: "upperbody", color: "#b72b30", tags: [], image: "/api/import/library/legacy.png" }]); });
  const form = new FormData(); form.append("image", new Blob([await photo()], { type: "image/png" }), "identity.png"); await app.api("/api/reference", "POST", form);
  const queued = await app.api("/api/import/wardrobe/legacy-top/generate-modeled", "POST"); assert.equal(queued.status, 202);
  await app.api("/api/import/wardrobe/legacy-top", "PATCH", { name: "Edited on another device" });
  await until(async () => (await app.store.job(queued.value.id)).stages.modeled.status === "review");
  assert.equal((await app.approveImport(queued.value.id, "modeled")).status, 200);
  const library = (await app.api("/api/import/wardrobe")).value; assert.equal(library.length, 1); assert.equal(library[0].id, "legacy-top"); assert.equal(library[0].name, "Edited on another device"); assert.ok(library[0].modeledImage);
});

test("deleting a piece cancels its modeled job and stale approval cannot resurrect it", async (t) => {
  const app = await testApp(t);
  await app.store.lock(async () => { await app.store.asset("imported/legacy.png", await cutout()); await app.store.write("library.json", [{ id: "legacy-top", name: "Top", part: "upperbody", color: "#b72b30", tags: [], image: "/api/import/library/legacy.png" }]); });
  const form = new FormData(); form.append("image", new Blob([await photo()], { type: "image/png" }), "identity.png"); await app.api("/api/reference", "POST", form);
  const queued = await app.api("/api/import/wardrobe/legacy-top/generate-modeled", "POST");
  await until(async () => (await app.store.job(queued.value.id)).stages.modeled.status === "review");
  assert.equal((await app.api("/api/import/wardrobe/legacy-top", "DELETE")).status, 200);
  assert.equal((await app.store.job(queued.value.id)).status, "cancelled");
  assert.equal((await app.approveImport(queued.value.id, "modeled")).status, 409);
  assert.deepEqual((await app.api("/api/import/wardrobe")).value, []);
});

test("outfits validate IDs/combinations and modeled approval preserves wardrobe edits", async (t) => {
  const app = await testApp(t);
  await app.store.lock(async () => {
    await app.store.asset("imported/top.png", await cutout()); await app.store.asset("imported/bottom.png", await cutout());
    await app.store.write("library.json", [{ id: "top", name: "Top", part: "upperbody", color: "#b72b30", tags: [], image: "/api/import/library/top.png" }, { id: "bottom", name: "Bottom", part: "lowerbody", color: "#222222", tags: [], image: "/api/import/library/bottom.png" }]);
  });
  app.codex.result = { outfits: [{ name: "Tonal look", garmentIds: ["top", "bottom"], reason: "Balanced", setting: "Courtyard", occasion: ["casual"] }] };
  const result = await app.api("/api/outfits", "POST", { count: 1 }); assert.equal(result.status, 202);
  await until(async () => (await app.store.job(result.value.id)).status === "complete");
  const outfit = (await app.api("/api/outfits")).value[0]; assert.deepEqual(outfit.garmentIds, ["top", "bottom"]);
  assert.equal((await app.api(`/api/outfits/${outfit.id}/generate`, "POST")).status, 422);
  const form = new FormData(); form.append("image", new Blob([await photo()], { type: "image/png" }), "reference.png"); await app.api("/api/reference", "POST", form);
  const generated = await app.api(`/api/outfits/${outfit.id}/generate`, "POST");
  await until(async () => (await app.store.job(generated.value.id)).stages.modeled.status === "review");
  await until(async () => (await app.store.json("outfits.json", [])).find((o) => o.id === outfit.id)?.reviewImage);
  const approved = await app.approveOutfit(outfit.id); assert.equal(approved.status, 200); assert.equal(approved.value.status, "accepted");
  const duplicate = await app.api("/api/outfits", "POST", { count: 1 }); assert.equal(duplicate.status, 422);
  assert.equal((await app.api("/api/outfits")).value.length, 1);
});
