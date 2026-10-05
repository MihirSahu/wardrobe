import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import * as tar from "tar";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { atomicJson, readJson, fail, now } from "./store.mjs";
import { safeError } from "./codex.mjs";
import { stateDirectory } from "./state.mjs";

export async function sha256(file) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export function safeRelative(name) {
  if (typeof name !== "string" || name.includes("\0") || name.includes("\\") || path.posix.isAbsolute(name) || /^[a-z]:/i.test(name)) throw fail("Unsafe archive path", 422);
  const trimmed = name.replace(/^(\.\/)+/, "").replace(/\/$/, "");
  if (trimmed === "." || trimmed === "") return "";
  if (trimmed.split("/").some((p) => p === ".." || p === "." || !p)) throw fail("Unsafe archive path", 422);
  return trimmed;
}
export async function tree(root, destination) {
  const files = [];
  async function walk(relative = "") {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const filename = relative ? `${relative}/${name}` : name; safeRelative(filename);
      const source = path.join(root, filename); const info = await lstat(source);
      if (info.isDirectory()) {
        files.push({ path: filename, type: "directory" });
        if (destination) await mkdir(path.join(destination, filename));
        await walk(filename);
      } else if (info.isFile()) {
        if (destination) await copyFile(source, path.join(destination, filename));
        const file = destination ? path.join(destination, filename) : source;
        files.push({ path: filename, type: "file", size: info.size, sha256: await sha256(file) });
      } else throw fail(`Unsupported filesystem entry in data/: ${filename}. No files were silently excluded.`, 422);
    }
  }
  await walk(); return files;
}
const fingerprint = (files) => createHash("sha256").update(JSON.stringify(files)).digest("hex");

export class Backup extends EventEmitter {
  constructor(store, { stateDir, bucket = process.env.S3_BACKUP_BUCKET, region = process.env.AWS_REGION, client, log = () => {} } = {}) {
    super(); this.log = log; this.store = store; this.stateDir = path.resolve(stateDir, "backup"); this.bucket = bucket; this.region = region;
    this.client = client || new S3Client({ region, maxAttempts: 3 });
    this.status = { configured: Boolean(bucket && region), running: false, pendingChanges: true, lastSuccess: null, error: null };
    this.onChange = () => { this.status.pendingChanges = true; this.emit("change"); }; store.on("change", this.onChange);
  }
  async init() {
    this.stateDir = await stateDirectory(this.stateDir, this.store.root);
    const saved = await readJson(path.join(this.stateDir, "status.json"), {});
    const destination = { bucket: this.bucket || null, region: this.region || null };
    if (saved.destination?.bucket === destination.bucket && saved.destination?.region === destination.region) Object.assign(this.status, saved);
    Object.assign(this.status, { destination, configured: Boolean(this.bucket && this.region), running: false, pendingChanges: true });
    return this;
  }
  async saveStatus() { await atomicJson(path.join(this.stateDir, "status.json"), this.status); this.emit("change"); }
  trigger() {
    if (this.task) return this.task;
    if (!this.status.configured) { this.status.error = "Set S3_BACKUP_BUCKET and AWS_REGION to enable backups"; this.log("backup", "unavailable", { error: this.status.error }); this.emit("change"); return Promise.reject(fail(this.status.error, 503)); }
    this.status.running = true; this.status.progress = "Preparing snapshot"; this.status.lastAttempt = now(); this.emit("change");
    this.log("backup", "started");
    this.task = this.snapshot().finally(() => { this.task = null; }); return this.task;
  }
  async snapshot() {
    let staging;
    try {
      staging = await mkdtemp(path.join(this.stateDir, "snapshot-"));
      const copy = path.join(staging, "data"); await mkdir(copy);
      let revision;
      const files = await this.store.lock(async () => { revision = this.store.revision; return tree(this.store.root, copy); });
      const hash = fingerprint(files);
      this.status.progress = "Compressing complete data directory"; this.emit("change");
      this.log("backup", "compressing");
      const archive = path.join(staging, "archive.tar.gz");
      await tar.c({ file: archive, cwd: copy, gzip: true, portable: true, follow: false }, ["."]);
      const id = `${now().replace(/[:.]/g, "-")}-${randomUUID()}`; const key = `snapshots/${id}/archive.tar.gz`;
      const archiveInfo = { key, size: (await stat(archive)).size, sha256: await sha256(archive) };
      this.status.progress = "Uploading snapshot"; this.emit("change");
      this.log("backup", "uploading", { bytes: archiveInfo.size });
      const upload = { Bucket: this.bucket, Key: key, Body: createReadStream(archive), ContentLength: archiveInfo.size, ContentType: "application/gzip", ServerSideEncryption: "AES256" };
      if (archiveInfo.size <= 4 * 1024 ** 3) await this.client.send(new PutObjectCommand(upload));
      else await new Upload({ client: this.client, params: upload, queueSize: 2, partSize: Math.max(8 * 1024 ** 2, Math.ceil(archiveInfo.size / 9500)), leavePartsOnError: false }).done();
      const manifest = { version: 1, id, createdAt: now(), archive: archiveInfo, files };
      // Completion manifest is the commit marker. An interrupted archive upload is not recoverable.
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: `snapshots/${id}/complete.json`, Body: JSON.stringify(manifest), ContentType: "application/json", ServerSideEncryption: "AES256" }));
      Object.assign(this.status, { lastSuccess: manifest.createdAt, snapshotId: id, fingerprint: hash, files: files.filter((f) => f.type === "file").length, bytes: files.reduce((n, f) => n + (f.size || 0), 0), pendingChanges: revision !== this.store.revision, error: null });
      this.log("backup", "completed", { snapshotId: id, files: this.status.files, bytes: this.status.bytes });
    } catch (error) { this.log("backup", "failed", { error }); this.status.error = safeError(error); throw error; }
    finally {
      this.status.running = false; this.status.progress = null;
      try { await this.saveStatus(); }
      finally { if (staging) await rm(staging, { recursive: true, force: true }); }
    }
    return this.status;
  }
  async snapshots() {
    if (!this.status.configured) return [];
    let token; const snapshots = [];
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: "snapshots/", ContinuationToken: token }));
      for (const entry of page.Contents || []) if (/^snapshots\/[^/]+\/complete\.json$/.test(entry.Key)) snapshots.push({ id: entry.Key.split("/")[1], completedAt: entry.LastModified });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return snapshots.sort((a, b) => b.id.localeCompare(a.id));
  }
  async close() { this.store.off("change", this.onChange); await this.task?.catch(() => {}); }
}

