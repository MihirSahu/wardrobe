import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { application } from "../server/index.mjs";

export class MemoryS3 {
  constructor() { this.objects = new Map(); this.calls = []; }
  async send(command) {
    this.calls.push(command.constructor.name); const { Key, Body } = command.input;
    if (command.constructor.name === "PutObjectCommand") { const chunks = []; if (typeof Body === "string") chunks.push(Buffer.from(Body)); else for await (const chunk of Body) chunks.push(Buffer.from(chunk)); this.objects.set(Key, Buffer.concat(chunks)); return {}; }
    if (command.constructor.name === "GetObjectCommand") { const value = this.objects.get(Key); if (!value) throw new Error("Not found"); const stream = Readable.from(value); stream.transformToString = async () => value.toString(); return { Body: stream }; }
    if (command.constructor.name === "ListObjectsV2Command") return { Contents: [...this.objects.keys()].map((Key) => ({ Key, LastModified: new Date() })) };
    throw new Error("Unexpected S3 operation");
  }
}

export async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-test-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
export const photo = () => sharp({ create: { width: 48, height: 64, channels: 3, background: "#b72b30" } }).png().toBuffer();
export const cutout = () => sharp({ create: { width: 64, height: 64, channels: 4, background: "#00000000" } }).composite([{ input: Buffer.from('<svg width="64" height="64"><rect x="16" y="8" width="32" height="48" fill="#b72b30"/></svg>') }]).png().toBuffer();
export const detected = { items: [{ name: "Red tee", part: "upperbody", color: "#b72b30", secondaryColor: null, tags: ["cotton"], boundingBox: { x: 0, y: 0, width: 1000, height: 1000 } }] };
export class FakeCodex extends EventEmitter {
  constructor(root) { super(); this.work = path.join(root, "scratch"); this.status = { connected: true, available: true, models: [{ model: "test", isDefault: true }], rateLimits: null }; this.calls = []; this.active = 0; this.maxActive = 0; }
  async start() { await mkdir(this.work, { recursive: true }); }
  async refresh() { return this.status; }
  limitsExhausted() { return false; }
  async run(request) {
    this.calls.push(request); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    try { await sleep(40); if (request.schema) return this.result || detected; await request.onImage(await cutout(), { type: "imageGeneration", status: "completed", revisedPrompt: "test" }); }
    finally { this.active--; }
  }
  async close() {}
}
export async function testApp(t, options = {}) {
  const root = await fixture(t); const codex = new FakeCodex(root);
  const app = await application({ root, codex, log: options.log, backupOptions: options.backupOptions });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (url, method = "GET", body) => {
    const response = await fetch(base + url, { method, ...(body === undefined ? {} : body instanceof FormData ? { body } : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
    return { status: response.status, value: await response.json() };
  };
  const upload = async (manual = true) => { const form = new FormData(); form.append("image", new Blob([await photo()], { type: "image/png" }), "red-tee.png"); form.append("manual", String(manual)); return api("/api/import/jobs", "POST", form); };
  const approveImport = async (id, stage, options = {}) => {
    const job = (await api(`/api/import/jobs/${id}`)).value;
    return api(`/api/import/jobs/${id}/stages/${stage}/approve`, "POST", { reviewedAssetUrl: job.stages?.[stage]?.assetUrl, ...options });
  };
  const approveOutfit = async (id) => {
    const outfit = (await api("/api/outfits")).value.find((o) => o.id === id);
    return api(`/api/outfits/${id}/approve`, "POST", { reviewedAssetUrl: outfit?.reviewImage });
  };
  return { ...app, root, codex, base, api, upload, approveImport, approveOutfit };
}
export async function until(fn, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await sleep(30); }
  throw new Error("Timed out waiting for job");
}
