import test from "node:test";
import assert from "node:assert/strict";
import { testApp, cutout, photo, until } from "./helpers.mjs";

async function replacement(app, id, stage) {
  const form = new FormData(); form.append("image", new Blob([await cutout()], { type: "image/png" }), "replacement.png");
  const result = await app.api(`/api/import/jobs/${id}/stages/${stage}/upload`, "POST", form);
  assert.equal(result.status, 200); return result.value;
}

for (const stage of ["crop", "garment", "modeled"]) test(`${stage} approval requires the reviewed image and rejects another device's replacement`, async (t) => {
  const app = await testApp(t); app.jobs.stopped = true;
  const id = (await app.upload()).value.jobs[0].id;
  if (stage !== "crop") await replacement(app, id, "garment");
  if (stage === "modeled") { assert.equal((await app.approveImport(id, "garment")).status, 200); await replacement(app, id, "modeled"); }
  const viewed = (await app.store.job(id)).stages[stage].assetUrl;
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/${stage}/approve`, "POST")).status, 409);
  if (stage === "crop") assert.equal((await app.api(`/api/import/jobs/${id}/metadata`, "PATCH", { metadata: { boundingBox: { x: 80, y: 80, width: 500, height: 600 } } })).status, 200);
  else await replacement(app, id, stage);
  const latest = (await app.store.job(id)).stages[stage].assetUrl; assert.notEqual(latest, viewed);
  const before = await app.store.json("library.json", []);
  const rejected = await app.api(`/api/import/jobs/${id}/stages/${stage}/approve`, "POST", { reviewedAssetUrl: viewed });
  assert.equal(rejected.status, 409); assert.match(rejected.value.error, /image changed/);
  assert.deepEqual(await app.store.json("library.json", []), before);
  assert.equal((await app.store.job(id)).stages[stage].status, "review");
  assert.equal((await app.approveImport(id, stage)).status, 200);
});

test("approval metadata does not silently advance to an unseen replacement", async (t) => {
  const app = await testApp(t); app.jobs.stopped = true;
  const id = (await app.upload()).value.jobs[0].id;
  const viewed = (await replacement(app, id, "garment")).stages.garment.assetUrl;
  await replacement(app, id, "garment");
  const before = (await app.store.job(id)).metadata;
  const result = await app.api(`/api/import/jobs/${id}/metadata`, "PATCH", { metadata: { name: "Stale approval edit" }, reviewedStage: "garment", reviewedAssetUrl: viewed });
  assert.equal(result.status, 409); assert.deepEqual((await app.store.job(id)).metadata, before);
});

test("crop approval uses its committed edit and rejects changes between metadata save and approval", async (t) => {
  const app = await testApp(t); app.jobs.stopped = true;
  const id = (await app.upload()).value.jobs[0].id;
  const viewed = (await app.store.job(id)).stages.crop.assetUrl;
  const lock = app.store.lock.bind(app.store); let committed, release; let first = true;
  const reached = new Promise((resolve) => { committed = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  app.store.lock = async (fn) => {
    const hold = first; first = false; const result = await lock(fn);
    if (hold) { committed(); await gate; }
    return result;
  };
  const pending = app.api(`/api/import/jobs/${id}/metadata`, "PATCH", { metadata: { boundingBox: { x: 80, y: 80, width: 500, height: 600 } }, reviewedStage: "crop", reviewedAssetUrl: viewed });
  await reached;
  const edited = (await app.store.job(id)).stages.crop.assetUrl;
  try { assert.equal((await app.api(`/api/import/jobs/${id}/metadata`, "PATCH", { metadata: { boundingBox: { x: 100, y: 100, width: 700, height: 700 } } })).status, 200); }
  finally { release(); }
  const saved = await pending; assert.equal(saved.status, 200);
  assert.equal(saved.value.stages.crop.assetUrl, edited, "Response must describe the saved edit, not a later remote crop");
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/crop/approve`, "POST", { reviewedAssetUrl: edited })).status, 409);
  assert.equal((await app.approveImport(id, "crop")).status, 200);
});

test("outfit approval rejects an older modeled result and accepts the latest review", async (t) => {
  const app = await testApp(t);
  await app.store.lock(async () => {
    await app.store.asset("imported/top.png", await cutout()); await app.store.asset("imported/bottom.png", await cutout());
    await app.store.write("library.json", [
      { id: "top", name: "Top", part: "upperbody", color: "#b72b30", tags: [], image: "/api/import/library/top.png" },
      { id: "bottom", name: "Bottom", part: "lowerbody", color: "#222222", tags: [], image: "/api/import/library/bottom.png" },
    ]);
  });
  const form = new FormData(); form.append("image", new Blob([await photo()], { type: "image/png" }), "identity.png");
  assert.equal((await app.api("/api/reference", "POST", form)).status, 200);
  app.codex.result = { outfits: [{ name: "Look", garmentIds: ["top", "bottom"], reason: "Balanced", setting: "Courtyard", occasion: ["casual"] }] };
  const curation = await app.api("/api/outfits", "POST", { count: 1, generateModeled: true });
  assert.equal(curation.status, 202);
  const first = await until(async () => (await app.store.json("outfits.json", [])).find((o) => o.reviewImage));
  assert.equal((await app.api(`/api/outfits/${first.id}/generate`, "POST")).status, 200);
  const next = await until(async () => (await app.store.json("outfits.json", [])).find((o) => o.id === first.id && o.reviewImage && o.reviewImage !== first.reviewImage));
  assert.equal((await app.api(`/api/outfits/${first.id}/approve`, "POST", { reviewedAssetUrl: first.reviewImage })).status, 409);
  assert.equal((await app.store.json("outfits.json", []))[0].reviewImage, next.reviewImage);
  assert.equal((await app.approveOutfit(first.id)).status, 200);
});

test("cleanup acceptance is bound to its reviewed raw source", async (t) => {
  const app = await testApp(t); app.jobs.stopped = true; const id = (await app.upload()).value.jobs[0].id;
  await app.store.lock(async () => {
    const job = await app.store.job(id); await app.store.asset(`jobs/${id}/new-source.png`, await photo());
    Object.assign(job.stages.garment, { status: "failed", rawAsset: "new-source.png", chromaKey: "#00ff00" }); await app.store.saveJob(job);
  });
  const result = await app.api(`/api/import/jobs/${id}/stages/garment/cleanup-accept`, "POST", { tolerance: 46, reviewedRawAsset: "old-source.png" });
  assert.equal(result.status, 409); assert.equal((await app.store.job(id)).stages.garment.status, "failed");
});
