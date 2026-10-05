import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Store } from "../server/store.mjs";
import { Jobs } from "../server/jobs.mjs";
import { restore } from "../server/backup.mjs";
import { testApp, FakeCodex, MemoryS3, until, cutout, detected } from "./helpers.mjs";

for (const [name, extension] of [["garment", "json"], ["garment", "png"], ["analysis", "json"]]) {
  test(`a failed ${name} ${extension} receipt still backs up and restores completed output without generating again`, async (t) => {
    const client = new MemoryS3();
    const app = await testApp(t, { backupOptions: { bucket: "test", region: "us-east-1", client } });
    const rename = fs.promises.rename; let injected = false; let id;
    fs.promises.rename = async (source, target) => {
      if (!injected && path.dirname(target) === app.jobs.receipts && target.endsWith(`-${name}-1.${extension}`)) {
        injected = true;
        throw Object.assign(new Error("Simulated full operational volume"), { code: "ENOSPC" });
      }
      return rename(source, target);
    };
    syncBuiltinESMExports();
    try {
      id = (await app.upload(name !== "analysis")).value.jobs[0].id;
      if (name === "garment") assert.equal((await app.approveImport(id, "crop")).status, 200);
      await until(async () => (await app.store.job(id)).stages[name].status === "failed");
    } finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
    await app.jobs.close();
    assert.equal(injected, true);
    assert.equal(app.codex.calls.length, 1);
    const relative = `jobs/${id}/${name === "garment" ? "garment-1-source.png" : "attempt-analysis-1-result.json"}`;
    const saved = await readFile(app.store.file(relative));
    if (name === "garment") assert.deepEqual(saved, await cutout());
    else assert.deepEqual(JSON.parse(saved), detected);

    await app.backup.trigger();
    const [snapshot] = await app.backup.snapshots();
    const destination = path.join(app.root, "restored-data");
    const manifest = await restore({ client, bucket: "test", id: snapshot.id, destination, workDir: path.join(app.root, "restore-work") });
    assert.ok(manifest.files.some((file) => file.path === relative));
    assert.deepEqual(await readFile(path.join(destination, relative)), saved);

    const store = await new Store(destination).init();
    const codex = new FakeCodex(app.root); codex.status.connected = false;
    const jobs = await new Jobs(store, codex, path.join(app.root, "new-state")).init();
    t.after(() => jobs.close());
    await store.lock(async () => { const job = await store.job(id); job.stages[name].status = "queued"; await store.saveJob(job); });
    await until(async () => (await store.job(id)).stages[name].status === (name === "garment" ? "review" : "complete"));
    assert.equal(codex.calls.length, 0, "Restored data must finish without another AI request or authentication");
    assert.equal((await store.job(id)).stages[name].attempts, 1);
    if (name === "analysis") {
      const children = (await store.jobs()).filter((job) => job.parentId === id);
      assert.equal(children.length, 1); assert.equal(children[0].stages.crop.status, "review");
    }
  });
}
