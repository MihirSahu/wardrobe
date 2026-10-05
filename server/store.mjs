import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const now = () => new Date().toISOString();
export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function atomicWrite(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temp, file);
    // Flush the directory entry too, so completed writes survive a power loss.
    const directory = await open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await rm(temp, { force: true });
  }
}
export const atomicJson = (file, value) => atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
}

export class Store extends EventEmitter {
  constructor(root) { super(); this.root = path.resolve(root); this.tail = Promise.resolve(); this.revision = 0; }
  async init() {
    await mkdir(this.root, { recursive: true });
    this.root = await realpath(this.root);
    await this.lock(async () => {
      for (const folder of ["jobs", "imported", "outfit-images", "references"]) {
        await mkdir(this.file(folder), { recursive: true });
        await this.safe(folder);
      }
      for (const [name, value] of [["library.json", []], ["outfits.json", []], ["settings.json", {}]]) {
        try { await this.safe(name); } catch (error) {
          if (error.code !== "ENOENT") throw error;
          await atomicJson(this.file(name), value);
        }
      }
    });
    return this;
  }
  file(relative) {
    const file = path.resolve(this.root, relative);
    if (!inside(this.root, file)) throw fail("Path leaves the data directory");
    return file;
  }
  async safe(relative) {
    const file = this.file(relative);
    let current = this.root;
    for (const segment of path.relative(this.root, file).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw fail("Symbolic links are not supported in data/", 422);
    }
    return file;
  }
  lock(fn) {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  async json(relative, fallback) {
    try {
      const value = await readJson(await this.safe(relative), fallback);
      if (relative === "outfits.json" && Array.isArray(value?.outfits)) return value.outfits;
      return value;
    }
    catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
  }
  async write(relative, value) {
    // Callers hold lock(). Parents must already exist or be created by the application.
    await this.safe(path.dirname(relative));
    try { await this.safe(relative); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (relative === "outfits.json" && Array.isArray(value)) {
      const previous = await readJson(this.file(relative), null);
      if (previous && !Array.isArray(previous) && Array.isArray(previous.outfits)) value = { ...previous, outfits: value };
    }
    await atomicJson(this.file(relative), value);
    this.changed();
  }
  async asset(relative, bytes) {
    await this.safe(path.dirname(relative));
    try { await this.safe(relative); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await atomicWrite(this.file(relative), bytes); this.changed();
  }
  changed() { this.revision += 1; this.emit("change", { revision: this.revision }); }
  async jobs() {
    const ids = await readdir(await this.safe("jobs"));
    const jobs = await Promise.all(ids.filter((id) => /^[a-f0-9-]{36}$/.test(id)).map((id) => this.json(`jobs/${id}/job.json`, null)));
    return jobs.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async job(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw fail("Invalid job ID");
    const job = await this.json(`jobs/${id}/job.json`, null);
    if (!job) throw fail("Job not found", 404);
    return job;
  }
  async saveJob(job) { job.updatedAt = now(); await this.write(`jobs/${job.id}/job.json`, job); }
  async reference() {
    const settings = await this.json("settings.json", {});
    if (settings.identityReference) return this.safe(settings.identityReference);
    for (const name of ["model-reference.png", "model-reference.jpeg", "model-reference.jpg"]) {
      try { return await this.safe(name); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return null;
  }
}

export function publicJob(job) {
  const copy = structuredClone(job); delete copy.internal; return copy;
}
export function stage(status = "pending") { return { status, attempts: 0, assetUrl: null, prompt: null, error: null, decision: null }; }
