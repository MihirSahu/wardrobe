import test from "node:test";
import assert from "node:assert/strict";
import { validateOutfits } from "../server/schemas.mjs";
import { cutout, testApp, until } from "./helpers.mjs";

const inventory = [
  { id: "top", name: "Top", part: "upperbody", color: "#b72b30", tags: [], image: "/api/import/library/top.png" },
  { id: "bottom", name: "Bottom", part: "lowerbody", color: "#222222", tags: [], image: "/api/import/library/bottom.png" },
];
const look = (garmentIds = ["top", "bottom"]) => ({ name: "Tonal look", garmentIds, reason: "Balanced", setting: "Courtyard", occasion: ["casual"] });
async function seedInventory(app) {
  await app.store.lock(async () => {
    for (const item of inventory) await app.store.asset(`imported/${item.id}.png`, await cutout());
    await app.store.write("library.json", inventory);
  });
}

test("outfit validation preserves count, ID, composition and combination checks", () => {
  const value = { outfits: [look()] };
  assert.deepEqual(validateOutfits(value, inventory, 1), value.outfits);
  assert.throws(() => validateOutfits({ outfits: [look(["top", "bottom", "top"])] }, inventory, 1), { status: 422, message: "Each outfit must use distinct garment IDs" });
  assert.throws(() => validateOutfits(value, inventory, 2), { status: 422, message: "Expected 2 outfits, received 1" });
  assert.throws(() => validateOutfits({ outfits: [look(["top", "missing"])] }, inventory, 1), { status: 422, message: "Outfit references a missing garment" });
  assert.throws(() => validateOutfits(value, [inventory[0], { ...inventory[1], part: "upperbody" }], 1), { status: 422, message: "Each outfit needs one top, one bottom, and at most one of each supporting piece" });
  assert.throws(() => validateOutfits(value, inventory, 1, [look(["bottom", "top"])]), { status: 422, message: "Codex proposed duplicate garment combinations" });
  assert.throws(() => validateOutfits({ outfits: [look(), look(["bottom", "top"])] }, inventory, 2), { status: 422, message: "Codex proposed duplicate garment combinations" });
});

test("curation rejects repeated garment IDs without saving outfits", async (t) => {
  const app = await testApp(t); await seedInventory(app);
  app.codex.result = { outfits: [look(["top", "bottom", "top"])] };
  const queued = await app.api("/api/outfits", "POST", { count: 1 });
  assert.equal(queued.status, 202);
  await until(async () => (await app.store.job(queued.value.id)).stages.analysis.status === "failed");
  const failed = await app.store.job(queued.value.id);
  assert.equal(failed.stages.analysis.error, "Each outfit must use distinct garment IDs");
  assert.equal(failed.stages.analysis.freshGeneration, true);
  assert.deepEqual((await app.api("/api/outfits")).value, []);
});

test("curation retries a schema rejection with a compatible schema and saves valid outfits", async (t) => {
  const app = await testApp(t); await seedInventory(app);
  app.codex.result = { outfits: [look()] };
  const run = app.codex.run.bind(app.codex); let attempts = 0;
  app.codex.run = async (request) => {
    if (++attempts === 1) throw Object.assign(new Error("Invalid schema for response_format 'codex_output_schema': 'uniqueItems' is not permitted."), { status: 400 });
    assert.doesNotMatch(JSON.stringify(request.schema), /"uniqueItems"\s*:/);
    return run(request);
  };
  const queued = await app.api("/api/outfits", "POST", { count: 1 });
  assert.equal(queued.status, 202);
  await until(async () => (await app.store.job(queued.value.id)).stages.analysis.status === "failed");
  assert.match((await app.store.job(queued.value.id)).stages.analysis.error, /uniqueItems/);
  assert.deepEqual((await app.api("/api/outfits")).value, []);
  const retried = await app.api(`/api/import/jobs/${queued.value.id}/stages/analysis/retry`, "POST", {});
  assert.equal(retried.status, 200);
  await until(async () => (await app.store.job(queued.value.id)).status === "complete");
  const saved = (await app.api("/api/outfits")).value;
  assert.equal(attempts, 2); assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].garmentIds, ["top", "bottom"]);
  assert.equal(saved[0].status, "suggested");
  assert.equal((await app.store.job(queued.value.id)).stages.analysis.error, null);
});
