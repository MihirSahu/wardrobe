import { mkdir, mkdtemp, readFile, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Codex } from "../server/codex.mjs";
import { atomicWrite } from "../server/store.mjs";
import { normalize, imageOperation } from "../server/images.mjs";
import { buildGarmentPrompt } from "../server/image-ops.mjs";

const args = process.argv.slice(2); const option = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
const source = option("source"); const reference = option("reference");
if (!source || !reference) {
  console.error("Usage: sfw pnpm smoke:images --source PHOTO --reference IDENTITY_PHOTO [--output DIRECTORY]\nStop the app before running this command against its Codex credentials volume."); process.exitCode = 1;
} else {
  const stateDir = path.resolve(process.env.WARDROBE_STATE_DIR || ".state");
  const output = path.resolve(option("output") || path.join(stateDir, "smoke-output"));
  const codex = new Codex({ stateDir, binary: process.env.CODEX_BINARY || path.resolve("node_modules/.bin/codex") }); let scratch;
  try {
    await mkdir(output, { recursive: true }); await codex.start(); await codex.refresh();
    if (!codex.status.connected) {
      const login = await codex.login(); console.log(`Sign in at ${login.verificationUrl}\nDevice code: ${login.userCode}`);
      const deadline = Date.now() + 15 * 60_000;
      while (!codex.status.connected && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 2000)); await codex.refresh(); }
      if (!codex.status.connected) throw new Error("Device sign-in timed out");
    }
    scratch = await mkdtemp(path.join(codex.work, "smoke-"));
    const garmentReference = path.join(scratch, "source.png"); const identity = path.join(scratch, "identity.png");
    await atomicWrite(garmentReference, await normalize(await readFile(source))); await atomicWrite(identity, await normalize(await readFile(reference)));
    const raw = path.join(output, "cutout-source.png");
    await codex.run({ scratch, images: [garmentReference], prompt: `${buildGarmentPrompt({}, "#00ff00")} Generate exactly one image using native image generation.`, onProgress: console.log, onImage: async (bytes, item) => { await atomicWrite(raw, bytes); console.log(`Native image event: ${item.type}, ${item.status}`); } });
    const normalized = await normalize(await readFile(raw));
    const clean = await imageOperation("garment", normalized, { key: "#00ff00" });
    if (clean.verification?.contaminatedPixels > 1) throw new Error("Cutout still contains chroma contamination; review background cleanup before deployment");
    const cutout = path.join(output, "cutout.png"); await atomicWrite(cutout, clean.bytes);
    const { data, info } = await sharp(clean.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let transparent = 0; let visible = 0; for (let i = 3; i < data.length; i += info.channels) { if (data[i] === 0) transparent++; if (data[i] > 8) visible++; }
    if (!transparent || !visible) throw new Error("Cutout must contain both transparent background and visible garment pixels");
    const garment = path.join(scratch, "garment.png"); await copyFile(cutout, garment);
    await codex.run({ scratch, images: [identity, garment], prompt: "Generate exactly one square realistic editorial photo of the person in Image 1 wearing the exact garment in Image 2. Preserve recognizable identity and garment details. Full-body framing, neutral supporting clothes, natural light. Use native image generation.", onProgress: console.log, onImage: async (bytes) => { await atomicWrite(path.join(output, "modeled.png"), await normalize(bytes)); } });
    await codex.close(); await codex.start(); await codex.refresh(); if (!codex.status.connected) throw new Error("Connection did not survive app-server restart");
    console.log(`PASS: native app-server cutout, modeled image and credential restart. Outputs: ${output}\nInspect garment/identity fidelity before deployment. No OpenAI API key was supplied.`);
  } catch (error) { console.error(`FAIL: ${error.message}`); process.exitCode = 1; }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }); await codex.close(); }
}
