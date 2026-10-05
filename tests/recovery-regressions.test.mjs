import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Store, stage, now, atomicJson } from "../server/store.mjs";
import { Jobs } from "../server/jobs.mjs";
import { testApp, until, fixture, FakeCodex, cutout } from "./helpers.mjs";

async function replaceOperationalState(t, app) {
  await app.jobs.close();
  // A fresh runner observes the same data writes made by the API.
  const jobs = await new Jobs(app.store, app.codex, path.join(app.root, "replacement-state")).init();
  t.after(() => jobs.close());
  return jobs;
}

test("data-only restore reuses an image after its raw pointer failed to persist", async (t) => {
  const app = await testApp(t); const id = (await app.upload()).value.jobs[0].id;
  const save = app.store.saveJob.bind(app.store); let injected = false;
  app.store.saveJob = async (job) => {
    if (!injected && job.id === id && job.stages.garment.rawAsset) { injected = true; throw new Error("Simulated metadata write failure"); }
    return save(job);
  };
  await app.approveImport(id, "crop");
  await until(async () => (await app.store.job(id)).stages.garment.status === "failed");
  assert.equal(injected, true); assert.equal(app.codex.calls.length, 1);
  assert.ok((await readFile(app.store.file(`jobs/${id}/garment-1-source.png`))).length);
  assert.equal((await app.store.job(id)).stages.garment.rawAsset, undefined);
  await replaceOperationalState(t, app);
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/retry`, "POST")).status, 200);
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
  assert.equal(app.codex.calls.length, 1);
});

test("data-only restore reuses analysis after its result pointer failed to persist", async (t) => {
  const app = await testApp(t); const save = app.store.saveJob.bind(app.store); let injected = false;
  app.store.saveJob = async (job) => {
    if (!injected && job.stages.analysis.result) { injected = true; throw new Error("Simulated result pointer failure"); }
    return save(job);
  };
  const id = (await app.upload(false)).value.jobs[0].id;
  await until(async () => (await app.store.job(id)).stages.analysis.status === "failed");
  assert.equal(injected, true); assert.equal(app.codex.calls.length, 1);
  assert.ok((await readFile(app.store.file(`jobs/${id}/attempt-analysis-1-result.json`))).length);
  assert.equal((await app.store.job(id)).stages.analysis.result, null);
  await replaceOperationalState(t, app);
  await app.api(`/api/import/jobs/${id}/stages/analysis/retry`, "POST");
  await until(async () => (await app.store.job(id)).stages.analysis.status === "complete");
  assert.equal(app.codex.calls.length, 1);
  assert.equal((await app.api("/api/import/jobs")).value[0].stages.crop.status, "review");
});

test("explicit regeneration ignores completed outputs from the previous attempt", async (t) => {
  const app = await testApp(t); const id = (await app.upload()).value.jobs[0].id;
  await app.approveImport(id, "crop");
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
  await app.api(`/api/import/jobs/${id}/stages/garment/regenerate`, "POST", { prompt: "Change the presentation" });
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
  assert.equal(app.codex.calls.length, 2);
  assert.equal((await app.store.job(id)).stages.garment.attempts, 2);
});

test("one broken saved output fails its job while unrelated imports continue", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init(); const codex = new FakeCodex(root);
  const broken = "11111111-1111-4111-a111-111111111111", good = "22222222-2222-4222-a222-222222222222";
  await store.lock(async () => {
    for (const [id, createdAt] of [[broken, "2026-01-01T00:00:00Z"], [good, "2026-01-02T00:00:00Z"]]) {
      await mkdir(store.file(`jobs/${id}`)); await store.asset(`jobs/${id}/crop.png`, await cutout());
      await store.saveJob({ id, kind: "import", status: "active", metadata: { name: "Tee", color: "#b72b30" }, internal: { cropFile: "crop.png" }, createdAt,
        stages: { garment: { ...stage("queued"), attempts: 1, ...(id === broken ? { rawAsset: "missing.png" } : {}) } } });
    }
  });
  const jobs = await new Jobs(store, codex, path.join(root, "state")).init(); t.after(() => jobs.close());
  await until(async () => (await store.job(good)).stages.garment.status === "review");
  assert.equal((await store.job(broken)).stages.garment.status, "failed");
  assert.match((await store.job(broken)).stages.garment.error, /Could not recover saved output/);
  assert.equal(codex.calls.length, 1);
});

test("receipt metadata with a missing operational PNG recovers from data", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init(); const codex = new FakeCodex(root); codex.status.connected = false;
  const id = "33333333-3333-4333-a333-333333333333"; const state = path.join(root, "state");
  await store.lock(async () => {
    await mkdir(store.file(`jobs/${id}`)); await store.asset(`jobs/${id}/garment-1-source.png`, await cutout());
    await store.saveJob({ id, kind: "import", status: "active", metadata: { name: "Tee", color: "#b72b30" }, stages: { garment: { ...stage("processing"), attempts: 1 } }, createdAt: now() });
  });
  await atomicJson(path.join(state, "receipts", `${id}-garment-1.json`), { type: "image", file: `${id}-garment-1.png` });
  const jobs = await new Jobs(store, codex, state).init(); t.after(() => jobs.close());
  await until(async () => (await store.job(id)).stages.garment.status === "review");
  assert.equal(codex.calls.length, 0);
});

test("a corrupt receipt at restart fails only its affected stage", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init(); const codex = new FakeCodex(root);
  const id = "55555555-5555-4555-a555-555555555555"; const state = path.join(root, "state");
  await store.lock(async () => {
    await mkdir(store.file(`jobs/${id}`));
    await store.saveJob({ id, kind: "import", status: "active", createdAt: now(), stages: { garment: { ...stage("processing"), attempts: 1 } } });
  });
  await atomicJson(path.join(state, "receipts", `${id}-garment-1.json`), { type: "image", file: `${id}-garment-1.png` });
  await mkdir(path.join(state, "receipts", `${id}-garment-1.png`));
  const jobs = await new Jobs(store, codex, state).init(); t.after(() => jobs.close());
  assert.equal((await store.job(id)).stages.garment.status, "failed");
  assert.match((await store.job(id)).stages.garment.error, /Could not recover saved output/);
  assert.equal(codex.calls.length, 0);
});

test("legacy failed chroma imports remain locally cleanable after migration", async (t) => {
  const app = await testApp(t); await app.jobs.close();
  const id = "44444444-4444-4444-a444-444444444444";
  const otherId = "66666666-6666-4666-a666-666666666666";
  await app.store.lock(async () => {
    await mkdir(app.store.file(`jobs/${id}`)); await app.store.asset(`jobs/${id}/garment-1-source.png`, await cutout());
    await app.store.saveJob({ id, status: "active", metadata: { name: "Legacy tee", color: "#b72b30" }, internal: { originalFile: "original.png", cropFile: "crop.png" }, createdAt: now(),
      stages: { crop: stage("approved"), garment: { ...stage("failed"), attempts: 1, chromaKey: "#00ff00", failedAssetUrl: `/api/import/assets/${id}/garment-1-source.png` }, modeled: stage() } });
    await mkdir(app.store.file(`jobs/${otherId}`));
    const other = structuredClone(await app.store.job(id)); other.id = otherId;
    await app.store.saveJob(other);
  });
  const jobs = await new Jobs(app.store, app.codex, path.join(app.root, "migration-state")).init(); t.after(() => jobs.close());
  assert.equal((await app.store.job(id)).stages.garment.rawAsset, "garment-1-source.png");
  assert.equal((await app.store.job(otherId)).stages.garment.rawAsset, undefined, "Migration must not reuse another import's source");
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/cleanup-preview`, "POST", { tolerance: 46 })).status, 200);
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/cleanup-accept`, "POST", { tolerance: 46, reviewedRawAsset: "garment-1-source.png" })).status, 200);
  assert.equal((await app.store.job(id)).stages.garment.status, "review");
  assert.equal(app.codex.calls.length, 0);
});
