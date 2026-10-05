import test from "node:test";
import assert from "node:assert/strict";
import { failedImageStage, canCleanGarment } from "../src/import-recovery.mjs";
import { uploadPhotoBatch } from "../src/upload-batch.mjs";
import { testApp, photo, cutout, until } from "./helpers.mjs";

const form = (bytes, name = "replacement.png") => {
  const result = new FormData(); result.append("image", new Blob([bytes], { type: "image/png" }), name); result.append("manual", "true"); return result;
};
async function failedGarment(app) {
  let calls = 0;
  app.codex.run = async (request) => { calls++; await request.onImage(await (calls === 1 ? photo() : cutout()), { type: "imageGeneration", status: "completed" }); };
  const id = (await app.upload()).value.jobs[0].id;
  assert.equal((await app.approveImport(id, "crop")).status, 200);
  const job = await until(async () => { const job = await app.store.job(id); return job.stages.garment.status === "failed" && job; });
  assert.match(job.stages.garment.error, /no clear transparent or chroma background/);
  assert.equal(failedImageStage(job), "garment"); assert.equal(canCleanGarment(job), false);
  return { id, calls: () => calls };
}

test("a rejected garment can regenerate a new output rather than retrying the invalid receipt", async (t) => {
  const app = await testApp(t); const { id, calls } = await failedGarment(app);
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/retry`, "POST")).status, 200);
  await until(async () => (await app.store.job(id)).stages.garment.status === "failed"); assert.equal(calls(), 1);
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/regenerate`, "POST", { prompt: "Use a transparent background" })).status, 200);
  const fresh = await until(async () => { const job = await app.store.job(id); return job.stages.garment.status === "review" && job; });
  assert.equal(calls(), 2); assert.equal(fresh.stages.garment.prompt, "Use a transparent background");
  assert.equal(failedImageStage(fresh), null);
  assert.equal((await app.approveImport(id, "garment")).status, 200);
  assert.equal((await app.store.json("library.json", [])).length, 1);
});

test("a rejected garment can use a replacement without another generation", async (t) => {
  const app = await testApp(t); const { id, calls } = await failedGarment(app);
  const replaced = await app.api(`/api/import/jobs/${id}/stages/garment/upload`, "POST", form(await cutout()));
  assert.equal(replaced.status, 200); assert.equal(replaced.value.stages.garment.status, "review");
  assert.equal(replaced.value.stages.garment.rawAsset, null); assert.equal(replaced.value.stages.garment.failedAssetUrl, null);
  assert.equal((await app.approveImport(id, "garment")).status, 200); assert.equal(calls(), 1);
});

for (const action of ["regenerate", "upload"]) test(`${action} invalidates the previous chroma cleanup source and preview`, async (t) => {
  const app = await testApp(t); app.jobs.stopped = true;
  const id = (await app.upload()).value.jobs[0].id;
  await app.store.lock(async () => {
    const job = await app.store.job(id); job.stages.crop.status = "approved";
    await app.store.asset(`jobs/${id}/old-source.png`, await photo());
    Object.assign(job.stages.garment, { status: "failed", rawAsset: "old-source.png", failedAssetUrl: `/api/import/assets/${id}/old-source.png`, chromaKey: "#00ff00", cleanupPreviewUrl: "old-preview", cleanupDiagnostics: { contaminatedPixels: 4 }, cleanupTolerance: 50 });
    assert.equal(canCleanGarment(job), true); await app.store.saveJob(job);
  });
  const result = await app.api(`/api/import/jobs/${id}/stages/garment/${action}`, "POST", action === "upload" ? form(await cutout()) : {});
  assert.equal(result.status, 200);
  for (const field of ["rawAsset", "failedAssetUrl", "chromaKey", "cleanupPreviewUrl", "cleanupDiagnostics", "cleanupTolerance"]) assert.equal(result.value.stages.garment[field], null);
  const stale = await app.api(`/api/import/jobs/${id}/stages/garment/cleanup-accept`, "POST", { reviewedRawAsset: "old-source.png" }); assert.equal(stale.status, 409);
  if (action === "regenerate") {
    app.codex.run = async (request) => request.onImage(await photo(), { type: "imageGeneration", status: "completed" });
    app.jobs.stopped = false; await app.jobs.pump();
    const failed = await app.store.job(id); assert.equal(failed.stages.garment.status, "failed"); assert.equal(canCleanGarment(failed), false);
  }
});

test("modeled failures without saved images also expose image recovery", async (t) => {
  const app = await testApp(t);
  assert.equal((await app.api("/api/reference", "POST", form(await photo()))).status, 200);
  const id = (await app.upload()).value.jobs[0].id;
  assert.equal((await app.approveImport(id, "crop")).status, 200);
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
  app.codex.run = async () => { throw new Error("Image generation unavailable"); };
  assert.equal((await app.approveImport(id, "garment", { generateModeled: true })).status, 200);
  const failed = await until(async () => { const job = await app.store.job(id); return job.stages.modeled.status === "failed" && job; });
  assert.equal(failedImageStage(failed), "modeled"); assert.equal(canCleanGarment(failed), false); assert.equal(failed.stages.modeled.assetUrl, null);
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/modeled/upload`, "POST", form(await photo()))).status, 200);
  assert.equal((await app.approveImport(id, "modeled")).status, 200);
  assert.ok((await app.store.json("library.json", []))[0].modeledImage);
});

test("partial photo batches retain only failed and unattempted files and retry without duplicate jobs", async (t) => {
  const app = await testApp(t); app.jobs.stopped = true;
  const first = { file: { bytes: await photo(), name: "first.png" } };
  const second = { file: { bytes: Buffer.from("invalid image"), name: "second.heic" } };
  const third = { file: { bytes: await photo(), name: "third.png" } };
  let pending = [first, second, third];
  const upload = async (file) => { const response = await app.api("/api/import/jobs", "POST", form(file.bytes, file.name)); if (response.status !== 202) throw new Error(response.value.error); return response.value; };
  const acknowledge = (photo) => { pending = pending.filter((p) => p !== photo); };
  await assert.rejects(uploadPhotoBatch(pending, upload, acknowledge), /Could not decode/);
  assert.deepEqual(pending, [second, third]); assert.equal((await app.store.jobs()).length, 1);
  second.file.bytes = await photo(); await uploadPhotoBatch(pending, upload, acknowledge);
  assert.deepEqual(pending, []);
  const jobs = await app.store.jobs(); assert.equal(jobs.length, 3); assert.equal(jobs.filter((j) => j.internal.uploadName === "first.png").length, 1);
});
