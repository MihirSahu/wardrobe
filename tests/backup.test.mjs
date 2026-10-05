import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, symlink, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { fixture, MemoryS3 } from "./helpers.mjs";
import { Store } from "../server/store.mjs";
import { Backup, tree, restore, verifyExtract, sha256 } from "../server/backup.mjs";

test("full snapshots preserve hidden files, unknown extensions, empty directories, jobs, JSON, DBs and images", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init();
  await store.lock(async () => { await mkdir(store.file("empty")); await store.asset(".hidden", Buffer.from("hidden")); await store.asset("database.db", Buffer.from("database bytes")); await store.asset("imported/image.png", Buffer.from("image bytes")); await store.asset("unknown.xyz", Buffer.from("unknown")); });
  const client = new MemoryS3(); const backup = await new Backup(store, { stateDir: path.join(root, "state"), bucket: "test", region: "us-east-1", client }).init({ schedule: false }); t.after(() => backup.close());
  await backup.trigger(); assert.equal(backup.status.pendingChanges, false);
  const [snapshot] = await backup.snapshots(); assert.ok(snapshot.id);
  const destination = path.join(root, "restored");
  await restore({ client, bucket: "test", id: snapshot.id, destination, workDir: path.join(root, "restore-work") });
  assert.deepEqual(await tree(destination), await tree(store.root)); assert.equal(client.calls.includes("DeleteObjectCommand"), false);
  assert.equal([...client.objects.keys()].at(-1), `snapshots/${snapshot.id}/complete.json`);
  await assert.rejects(restore({ client, bucket: "test", id: snapshot.id, destination, workDir: path.join(root, "restore-work") }), /new directory/);
  assert.equal((await readFile(path.join(destination, ".hidden"))).toString(), "hidden");
});
test("failed archives never become recoverable; unsupported links fail explicitly", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init(); const client = new MemoryS3();
  const backup = await new Backup(store, { stateDir: path.join(root, "state"), bucket: "test", region: "us-east-1", client }).init({ schedule: false }); t.after(() => backup.close());
  await symlink("../outside", store.file("bad-link"));
  await assert.rejects(backup.trigger(), /Unsupported filesystem entry/); assert.equal((await backup.snapshots()).length, 0); assert.ok(backup.status.error);
  await unlink(store.file("bad-link"));
  const send = client.send.bind(client);
  client.send = async (command) => {
    if (command.constructor.name === "PutObjectCommand") throw new Error("Simulated S3 outage during upload");
    return send(command);
  };
  await assert.rejects(backup.trigger(), /S3 outage/);
  assert.equal((await backup.snapshots()).length, 0);
  await store.lock(() => store.write("settings.json", { stillUsable: true }));
  assert.equal((await store.json("settings.json")).stillUsable, true);
});
test("restore verifies archive digest and rejects links even with a matching archive checksum", async (t) => {
  const root = await fixture(t); const source = path.join(root, "source"); await mkdir(source); await symlink("../../outside", path.join(source, "escape"));
  const archive = path.join(root, "bad.tar.gz"); await tar.c({ file: archive, cwd: source, gzip: true }, ["."]);
  const destination = path.join(root, "destination"); await mkdir(destination);
  const manifest = { version: 1, files: [{ path: "escape", type: "file", size: 0, sha256: "0".repeat(64) }], archive: { size: (await stat(archive)).size, sha256: await sha256(archive) } };
  await assert.rejects(verifyExtract(archive, manifest, destination), /unexpected|linked|invalid/);
  manifest.archive.sha256 = "0".repeat(64); await assert.rejects(verifyExtract(archive, manifest, destination), /checksum/);
});

test("a new backup destination does not inherit the previous bucket's successful snapshot", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init(); const client = new MemoryS3();
  const options = { stateDir: path.join(root, "state"), region: "us-east-1", client };
  const first = await new Backup(store, { ...options, bucket: "first" }).init({ schedule: false });
  await first.trigger(); await first.close(); const count = client.calls.filter((c) => c === "PutObjectCommand").length;
  const second = await new Backup(store, { ...options, bucket: "second" }).init({ schedule: false }); t.after(() => second.close());
  assert.equal(second.status.lastSuccess, null);
  await second.trigger(false);
  assert.equal(client.calls.filter((c) => c === "PutObjectCommand").length, count + 2);
});

test("backup staging is removed even when saving backup status fails", async (t) => {
  const root = await fixture(t); const store = await new Store(path.join(root, "data")).init();
  const backup = await new Backup(store, { stateDir: path.join(root, "state"), bucket: "test", region: "us-east-1", client: new MemoryS3() }).init({ schedule: false }); t.after(() => backup.close());
  backup.saveStatus = async () => { throw new Error("Simulated status write failure"); };
  await assert.rejects(backup.trigger(), /status write failure/);
  assert.deepEqual((await readdir(backup.stateDir)).filter((name) => name.startsWith("snapshot-")), []);
});
