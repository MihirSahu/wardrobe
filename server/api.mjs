import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import * as tar from "tar";
import { json, body, upload } from "./http.mjs";
import { fail, now, publicJob } from "./store.mjs";
import { normalize, imageOperation } from "./images.mjs";
import { normalizeMetadata } from "./image-ops.mjs";
import { safeError } from "./codex.mjs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
function clearCleanupSource(state) {
  Object.assign(state, { rawAsset: null, failedAssetUrl: null, chromaKey: null, cleanupPreviewUrl: null, cleanupDiagnostics: null, cleanupTolerance: null });
}
export function createApi({ store, codex, jobs, backup, log = () => {} }) {
  const clients = new Set();
  const broadcast = () => { for (const response of clients) { if (!response.write(`event: change\ndata: ${JSON.stringify({ revision: store.revision })}\n\n`)) { response.end(); clients.delete(response); } } };
  store.on("change", broadcast); store.on("queue", broadcast); codex.on("change", broadcast); backup?.on("change", broadcast);
  const heartbeat = setInterval(() => { for (const res of clients) res.write(": heartbeat\n\n"); }, 20_000); heartbeat.unref();

  async function config() { return { ready: true, connected: codex.status.connected, hasApiKey: false, hasModelReference: Boolean(await store.reference()), queue: jobs.status }; }
  async function serveAsset(req, res, file, url) {
    const mime = MIME[path.extname(file).toLowerCase()]; if (!mime) throw fail("Image not found", 404);
    res.setHeader("X-Content-Type-Options", "nosniff");
    const width = Number(url.searchParams.get("w"));
    if (width) {
      if (!Number.isInteger(width) || width < 64 || width > 1600) throw fail("Image width must be 64–1600");
      const bytes = await sharp(file, { limitInputPixels: 40_000_000 }).resize({ width, height: width, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
      res.setHeader("Content-Type", "image/webp"); res.setHeader("Cache-Control", "private, max-age=86400"); return res.end(bytes);
    }
    res.setHeader("Content-Type", mime); res.setHeader("Cache-Control", "private, max-age=86400"); return res.end(await readFile(file));
  }
  async function persistImported(job, includeModeled = false) {
    const id = job.itemId || `import-${job.id}`;
    const filename = `${id}-garment-${randomUUID()}.png`;
    const records = await store.json("library.json", []); const existing = records.find((r) => r.id === id);
    if (includeModeled && job.stages.garment.status !== "approved") throw fail("Approve the garment before adding a modeled photo", 409);
    if (!existing && (includeModeled || job.itemId || job.stages.garment.status === "approved")) throw fail("This wardrobe item was deleted. Start a new import to add it again.", 409);
    const record = includeModeled ? { ...existing } : { id, ...existing, ...normalizeMetadata(job.metadata), modeledImage: existing?.modeledImage || null, importJobId: job.id };
    if (!includeModeled) {
      const garment = await readFile(await jobs.assetPath(job.stages.garment.assetUrl));
      await store.asset(`imported/${filename}`, garment);
      record.image = record.thumbnail = `/api/import/library/${filename}`;
    }
    delete record.boundingBox; record.palette = [record.color, record.secondaryColor].filter(Boolean);
    if (includeModeled) { const modeled = `${id}-modeled-${randomUUID()}.png`; await store.asset(`imported/${modeled}`, await readFile(await jobs.assetPath(job.stages.modeled.assetUrl))); record.modeledImage = `/api/import/library/${modeled}`; }
    await store.write("library.json", [...records.filter((r) => r.id !== id), record]); return record;
  }
  async function handler(req, res, next = () => json(res, 404, { error: "Not found" })) {
    const url = new URL(req.url, "http://localhost"); const route = url.pathname;
    if (!route.startsWith("/api/")) return next();
    try {
      // Private single-owner deployment: reject cross-origin browser mutations even without app login.
      if (!["GET", "HEAD"].includes(req.method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fail("Cross-origin request rejected", 403);
      if (route === "/api/health" && req.method === "GET") return json(res, 200, { ok: true });
      if (route === "/api/events" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write("event: change\ndata: {}\n\n"); clients.add(res); req.on("close", () => clients.delete(res)); return;
      }
      if (route === "/api/import/config" && req.method === "GET") return json(res, 200, await config());
      if (route === "/api/connection" && req.method === "GET") return json(res, 200, url.searchParams.has("refresh") || !codex.status.available ? await codex.refresh() : codex.status);
      if (route === "/api/connection/login" && req.method === "POST") return json(res, 200, await codex.login());
      if (route === "/api/connection/cancel" && req.method === "POST") { await codex.cancelLogin(); return json(res, 200, codex.status); }
      if (route === "/api/connection/logout" && req.method === "POST") {
        // Set both pause and disconnect intent before awaiting disk or RPC work.
        // Otherwise a refresh during queue persistence can resume the queue.
        const paused = jobs.pause("authentication", "ChatGPT disconnected"); jobs.controller?.abort();
        await Promise.all([paused, codex.logout()]); return json(res, 200, codex.status);
      }
      if (route === "/api/queue/resume" && req.method === "POST") { await jobs.resume(); return json(res, 200, jobs.status); }
      if (route === "/api/settings" && req.method === "GET") return json(res, 200, { ...await store.json("settings.json", {}), ...await config(), backup: backup?.status });
      if (route === "/api/settings" && req.method === "PATCH") {
        const input = await body(req, 4096);
        if (typeof input.model !== "string" || !codex.status.models.some((m) => m.model === input.model)) throw fail("Select an available model");
        await store.lock(async () => { const settings = await store.json("settings.json", {}); settings.model = input.model; await store.write("settings.json", settings); });
        return json(res, 200, await store.json("settings.json", {}));
      }
      if (route === "/api/reference" && req.method === "POST") {
        const file = await upload(req); const bytes = await normalize(file.bytes);
        const relative = `references/identity-${randomUUID()}.png`;
        await store.lock(async () => { await store.asset(relative, bytes); const settings = await store.json("settings.json", {}); settings.identityReference = relative; await store.write("settings.json", settings); });
        return json(res, 200, { hasModelReference: true });
      }
      if (route === "/api/reference" && req.method === "GET") { const file = await store.reference(); if (!file) throw fail("No identity reference", 404); return serveAsset(req, res, file, url); }
      if (route === "/api/backup" && req.method === "GET") return json(res, 200, backup.status);
      if (route === "/api/backup" && req.method === "POST") { backup.trigger().catch(() => {}); return json(res, 202, backup.status); }
      if (route === "/api/backup/snapshots" && req.method === "GET") return json(res, 200, await backup.snapshots());
      if (route === "/api/import/wardrobe" && req.method === "GET") return json(res, 200, await store.json("library.json", []));
      const modelItem = route.match(/^\/api\/import\/wardrobe\/([\w-]+)\/generate-modeled$/);
      if (modelItem && req.method === "POST") return json(res, 202, await jobs.modelItem(modelItem[1]));
      if (route === "/api/import/migrate" && req.method === "POST") {
        const input = await body(req, 256 * 1024);
        if (!input.edits || typeof input.edits !== "object" || Array.isArray(input.edits) || !Array.isArray(input.deleted)) throw fail("Invalid browser migration");
        let count = 0;
        await store.lock(async () => {
          const records = await store.json("library.json", []); const deleted = new Set(input.deleted.filter((v) => typeof v === "string"));
          const updated = records.filter((r) => { if (deleted.has(r.id)) { count++; return false; } return true; }).map((r) => {
            if (!input.edits[r.id]) return r; count++; const metadata = normalizeMetadata({ ...r, ...input.edits[r.id] }); delete metadata.boundingBox; return { ...r, ...metadata };
          }); await store.write("library.json", updated);
        }); return json(res, 200, { applied: count });
      }
      const wardrobe = route.match(/^\/api\/import\/wardrobe\/([\w-]+)(?:\/(garment|modeled))?$/);
      if (wardrobe && ["PATCH", "DELETE", "POST"].includes(req.method)) {
        const input = req.method === "PATCH" ? await body(req, 16384) : wardrobe[2] ? await upload(req) : {};
        const image = wardrobe[2] ? await normalize(input.bytes) : null; let record;
        await store.lock(async () => {
          const records = await store.json("library.json", []); const item = records.find((r) => r.id === wardrobe[1]); if (!item) throw fail("Wardrobe item not found", 404);
          if (req.method === "DELETE") {
            for (const job of (await store.jobs()).filter((j) => j.status === "active" && (j.itemId === item.id || `import-${j.id}` === item.id))) {
              job.status = "cancelled"; await store.saveJob(job);
              if (jobs.status.active?.id === job.id) jobs.controller?.abort();
            }
            await store.write("library.json", records.filter((r) => r.id !== item.id)); return;
          }
          if (image) { const filename = `${item.id}-${wardrobe[2]}-${randomUUID()}.png`; await store.asset(`imported/${filename}`, image); if (wardrobe[2] === "modeled") item.modeledImage = `/api/import/library/${filename}`; else item.image = item.thumbnail = `/api/import/library/${filename}`; }
          else { const metadata = normalizeMetadata({ ...item, ...(input.metadata || input) }); delete metadata.boundingBox; Object.assign(item, metadata); }
          record = item; await store.write("library.json", records);
        }); return json(res, 200, record || { deleted: true });
      }
      const libraryAsset = route.match(/^\/api\/import\/library\/([\w.-]+)$/);
      if (libraryAsset && req.method === "GET") return serveAsset(req, res, await store.safe(`imported/${libraryAsset[1]}`), url);
      const jobAsset = route.match(/^\/api\/import\/assets\/([a-f0-9-]{36})\/([\w.-]+)$/);
      if (jobAsset && req.method === "GET") return serveAsset(req, res, await store.safe(`jobs/${jobAsset[1]}/${jobAsset[2]}`), url);
      const outfitAsset = route.match(/^\/api\/import\/outfits\/([\w.-]+)$/);
      if (outfitAsset && req.method === "GET") return serveAsset(req, res, await store.safe(`outfit-images/${outfitAsset[1]}`), url);
      if (route === "/api/import/jobs" && req.method === "GET") return json(res, 200, (await store.jobs()).filter((j) => j.kind === "import" && j.status === "active").map(publicJob));
      if (route === "/api/import/jobs" && req.method === "POST") return json(res, 202, { jobs: [await jobs.createUpload(await upload(req))] });
      if (route === "/api/jobs" && req.method === "GET") return json(res, 200, (await store.jobs()).filter((j) => j.status === "active").map(publicJob));
      const jobRoute = route.match(/^\/api\/import\/jobs\/([a-f0-9-]{36})(?:\/(.*))?$/);
      if (jobRoute) {
        const [, id, action = ""] = jobRoute;
        if (req.method === "GET" && !action) return json(res, 200, publicJob(await store.job(id)));
        if (req.method === "DELETE" || (action === "cancel" && req.method === "POST")) { await jobs.cancel(id); return json(res, 200, { cancelled: true }); }
        if (action === "manual" && req.method === "POST") return json(res, 200, await jobs.manual(id));
        if (action === "package" && req.method === "GET") {
          await store.job(id); res.setHeader("Content-Type", "application/gzip"); res.setHeader("Content-Disposition", `attachment; filename="wardrobe-${id}.tar.gz"`);
          const archive = tar.c({ cwd: await store.safe(`jobs/${id}`), gzip: true, portable: true, follow: false }, ["."]); archive.on("error", () => res.destroy()); archive.pipe(res); return;
        }
        if (action === "metadata" && ["PATCH", "PUT"].includes(req.method)) {
          const input = await body(req, 16384); if (!input.metadata || typeof input.metadata !== "object") throw fail("metadata is required");
          const job = await store.job(id); if (job.kind !== "import") throw fail("Not a garment import");
          const checkReviewed = (candidate) => {
            if (input.reviewedStage === undefined) return;
            if (!["crop", "garment"].includes(input.reviewedStage)) throw fail("Invalid reviewed stage");
            const reviewed = candidate.stages[input.reviewedStage];
            if (candidate.status !== "active" || reviewed.status !== "review" || typeof input.reviewedAssetUrl !== "string" || reviewed.assetUrl !== input.reviewedAssetUrl) throw fail("The image changed. Review the latest image before approving it.", 409);
          };
          checkReviewed(job);
          if (job.stages.crop.status === "processing" || job.stages.garment.status === "processing") throw fail("Wait for the current generation to finish before changing metadata", 409);
          const metadata = normalizeMetadata({ ...job.metadata, ...input.metadata });
          const crop = job.stages.crop.status === "review" ? await imageOperation("crop", await readFile(await store.safe(`jobs/${id}/${job.internal.originalFile}`)), { boundingBox: metadata.boundingBox }) : null;
          let saved;
          await store.lock(async () => {
            const current = await store.job(id);
            checkReviewed(current);
            if (current.status !== job.status || current.stages.crop.status !== job.stages.crop.status || current.stages.garment.status !== job.stages.garment.status
              || current.internal.originalFile !== job.internal.originalFile || JSON.stringify(current.metadata) !== JSON.stringify(job.metadata)) {
              throw fail("The import changed while you edited. Review its latest details and try again.", 409);
            }
            current.metadata = metadata;
            if (crop) { const filename = `crop-${randomUUID()}.png`; await store.asset(`jobs/${id}/${filename}`, crop.bytes); current.internal.cropFile = filename; current.stages.crop.assetUrl = `/api/import/assets/${id}/${filename}`; }
            await store.saveJob(current);
            saved = publicJob(current);
          }); return json(res, 200, saved);
        }
        const cleanup = action.match(/^stages\/garment\/cleanup-(preview|accept)$/);
        if (cleanup && req.method === "POST") {
          const input = await body(req, 4096); const job = await store.job(id); const s = job.stages.garment;
          if (job.status !== "active" || !["failed", "review"].includes(s?.status)) throw fail("Review the current garment before adjusting cleanup", 409);
          if (cleanup[1] === "accept" && (typeof input.reviewedRawAsset !== "string" || input.reviewedRawAsset !== s.rawAsset)) throw fail("The image changed. Review the latest cleanup before accepting it.", 409);
          if (!s.rawAsset || !s.chromaKey) throw fail("No chroma source is available", 409);
          const result = await imageOperation("cleanup", await readFile(await store.safe(`jobs/${id}/${s.rawAsset}`)), { key: s.chromaKey, tolerance: input.tolerance });
          await store.lock(async () => {
            const current = await store.job(id); const state = current.stages.garment; const filename = `cleanup-${randomUUID()}.png`;
            if (current.status !== "active" || state.status !== s.status || state.attempts !== s.attempts || state.rawAsset !== s.rawAsset || state.assetUrl !== s.assetUrl) throw fail("The garment changed while cleanup was running. Review the current result first.", 409);
            await store.asset(`jobs/${id}/${filename}`, result.bytes);
            Object.assign(state, { cleanupPreviewUrl: `/api/import/assets/${id}/${filename}`, cleanupTolerance: result.tolerance, cleanupDiagnostics: result.verification });
            if (cleanup[1] === "accept") Object.assign(state, { status: "review", assetUrl: state.cleanupPreviewUrl, error: null });
            await store.saveJob(current);
          }); return json(res, 200, publicJob(await store.job(id)));
        }
        const step = action.match(/^stages\/(crop|garment|modeled|analysis)\/(approve|reject|regenerate|retry|skip|upload)$/);
        if (step && req.method === "POST") {
          const [, name, decision] = step; const input = decision === "upload" ? await upload(req) : await body(req, 16384);
          const image = decision === "upload" ? await normalize(input.bytes) : null; let record;
          await store.lock(async () => {
            const job = await store.job(id); const state = job.stages[name]; if (!state) throw fail("Invalid stage");
            if (job.status === "cancelled" && !["regenerate", "retry"].includes(decision)) throw fail("This import was cancelled", 409);
            if (state.status === "processing") throw fail("Cancel or finish the active request first", 409);
            if (decision === "reject") { job.status = "cancelled"; state.status = "rejected"; }
            else if (decision === "skip") {
              if (name !== "modeled" || job.stages.garment?.status !== "approved") throw fail("Only an optional modeled photo can be skipped", 409);
              state.status = "skipped"; job.status = "complete";
            } else if (decision === "regenerate" || decision === "retry") {
              if (name === "crop") throw fail("Adjust the crop before approving it");
              if (name === "modeled" && job.kind === "import" && job.stages.garment.status !== "approved") throw fail("Approve the garment first", 409);
              if (name === "garment" && job.stages.crop.status !== "approved") throw fail("Approve the crop first", 409);
              if (decision === "regenerate") { state.freshGeneration = true; clearCleanupSource(state); }
              state.prompt = typeof input.prompt === "string" ? input.prompt.slice(0, 1200) : state.prompt; state.status = "queued"; state.error = null; job.status = "active";
            } else if (decision === "upload") {
              if (!["garment", "modeled"].includes(name)) throw fail("Upload a garment or modeled photo");
              const filename = `${name}-replacement-${randomUUID()}.png`; await store.asset(`jobs/${id}/${filename}`, image);
              clearCleanupSource(state);
              state.assetUrl = `/api/import/assets/${id}/${filename}`; state.status = "review"; state.error = null; job.status = "active";
            } else {
              if (state.status !== "review") throw fail("This stage is not ready for approval", 409);
              if (name === "analysis") throw fail("Review detected garment crops instead");
              if (job.kind !== "import") throw fail("Approve outfit photos from the Outfits screen");
              if (typeof input.reviewedAssetUrl !== "string" || input.reviewedAssetUrl !== state.assetUrl) throw fail("The image changed. Review the latest image before approving it.", 409);
              if (name === "garment" && input.generateModeled === true && !await store.reference()) throw fail("Upload an identity reference in Settings first", 422);
              if (name === "garment" || name === "modeled") record = await persistImported(job, name === "modeled");
              state.status = "approved"; state.decision = "approved";
              if (name === "crop") job.stages.garment.status = "queued";
              if (name === "garment") {
                if (input.generateModeled === true) job.stages.modeled.status = "queued";
                else { job.stages.modeled.status = "skipped"; job.status = "complete"; }
              }
              if (name === "modeled") job.status = "complete";
            }
            await store.saveJob(job);
          }); return json(res, 200, { ...publicJob(await store.job(id)), ...(record ? { record } : {}) });
        }
      }
      if (route === "/api/outfits" && req.method === "GET") return json(res, 200, await store.json("outfits.json", []));
      if (route === "/api/outfits" && req.method === "POST") return json(res, 202, await jobs.curate(await body(req, 16384)));
      const outfitRoute = route.match(/^\/api\/outfits\/([\w-]+)(?:\/(generate|approve|replacement))?$/);
      if (outfitRoute) {
        const [, id, action] = outfitRoute;
        if (req.method === "DELETE") {
          for (const job of (await store.jobs()).filter((j) => j.outfitId === id && j.status === "active")) await jobs.cancel(job.id);
          await store.lock(async () => {
            const outfits = await store.json("outfits.json", []);
            for (const job of (await store.jobs()).filter((j) => j.kind === "curation" && j.outfitIds?.includes(id))) {
              job.deletedOutfitIds = [...new Set([...(job.deletedOutfitIds || []), id])]; await store.saveJob(job);
            }
            await store.write("outfits.json", outfits.filter((o) => o.id !== id));
          }); return json(res, 200, { deleted: true });
        }
        if (req.method === "POST" && action) {
          const input = action === "replacement" ? await upload(req) : await body(req, 4096); const bytes = action === "replacement" ? await normalize(input.bytes) : null;
          let result;
          await store.lock(async () => {
            const outfits = await store.json("outfits.json", []); const outfit = outfits.find((o) => o.id === id); if (!outfit) throw fail("Outfit not found", 404);
            if (action === "generate") {
              if (!await store.reference()) throw fail("Upload an identity reference in Settings first", 422);
              if ((await store.jobs()).some((j) => j.outfitId === id && j.status === "active" && ["queued", "processing"].includes(j.stages.modeled.status))) throw fail("This outfit already has a queued request", 409);
              result = publicJob(await jobs.createOutfitJobLocked(id, typeof input.prompt === "string" ? input.prompt.slice(0, 1200) : "")); outfit.status = "queued";
            } else {
              if ((await store.jobs()).some((j) => j.outfitId === id && j.status === "active" && ["queued", "processing"].includes(j.stages.modeled.status))) throw fail("Wait for or cancel the active outfit request before replacing its photo", 409);
              if (action === "approve" && (typeof input.reviewedAssetUrl !== "string" || input.reviewedAssetUrl !== outfit.reviewImage)) throw fail("The image changed. Review the latest outfit photo before approving it.", 409);
              const review = action === "replacement" ? bytes : outfit.reviewImage ? await readFile(await jobs.assetPath(outfit.reviewImage)) : null;
              if (!review) throw fail("No modeled image is ready for review", 409);
              const filename = `${id}-${randomUUID()}.png`; await store.asset(`outfit-images/${filename}`, review);
              outfit.image = `/api/import/outfits/${filename}`; outfit.status = "accepted"; delete outfit.reviewImage; result = outfit;
              for (const job of (await store.jobs()).filter((j) => j.outfitId === id && j.status === "active")) { job.status = "complete"; job.stages.modeled.status = "approved"; await store.saveJob(job); }
            }
            await store.write("outfits.json", outfits);
          }); return json(res, 200, result);
        }
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      log("api", "error", { method: req.method, path: route, status: error.code === "ENOENT" ? 404 : error.status || 500, error });
      if (res.headersSent) { res.destroy(); return; }
      const status = error.code === "ENOENT" ? 404 : error.status || 500;
      return json(res, status, { error: status === 404 ? "Not found" : safeError(error) });
    }
  }
  handler.close = () => {
    clearInterval(heartbeat); store.off("change", broadcast); store.off("queue", broadcast); codex.off("change", broadcast); backup?.off("change", broadcast);
    for (const res of clients) res.end(); clients.clear();
  };
  return handler;
}