export async function verifyExtract(archive, manifest, destination) {
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.archive || !/^[a-f0-9]{64}$/.test(manifest.archive.sha256)) throw fail("Invalid snapshot manifest", 422);
  if (await sha256(archive) !== manifest.archive.sha256 || (await stat(archive)).size !== manifest.archive.size) throw fail("Archive checksum or size mismatch", 422);
  const expected = new Map();
  for (const entry of manifest.files) {
    const name = safeRelative(entry.path);
    if (!name || expected.has(name) || !["file", "directory"].includes(entry.type)) throw fail("Invalid snapshot path or type", 422);
    if (entry.type === "file" && (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))) throw fail("Invalid file checksum or size", 422);
    expected.set(name, entry);
  }
  const seen = new Set(); let error;
  await tar.t({ file: archive, strict: true, onReadEntry: (entry) => {
    try {
      const name = safeRelative(entry.path);
      if (!name) { if (entry.type !== "Directory") throw fail("Invalid archive root", 422); return; }
      const specification = expected.get(name);
      if (!specification || seen.has(name) || entry.type !== (specification.type === "file" ? "File" : "Directory") || (specification.type === "file" && entry.size !== specification.size)) throw fail("Archive contains an unexpected, duplicate, linked or invalid entry", 422);
      seen.add(name);
    } catch (failure) { error ||= failure; }
  } });
  if (error) throw error;
  if (seen.size !== expected.size) throw fail("Archive is missing files or directories", 422);
  if ((await readdir(destination)).length) throw fail("Restore destination must be empty", 409);
  await tar.x({ file: archive, cwd: destination, strict: true, preservePaths: false, noMtime: true, noChmod: true });
  const actual = await tree(destination);
  const actualMap = new Map(actual.map((f) => [f.path, f]));
  for (const [name, spec] of expected) {
    const entry = actualMap.get(name);
    if (!entry || entry.type !== spec.type || entry.size !== spec.size || entry.sha256 !== spec.sha256) throw fail(`Restored file failed verification: ${name}`, 422);
  }
  if (actualMap.size !== expected.size) throw fail("Restored tree contains unexpected files", 422);
}

export async function restore({ client, bucket, id, destination, workDir }) {
  if (!/^[\w-]+$/.test(id)) throw fail("Invalid snapshot ID");
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `snapshots/${id}/complete.json` }));
  const text = await response.Body.transformToString(); if (text.length > 64 * 1024 * 1024) throw fail("Snapshot manifest is too large", 422);
  const manifest = JSON.parse(text);
  if (manifest.id !== id || manifest.archive?.key !== `snapshots/${id}/archive.tar.gz`) throw fail("Snapshot identity mismatch", 422);
  const target = path.resolve(destination);
  // Never restore over a running wardrobe, symlink, or existing directory.
  try { await lstat(target); throw fail("Restore destination must be a new directory", 409); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(workDir, { recursive: true }); const staging = await mkdtemp(path.join(workDir, "restore-"));
  let createdTarget = false;
  try {
    const archive = path.join(staging, "archive.tar.gz");
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: manifest.archive.key }));
    await pipeline(object.Body, createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    await mkdir(target); createdTarget = true; await verifyExtract(archive, manifest, target); return manifest;
  } catch (error) { if (createdTarget) await rm(target, { recursive: true, force: true }); throw error; }
  finally { await rm(staging, { recursive: true, force: true }); }
}
