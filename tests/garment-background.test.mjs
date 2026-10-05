import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { imageOperation } from "../server/images.mjs";
import { chooseChromaKey } from "../server/image-ops.mjs";
import { testApp, until } from "./helpers.mjs";

async function source({ alpha = 255, padding = false, transparent = false, detail = false, key = "#00ff00" } = {}) {
  const rgb = [1, 3, 5].map((offset) => parseInt(key.slice(offset, offset + 2), 16));
  const pixels = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 4; const garment = x >= 16 && x < 48 && y >= 8 && y < 56;
    const color = garment && !(detail && x >= 24 && x < 32 && y >= 24 && y < 40) ? [183, 43, 48] : rgb;
    pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2];
    pixels[i + 3] = !garment && (transparent || padding && (x < 4 || x >= 60 || y < 4 || y >= 60)) ? 0 : 255;
    if (transparent && garment && x === 16) pixels[i + 3] = 180;
  }
  pixels[3] = alpha;
  return sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer();
}
async function greenPixels(bytes) {
  const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); let count = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 8 && data[i] < 5 && data[i + 1] > 250 && data[i + 2] < 5) count++;
  return count;
}

test("one alpha-254 or alpha-zero pixel does not bypass chroma background removal", async () => {
  for (const alpha of [254, 0]) {
    const result = await imageOperation("garment", await source({ alpha }), { key: "#00ff00" });
    assert.equal(result.chromaKey, "#00ff00"); assert.equal(await greenPixels(result.bytes), 0);
    assert.equal(result.verification.contaminatedPixels, 0);
  }
});

test("transparent padding cannot disguise a chroma background as a native cutout", async () => {
  const result = await imageOperation("garment", await source({ alpha: 0, padding: true }), { key: "#00ff00" });
  assert.equal(result.chromaKey, "#00ff00"); assert.equal(await greenPixels(result.bytes), 0);
});

test("native cutouts preserve translucent edges and garment details matching the chroma color", async () => {
  const result = await imageOperation("garment", await source({ alpha: 0, transparent: true, detail: true }), { key: "#00ff00" });
  assert.equal(result.chromaKey, undefined); assert.ok(await greenPixels(result.bytes) > 100);
  const { data } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(data.some((v, i) => i % 4 === 3 && v === 0));
  assert.ok(data.some((v, i) => i % 4 === 3 && v > 8 && v < 255));
});

test("opaque non-chroma sources fail rather than passing because framing adds transparent margins", async () => {
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } }).png().toBuffer();
  await assert.rejects(imageOperation("garment", bytes, { key: "#00ff00" }), /no clear transparent or chroma background/);
});

test("the queued import saves and exposes cleanup for a partial-alpha chroma output", async (t) => {
  const app = await testApp(t); const id = (await app.upload()).value.jobs[0].id;
  const key = chooseChromaKey((await app.store.job(id)).metadata.color);
  app.codex.run = async (request) => request.onImage(await source({ alpha: 254, key }), { type: "imageGeneration", status: "completed" });
  assert.equal((await app.approveImport(id, "crop")).status, 200);
  const reviewed = await until(async () => { const job = await app.store.job(id); return job.stages.garment.status === "review" && job; });
  assert.equal(reviewed.stages.garment.chromaKey, key); assert.ok(reviewed.stages.garment.rawAsset);
  assert.equal(reviewed.stages.garment.cleanupDiagnostics.contaminatedPixels, 0);
  const approved = await app.approveImport(id, "garment"); assert.equal(approved.status, 200);
  assert.equal(await greenPixels(await readFile(await app.jobs.assetPath(approved.value.record.image))), 0);
});
