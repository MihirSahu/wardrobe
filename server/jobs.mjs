import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { atomicJson, atomicWrite, fail, now, stage, publicJob, readJson } from "./store.mjs";
import { imageOperation, normalize } from "./images.mjs";
import { normalizeMetadata, buildGarmentPrompt, chooseChromaKey } from "./image-ops.mjs";
import { clothesSchema, outfitsSchema, validate, validateOutfits } from "./schemas.mjs";
import { safeError } from "./codex.mjs";

const assetUrl = (id, file) => `/api/import/assets/${id}/${file}`;
const modeledPrompt = "Generate exactly one square editorial fashion photograph. Image 1 is the identity reference; preserve recognizable face, hair, age, build and body proportions. The remaining images are exact garments: preserve their colors, textures, fit, graphics, logos, proportions and construction. Show the complete person from head to shoes, every featured garment clearly visible, realistic anatomy, natural light and a tasteful real-world setting. Use only understated neutral supporting basics where needed. Do not invent openings, closures, text, watermarks or another person. Use the native image generation tool; return the image, not a written prompt.";

function emptyDetection(job) {
  job.status = "active"; job.noClothingDetected = true; job.progress = null;
  if (!job.childIds?.length) delete job.childIds;
  Object.assign(job.stages.analysis, { status: "failed", error: "No clothing detected. Enter details manually, retry analysis, or choose another photo.", freshGeneration: true });
}

async function checkpointOutput(saveReceipt, saveData) {
  let receiptError;
  try { await saveReceipt(); } catch (error) { receiptError = error; }
  // The separate state volume must not prevent completed output reaching backups.
  await saveData();
  if (receiptError) throw receiptError;
}

