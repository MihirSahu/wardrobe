import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, readdir, symlink } from "node:fs/promises";
import path from "node:path";
import { application } from "../server/index.mjs";
import { Store, inside } from "../server/store.mjs";
import { Backup } from "../server/backup.mjs";
import { FakeCodex, fixture } from "./helpers.mjs";

test("startup rejects state aliases into data or its ancestors before writing operational files", async (t) => {
  const root = await fixture(t);
  const dataDir = path.join(root, "data");
  const target = path.join(dataDir, "operational");
  await mkdir(target, { recursive: true });
  for (const [name, destination] of [["into-data", target], ["ancestor", root]]) {
    const alias = path.join(root, name); await symlink(destination, alias);
    await assert.rejects(application({ root, dataDir, stateDir: alias, codex: new FakeCodex(root) }), /must be separate/);
  }
  assert.deepEqual(await readdir(target), []);
});

test("startup rejects each operational child alias into data", async (t) => {
  const root = await fixture(t); const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  for (const name of ["codex", "scratch", "receipts", "backup"]) {
    const stateDir = path.join(root, `state-${name}`); await mkdir(stateDir);
    await symlink(dataDir, path.join(stateDir, name));
    await assert.rejects(application({ root, dataDir, stateDir, codex: new FakeCodex(root) }), /must be separate/);
    assert.equal((await readdir(dataDir)).includes("status.json"), false);
    assert.equal((await readdir(dataDir)).includes("queue.json"), false);
  }
});

test("external state aliases stay usable and backup staging is canonical and outside data", async (t) => {
  const root = await fixture(t); const target = path.join(root, "external-state");
  await mkdir(target); const alias = path.join(root, "state-link"); await symlink(target, alias);
  const app = await application({ root, stateDir: alias, codex: new FakeCodex(root), backupOptions: { bucket: "", region: "us-east-1", schedule: false } });
  t.after(() => app.close());
  assert.equal(app.backup.stateDir, await realpath(path.join(target, "backup")));
  assert.equal(inside(app.store.root, app.backup.stateDir), false);
  await app.jobs.pause("test", "Check operational persistence");
  assert.ok((await readdir(target)).includes("queue.json"));
  assert.equal((await readdir(app.store.root)).includes("queue.json"), false);
});

test("direct Backup use also rejects staging aliases into data", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init();
  const stateDir = path.join(root, "state"); await mkdir(stateDir);
  await symlink(store.root, path.join(stateDir, "backup"));
  const backup = new Backup(store, { stateDir, bucket: "test", region: "us-east-1" });
  t.after(() => backup.close());
  await assert.rejects(backup.init({ schedule: false }), /must be separate/);
  assert.equal((await readdir(store.root)).some((name) => name.startsWith("snapshot-")), false);
});