export class Jobs {
  constructor(store, codex, stateDir, log = () => {}) {
    this.log = log;
    this.store = store; this.codex = codex; this.stateDir = stateDir; this.receipts = path.join(stateDir, "receipts");
    this.status = { active: null, paused: false, reason: null }; this.stopped = true;
    this.onChange = () => { setImmediate(() => { void this.pump().catch((error) => this.log("queue", "error", { error })); }); };
    store.on("change", this.onChange);
    this.onConnection = () => { if (codex.status.connected && this.status.reason === "authentication") void this.resume().catch((error) => this.log("queue", "error", { error })); };
    codex.on("change", this.onConnection);
  }
  async init() {
    await mkdir(this.receipts, { recursive: true });
    Object.assign(this.status, await readJson(path.join(this.stateDir, "queue.json"), {}), { active: null });
    await this.store.lock(async () => {
      for (const job of await this.store.jobs()) {
        let changed = false;
        if (!job.kind) {
          job.kind = "import"; job.stages ||= {};
          job.stages.analysis ||= stage("complete");
          job.stages.crop ||= { ...stage("approved"), assetUrl: job.originalAssetUrl };
          changed = true;
        }
        if (job.kind === "import" && job.status === "complete" && job.noClothingDetected && !job.childIds?.length
          && job.stages.analysis?.status === "complete" && job.stages.crop?.status === "pending" && job.stages.garment?.status === "pending") {
          emptyDetection(job); changed = true;
        }
        for (const [name, value] of Object.entries(job.stages || {})) {
          if (!value.rawAsset && typeof value.failedAssetUrl === "string") {
            const prefix = `/api/import/assets/${job.id}/`;
            const filename = value.failedAssetUrl.startsWith(prefix) ? value.failedAssetUrl.slice(prefix.length) : null;
            if (filename && /^[\w-][\w.-]*\.png$/.test(filename)) {
              try { await this.store.safe(`jobs/${job.id}/${filename}`); value.rawAsset = filename; changed = true; }
              catch (error) { if (error.code !== "ENOENT") throw error; }
            }
          }
          if (value.status === "processing") {
            try {
              const receipt = await this.recoverReceipt(job, name);
              value.status = receipt ? "queued" : "failed";
              value.error = receipt ? null : "Server restarted during this request. Completion is uncertain; explicitly retry if needed.";
            } catch (error) { value.status = "failed"; value.error = `Could not recover saved output: ${safeError(error)}`; }
            changed = true;
          }
        }
        if (changed) await this.store.saveJob(job);
      }
    });
    this.stopped = false;
    this.timer = setInterval(() => { void this.pump().catch((error) => this.log("queue", "error", { error })); }, 15_000); this.timer.unref();
    this.onChange();
    return this;
  }
  receiptFile(id, name, attempt) { return path.join(this.receipts, `${id}-${name}-${attempt}.json`); }
  async recoverReceipt(job, name) {
    const value = job.stages[name];
    if (value.freshGeneration) return null;
    const file = this.receiptFile(job.id, name, value.attempts);
    const receipt = await readJson(file, null);
    if (receipt?.type === "structured") return receipt;
    if (receipt?.type === "image") {
      try { await normalize(await readFile(path.join(this.receipts, receipt.file))); return receipt; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // The atomic PNG can outlive a failed write of its companion JSON receipt.
    const saved = `${job.id}-${name}-${value.attempts}.png`;
    try {
      await normalize(await readFile(path.join(this.receipts, saved)));
      const rebuilt = { type: "image", file: saved, prompt: value.requestPrompt, revisedPrompt: value.revisedPrompt };
      await atomicJson(file, rebuilt); return rebuilt;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    // data/ alone is sufficient for recovery, even if the separate state volume is lost.
    const rawAsset = value.rawAsset || `${name}-${value.attempts}-source.png`;
    try {
      const bytes = await readFile(await this.store.safe(`jobs/${job.id}/${rawAsset}`));
      await normalize(bytes);
      await atomicWrite(path.join(this.receipts, saved), bytes);
      const rebuilt = { type: "image", file: saved, prompt: value.requestPrompt, revisedPrompt: value.revisedPrompt };
      await atomicJson(file, rebuilt); return rebuilt;
    } catch (error) { if (error.code !== "ENOENT" || value.rawAsset) throw error; }
    const result = value.result || await this.store.json(`jobs/${job.id}/attempt-${name}-${value.attempts}-result.json`, null);
    if (result) {
      const rebuilt = { type: "structured", result, prompt: value.requestPrompt };
      await atomicJson(file, rebuilt); return rebuilt;
    }
    return null;
  }
  async pause(reason, detail) {
    this.log("queue", "paused", { reason, detail });
    Object.assign(this.status, { paused: true, reason, detail });
    await atomicJson(path.join(this.stateDir, "queue.json"), { paused: true, reason, detail }); this.store.emit("queue");
  }
  async resume() {
    this.log("queue", "resumed");
    Object.assign(this.status, { paused: false, reason: null, detail: null });
    await atomicJson(path.join(this.stateDir, "queue.json"), { paused: false, reason: null }); this.store.emit("queue"); this.onChange();
  }
  async createUpload({ bytes, mime, filename, manual = false }) {
    const image = await normalize(bytes);
    const id = randomUUID();
    const metadata = normalizeMetadata({ name: filename?.replace(/\.[^.]+$/, "") || "New piece" });
    const job = { id, kind: "import", status: "active", metadata, stages: { analysis: stage(manual ? "skipped" : "queued"), crop: stage(manual ? "review" : "pending"), garment: stage(), modeled: stage() },
      createdAt: now(), updatedAt: now(), originalAssetUrl: assetUrl(id, "original.png"), internal: { originalFile: "original.png", cropFile: "crop.png", uploadName: filename, uploadMime: mime } };
    job.stages.crop.assetUrl = assetUrl(id, "crop.png");
    await this.store.lock(async () => {
      await mkdir(this.store.file(`jobs/${id}`));
      await this.store.asset(`jobs/${id}/upload.bin`, bytes);
      await this.store.asset(`jobs/${id}/original.png`, image);
      await this.store.asset(`jobs/${id}/crop.png`, image);
      await this.store.saveJob(job);
    });
    this.onChange(); return publicJob(job);
  }
  async manual(id) {
    await this.store.lock(async () => {
      const job = await this.store.job(id);
      if (job.kind !== "import" || job.stages.analysis.status === "processing" || job.stages.crop.status === "approved") throw fail("Cancel active analysis or finish it before entering the garment manually", 409);
      job.status = "active"; job.stages.analysis.status = "skipped"; job.stages.analysis.error = null;
      delete job.stages.analysis.freshGeneration;
      job.noClothingDetected = false; job.stages.crop.status = "review"; job.error = null; job.progress = null;
      await this.store.saveJob(job);
    }); return publicJob(await this.store.job(id));
  }
  async assetPath(url) {
    if (url?.startsWith("/api/import/library/")) return this.store.safe(`imported/${path.basename(url)}`);
    const match = url?.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/);
    if (match) return this.store.safe(`jobs/${match[1]}/${match[2]}`);
    throw fail("This garment has no supported local image", 422);
  }
  async curate(input) {
    const count = Number(input.count);
    if (!Number.isInteger(count) || count < 1 || count > 12) throw fail("Choose between 1 and 12 outfits");
    if (input.generateModeled && !await this.store.reference()) throw fail("Upload an identity reference in Settings first", 422);
    const records = await this.store.json("library.json", []);
    const countPart = (part) => records.filter((r) => r.part === part).length;
    const choices = countPart("upperbody") * countPart("lowerbody") * (countPart("wholebody_up") + 1) * (countPart("shoes") + 1) * (countPart("accessories_up") + 1);
    if (!choices) throw fail("Import at least one top and one bottom before creating outfits", 422);
    const inventoryIds = new Set(records.map((r) => r.id));
    const used = new Set((await this.store.json("outfits.json", [])).filter((o) => o.garmentIds.every((id) => inventoryIds.has(id))).map((o) => [...o.garmentIds].sort().join("|"))).size;
    if (choices - used < count) throw fail(`Your wardrobe supports ${Math.max(0, choices - used)} additional distinct combinations. Choose a smaller count or remove an existing suggestion.`, 422);
    const direction = {};
    for (const key of ["occasion", "season", "direction"]) direction[key] = typeof input[key] === "string" ? input[key].slice(0, 1200) : "";
    const job = { id: randomUUID(), kind: "curation", status: "active", count, direction, generateModeled: Boolean(input.generateModeled), stages: { analysis: stage("queued") }, createdAt: now() };
    await this.store.lock(async () => { await mkdir(this.store.file(`jobs/${job.id}`)); await this.store.saveJob(job); });
    return publicJob(job);
  }
  async modelItem(id) {
    let created;
    await this.store.lock(async () => {
      const item = (await this.store.json("library.json", [])).find((r) => r.id === id);
      if (!item) throw fail("Wardrobe item not found", 404);
      if (!await this.store.reference()) throw fail("Upload an identity reference in Settings first", 422);
      if ((await this.store.jobs()).some((j) => (j.itemId === id || `import-${j.id}` === id) && j.status === "active" && ["queued", "processing"].includes(j.stages.modeled?.status))) throw fail("This piece already has a modeled-photo request", 409);
      const jobId = randomUUID(); const garment = await readFile(await this.assetPath(item.image));
      created = { id: jobId, itemId: id, kind: "import", status: "active", metadata: normalizeMetadata(item), createdAt: now(), originalAssetUrl: assetUrl(jobId, "original.png"), internal: { originalFile: "original.png", cropFile: "original.png" },
        stages: { analysis: stage("skipped"), crop: { ...stage("approved"), assetUrl: assetUrl(jobId, "original.png") }, garment: { ...stage("approved"), assetUrl: assetUrl(jobId, "original.png") }, modeled: stage("queued") } };
      await mkdir(this.store.file(`jobs/${jobId}`)); await this.store.asset(`jobs/${jobId}/original.png`, garment); await this.store.saveJob(created);
    });
    return publicJob(created);
  }
  async pump() {
    if (this.running || this.stopped || this.status.paused) return;
    this.running = true;
    let processed = false;
    try {
      const candidate = (await this.store.jobs()).filter((j) => j.status === "active").flatMap((j) => Object.entries(j.stages || {}).filter(([, s]) => s.status === "queued").map(([name]) => ({ job: j, name })))[0];
      if (!candidate) return;
      const { job, name } = candidate;
      // Receipts finish persistence even while ChatGPT is disconnected.
      let receipt;
      try { receipt = await this.recoverReceipt(job, name); }
      catch (error) {
        this.log("job", "recovery failed", { id: job.id, stage: name, error });
        processed = true;
        await this.store.lock(async () => {
          const current = await this.store.job(job.id);
          if (current.status === "active" && current.stages[name].status === "queued") {
            current.stages[name].status = "failed"; current.stages[name].error = `Could not recover saved output: ${safeError(error)}`;
            await this.store.saveJob(current);
          }
        });
        return;
      }
      if (!receipt) {
        await this.codex.refresh();
        if (!this.codex.status.connected) { await this.pause("authentication", this.codex.status.error || "Connect ChatGPT in Settings"); return; }
        if (this.codex.limitsExhausted()) { await this.pause("usage", "Usage limit reached. Resume after the limit resets."); return; }
      }
      this.controller = new AbortController(); this.status.active = { id: job.id, stage: name }; this.store.emit("queue");
      processed = true;
      await this.execute(job.id, name, receipt, this.controller.signal, job.stages[name]);
    } finally {
      this.status.active = null; this.controller = null; this.running = false; this.store.emit("queue");
      if (processed && !this.stopped && !this.status.paused) {
        const timer = setTimeout(this.onChange, 100); timer.unref();
      }
    }
  }
  async execute(id, name, receipt, signal, expectedStage) {
    let scratch; let attempt; let checkpointed = false;
    try {
      const claimed = await this.store.lock(async () => {
        const job = await this.store.job(id);
        if (this.stopped || this.status.paused || signal?.aborted || job.status !== "active" || job.stages[name].status !== "queued" || JSON.stringify(job.stages[name]) !== JSON.stringify(expectedStage)) return false;
        const stage = job.stages[name];
        if (!receipt) { stage.attempts += 1; stage.result = null; }
        delete stage.freshGeneration;
        attempt = stage.attempts; stage.status = "processing"; stage.error = null; stage.updatedAt = now(); await this.store.saveJob(job); return true;
      });
      if (!claimed) return;
      this.log("job", "started", { id, stage: name, attempt, recovered: Boolean(receipt) });
      let job = await this.store.job(id);
      if (!receipt) {
        await mkdir(this.codex.work, { recursive: true }); scratch = await mkdtemp(path.join(this.codex.work, "job-"));
        const { prompt, references, schema } = await this.request(job, name);
        const images = [];
        for (const [index, reference] of references.entries()) { const file = path.join(scratch, `reference-${index + 1}.png`); await copyFile(reference, file); images.push(file); }
        await this.store.lock(async () => {
          const current = await this.store.job(id); current.stages[name].requestPrompt = prompt;
          await this.store.write(`jobs/${id}/attempt-${name}-${attempt}-request.json`, { prompt, references: references.map((file) => path.relative(this.store.root, file)), requestedAt: now() });
          await this.store.saveJob(current);
        });
        const settings = await this.store.json("settings.json", {});
        let lastProgress = 0;
        const result = await this.codex.run({ scratch, prompt, images, schema, model: settings.model, signal,
          onProgress: (progress) => {
            if (Date.now() - lastProgress < 1000) return; lastProgress = Date.now();
            this.log("job", "progress", { id, stage: name, progress });
            void this.store.lock(async () => { const current = await this.store.job(id); if (current.status === "active") { current.progress = progress; await this.store.saveJob(current); } }).catch((error) => this.log("job", "progress save failed", { id, stage: name, error }));
          },
          onImage: async (bytes, item) => {
            const file = path.join(this.receipts, `${id}-${name}-${attempt}.png`);
            receipt = { type: "image", file: path.basename(file), prompt, revisedPrompt: item.revisedPrompt || null, transparentBackground: item.transparentBackground };
            await checkpointOutput(async () => {
              await atomicWrite(file, bytes); checkpointed = true;
              await atomicJson(this.receiptFile(id, name, attempt), receipt);
            }, async () => {
              await this.ingestRaw(id, name, attempt, receipt, bytes); checkpointed = true;
            });
            this.log("job", "output saved", { id, stage: name, bytes: bytes.length });
          },
        });
        if (schema) {
          receipt = { type: "structured", result, prompt };
          await checkpointOutput(async () => {
            await atomicJson(this.receiptFile(id, name, attempt), receipt); checkpointed = true;
          }, () => this.store.lock(async () => {
            const current = await this.store.job(id); current.stages[name].result = result;
            await this.store.write(`jobs/${id}/attempt-${name}-${attempt}-result.json`, result); checkpointed = true;
            await this.store.saveJob(current);
          }));
        }
      }
      job = await this.store.job(id);
      if (job.status !== "active") return;
      if (receipt?.type === "structured") await this.finishStructured(job, name, receipt);
      else if (receipt?.type === "image") { await this.ingestRaw(id, name, attempt, receipt); await this.finishImage(await this.store.job(id), name, receipt); }
      else throw new Error("No completed result was recorded");
      this.log("job", "finished", { id, stage: name });
    } catch (error) {
      this.log("job", "failed", { id, stage: name, attempt, error });
      const authentication = error.status === 401 || /unauthorized|not authenticated|authentication|sign.?in/i.test(error.message);
      const usage = error.status === 429 || /usage limit|rate limit|usageLimitExceeded|quota/i.test(error.message);
      await this.store.lock(async () => {
        const job = await this.store.job(id);
        if (job.status !== "active") return;
        const stage = job.stages[name]; stage.status = authentication || usage ? "queued" : "failed";
        if (receipt?.type === "structured" && error.status === 422) stage.freshGeneration = true;
        stage.error = safeError(error); stage.updatedAt = now(); await this.store.saveJob(job);
      });
      if (authentication || usage) await this.pause(authentication ? "authentication" : "usage", safeError(error));
    } finally {
      // Release a cancelled stage only after its native turn and output checkpointing end.
      if (attempt !== undefined) await this.store.lock(async () => {
        const job = await this.store.job(id); const state = job.stages[name];
        if (job.status === "cancelled" && state.status === "processing" && state.attempts === attempt) {
          state.status = "failed"; state.error = "Cancelled; completion may be uncertain. Explicitly retry to continue; saved output will be reused if available.";
          await this.store.saveJob(job);
        }
      });
      // Preserve scratch if neither volume could checkpoint the completed output.
      if (scratch && checkpointed) await rm(scratch, { recursive: true, force: true });
    }
  }
  async ingestRaw(id, name, attempt, receipt, sourceBytes) {
    const bytes = sourceBytes ?? await readFile(path.join(this.receipts, receipt.file));
    // Validate decoding, retaining original model output as well as normalized review image.
    await normalize(bytes);
    await this.store.lock(async () => {
      const job = await this.store.job(id);
      const filename = `${name}-${attempt}-source.png`;
      await this.store.asset(`jobs/${id}/${filename}`, bytes);
      Object.assign(job.stages[name], { rawAsset: filename, failedAssetUrl: assetUrl(id, filename), revisedPrompt: receipt.revisedPrompt }); await this.store.saveJob(job);
    });
  }
  async request(job, name) {
    if (name === "analysis" && job.kind === "import") return {
      prompt: "Identify every distinct wearable garment in the supplied photograph, ignoring bodies and background objects. Return at most eight items, exact visible colors, concise names, useful detail tags and tight bounding boxes in 0–1000 coordinates. Do not generate images. Return the specified JSON.",
      references: [await this.store.safe(`jobs/${job.id}/${job.internal.originalFile}`)], schema: clothesSchema,
    };
    if (job.kind === "curation") {
      const inventory = await this.store.json("library.json", []);
      // Contact sheets provide visual evidence without attaching an unbounded image list.
      const references = [];
      for (let offset = 0; offset < inventory.length; offset += 12) {
        const group = inventory.slice(offset, offset + 12); const tiles = [];
        for (const [index, item] of group.entries()) {
          const bytes = await sharp(await this.assetPath(item.image)).resize(240, 240, { fit: "contain", background: "#f4f0e8" }).flatten({ background: "#f4f0e8" }).png().toBuffer();
          tiles.push({ input: bytes, left: (index % 4) * 240, top: Math.floor(index / 4) * 270 });
          // Labels are numeric to avoid rendering untrusted garment names as SVG.
          const label = Buffer.from(`<svg width="240" height="30"><text x="10" y="22" font-size="18">${offset + index + 1}</text></svg>`);
          tiles.push({ input: label, left: (index % 4) * 240, top: Math.floor(index / 4) * 270 + 240 });
        }
        const sheet = await sharp({ create: { width: 960, height: Math.ceil(group.length / 4) * 270, channels: 3, background: "#f4f0e8" } }).composite(tiles).png().toBuffer();
        const relative = `jobs/${job.id}/contact-${offset}.png`;
        await this.store.lock(() => this.store.asset(relative, sheet)); references.push(await this.store.safe(relative));
      }
      return { prompt: `Curate exactly ${job.count} complete, distinct outfits. Each contains exactly one upperbody top and one lowerbody bottom, with at most one jacket, shoe pair and accessory. Favor tonal/analogous harmony, one statement piece, balanced silhouettes and plausible layers. Diversify garment usage. Inspect the numbered visual contact sheets as well as metadata. Only select existing IDs. Direction: ${JSON.stringify(job.direction)}. Inventory (numbered as in sheets): ${JSON.stringify(inventory.map((r, i) => ({ number: i + 1, id: r.id, name: r.name, part: r.part, color: r.color, tags: r.tags })))}. Existing combinations to avoid: ${JSON.stringify((await this.store.json("outfits.json", [])).map((o) => o.garmentIds))}. Do not generate images. Return the specified JSON.`, references, schema: outfitsSchema };
    }
    if (name === "garment") {
      const key = chooseChromaKey(job.metadata.color);
      return { prompt: `${buildGarmentPrompt(job.metadata, key)}\nGenerate exactly one image using native image generation. User direction: ${job.stages[name].prompt || ""}`, references: [await this.store.safe(`jobs/${job.id}/${job.internal.cropFile}`)] };
    }
    const reference = await this.store.reference();
    if (!reference) throw fail("Upload your identity reference in Settings before generating modeled photos", 422);
    if (job.kind === "outfit") {
      const outfit = (await this.store.json("outfits.json", [])).find((o) => o.id === job.outfitId);
      if (!outfit) throw fail("Outfit was deleted", 404);
      const inventory = await this.store.json("library.json", []);
      const garments = outfit.garmentIds.map((id) => inventory.find((i) => i.id === id));
      if (garments.some((g) => !g)) throw fail("An outfit garment was deleted. Create a new combination.", 422);
      return { prompt: `${modeledPrompt}\nSelected garments: ${JSON.stringify(garments.map((g) => ({ name: g.name, part: g.part, tags: g.tags })))}. Layering must match actual closures in the references. Setting: ${outfit.setting}. User direction: ${job.stages[name].prompt || ""}`, references: [reference, ...await Promise.all(garments.map((g) => this.assetPath(g.image)))] };
    }
    return { prompt: `${modeledPrompt}\nUser direction: ${job.stages[name].prompt || ""}`, references: [reference, await this.assetPath(job.stages.garment.assetUrl)] };
  }
  async finishStructured(job, name, receipt) {
    if (job.kind === "curation") {
      await this.store.lock(async () => {
        const current = await this.store.job(job.id); if (current.status !== "active") return;
        const inventory = await this.store.json("library.json", []); const outfits = await this.store.json("outfits.json", []);
        validate(outfitsSchema, receipt.result);
        const reserved = current.outfitIds || receipt.result.outfits.map(() => randomUUID());
        const otherOutfits = outfits.filter((o) => !reserved.includes(o.id));
        const suggestions = validateOutfits(receipt.result, inventory, job.count, otherOutfits).map((o, i) => outfits.find((existing) => existing.id === reserved[i]) || ({ ...o, id: reserved[i], image: null, status: "suggested", createdAt: now(), generationPrompt: null })).filter((o) => !current.deletedOutfitIds?.includes(o.id));
        current.outfitIds = reserved; await this.store.saveJob(current);
        await this.store.write("outfits.json", [...otherOutfits, ...suggestions]);
        if (current.generateModeled) for (const outfit of suggestions) {
          if (!outfit.image && !outfit.reviewImage && !(await this.store.jobs()).some((j) => j.outfitId === outfit.id)) await this.createOutfitJobLocked(outfit.id);
        }
        current.stages[name].status = "complete"; current.status = "complete"; await this.store.saveJob(current);
      }); return;
    }
    const items = validate(clothesSchema, receipt.result).items.map(normalizeMetadata);
    const original = await readFile(await this.store.safe(`jobs/${job.id}/${job.internal.originalFile}`));
    const crops = await Promise.all(items.map((m) => imageOperation("crop", original, { boundingBox: m.boundingBox })));
    await this.store.lock(async () => {
      const current = await this.store.job(job.id); if (current.status !== "active") return;
      if (!items.length) { emptyDetection(current); await this.store.saveJob(current); return; }
      current.noClothingDetected = false;
      const children = current.childIds || items.map(() => randomUUID());
      current.childIds = children; await this.store.saveJob(current);
      for (const [index, metadata] of items.entries()) {
        if (await this.store.json(`jobs/${children[index]}/job.json`, null)) continue;
        const child = structuredClone(current); child.id = children[index]; child.metadata = metadata; child.parentId = current.id; delete child.childIds;
        child.originalAssetUrl = assetUrl(child.id, "original.png"); child.stages.analysis.status = "complete"; child.stages.crop = { ...stage("review"), assetUrl: assetUrl(child.id, "crop.png") };
        await mkdir(this.store.file(`jobs/${child.id}`), { recursive: true });
        await this.store.asset(`jobs/${child.id}/original.png`, original); await this.store.asset(`jobs/${child.id}/crop.png`, crops[index].bytes); await this.store.saveJob(child);
      }
      current.childIds = children; current.noClothingDetected = !items.length; current.stages.analysis.status = "complete"; current.status = "complete"; await this.store.saveJob(current);
    });
  }
  async finishImage(job, name, receipt) {
    const raw = await readFile(path.join(this.receipts, receipt.file));
    let output = await normalize(raw); let diagnostics; let key;
    if (name === "garment") {
      const clean = await imageOperation("garment", output, { key: chooseChromaKey(job.metadata.color) });
      output = clean.bytes; diagnostics = clean.verification; key = clean.chromaKey;
    }
    await this.store.lock(async () => {
      const current = await this.store.job(job.id); if (current.status !== "active") return;
      const state = current.stages[name]; const file = `${name}-${state.attempts}-${randomUUID()}.png`;
      await this.store.asset(`jobs/${current.id}/${file}`, output);
      Object.assign(state, { status: "review", error: null, assetUrl: assetUrl(current.id, file), chromaKey: key, cleanupDiagnostics: diagnostics, cleanupTolerance: 46 });
      if (diagnostics?.contaminatedPixels > 1) { state.status = "failed"; state.cleanupPreviewUrl = state.assetUrl; state.error = "Generated source is saved. Adjust background cleanup without generating again."; }
      await this.store.saveJob(current);
      if (current.kind === "outfit") {
        const outfits = await this.store.json("outfits.json", []); const outfit = outfits.find((o) => o.id === current.outfitId);
        if (outfit) { outfit.status = "review"; outfit.reviewImage = state.assetUrl; outfit.generationPrompt = state.requestPrompt; await this.store.write("outfits.json", outfits); }
      }
    });
  }
  async createOutfitJobLocked(outfitId, prompt = "") {
    const job = { id: randomUUID(), kind: "outfit", outfitId, status: "active", stages: { modeled: { ...stage("queued"), prompt } }, createdAt: now() };
    await mkdir(this.store.file(`jobs/${job.id}`)); await this.store.saveJob(job); return job;
  }
  async cancel(id) {
    if (this.status.active?.id === id) this.controller?.abort();
    await this.store.lock(async () => { const job = await this.store.job(id); job.status = "cancelled"; job.progress = "Cancelled"; await this.store.saveJob(job); });
    this.log("job", "cancelled", { id });
  }
  async close() {
    this.stopped = true; clearInterval(this.timer); this.store.off("change", this.onChange); this.codex.off("change", this.onConnection); this.controller?.abort();
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
