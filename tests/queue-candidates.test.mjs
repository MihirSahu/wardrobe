import test from "node:test";
import assert from "node:assert/strict";
import { testApp, until, cutout } from "./helpers.mjs";

test("disconnect intent prevents a connection refresh from resuming the queue during pause persistence", async (t) => {
  const app = await testApp(t);
  let release; let entered = false; let resumed = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const pause = app.jobs.pause.bind(app.jobs); const resume = app.jobs.resume.bind(app.jobs);
  app.jobs.pause = async (...args) => { const pending = pause(...args); entered = true; await gate; await pending; };
  app.jobs.resume = async () => { resumed++; await resume(); };
  app.codex.logout = async () => { app.codex.status.connected = false; app.codex.emit("change"); };
  const disconnecting = app.api("/api/connection/logout", "POST");
  try {
    await until(() => entered);
    app.codex.emit("change");
    assert.equal(app.codex.status.connected, false); assert.equal(resumed, 0);
  } finally { release(); }
  const disconnected = await disconnecting;
  assert.equal(disconnected.status, 200); assert.equal(disconnected.value.connected, false);
  assert.equal(app.jobs.status.paused, true); assert.equal(resumed, 0);
});

test("manual entry wins over a queued analysis awaiting authentication refresh", async (t) => {
  const app = await testApp(t);
  let reached, release;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  app.codex.refresh = async () => { reached(); await gate; return app.codex.status; };
  const id = (await app.upload(false)).value.jobs[0].id;
  await waiting;
  try {
    const manual = await app.api(`/api/import/jobs/${id}/manual`, "POST");
    assert.equal(manual.status, 200); assert.equal(manual.value.stages.analysis.status, "skipped");
  } finally { release(); }
  await until(() => !app.jobs.running);
  const job = await app.store.job(id);
  assert.equal(job.stages.analysis.status, "skipped"); assert.equal(job.stages.analysis.error, null);
  assert.equal(job.stages.crop.status, "review"); assert.equal(app.codex.calls.length, 0);
});

test("fresh regeneration supersedes a queue candidate that recovered an old receipt", async (t) => {
  const app = await testApp(t); const id = (await app.upload()).value.jobs[0].id;
  await app.approveImport(id, "crop");
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
  let reached, release; let held = false;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const recover = app.jobs.recoverReceipt.bind(app.jobs);
  app.jobs.recoverReceipt = async (job, name) => {
    const receipt = await recover(job, name);
    if (!held && job.id === id && name === "garment") { held = true; reached(); await gate; }
    return receipt;
  };
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/retry`, "POST")).status, 200);
  await waiting;
  try {
    assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/regenerate`, "POST", { prompt: "New presentation" })).status, 200);
  } finally { release(); }
  await until(async () => { const job = await app.store.job(id); return job.stages.garment.status === "review" && job.stages.garment.attempts === 2; });
  assert.equal(app.codex.calls.length, 2); assert.match(app.codex.calls[1].prompt, /New presentation/);
});

test("a cancelled processing stage can be explicitly retried after its turn ends", async (t) => {
  const app = await testApp(t); let started;
  const running = new Promise((resolve) => { started = resolve; });
  const run = app.codex.run.bind(app.codex); let first = true;
  app.codex.run = async (request) => {
    if (!first) return run(request);
    first = false; started();
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("Cancelled; completion may be uncertain")), { once: true }));
  };
  const id = (await app.upload()).value.jobs[0].id;
  await app.approveImport(id, "crop"); await running;
  assert.equal((await app.api(`/api/import/jobs/${id}/cancel`, "POST")).status, 200);
  await until(() => !app.jobs.running);
  assert.equal((await app.store.job(id)).status, "cancelled");
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/retry`, "POST")).status, 200);
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
});

test("shutdown during authentication refresh does not dispatch a new turn", async (t) => {
  const app = await testApp(t); let reached, release;
  const waiting = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  app.codex.refresh = async () => { reached(); await gate; return app.codex.status; };
  const id = (await app.upload(false)).value.jobs[0].id; await waiting;
  const closing = app.jobs.close(); release(); await closing;
  assert.equal(app.codex.calls.length, 0); assert.equal((await app.store.job(id)).stages.analysis.status, "queued");
});

test("cancellation holds the queue until late image checkpointing ends and retry reuses it", async (t) => {
  const app = await testApp(t); let started, finish; let requests = 0;
  const running = new Promise((resolve) => { started = resolve; });
  const completion = new Promise((resolve) => { finish = resolve; });
  app.codex.run = async (request) => {
    requests++; started();
    await new Promise((resolve) => request.signal.addEventListener("abort", resolve, { once: true }));
    await completion;
    await request.onImage(await cutout(), { type: "imageGeneration", status: "completed" });
    throw new Error("Cancelled; completion may be uncertain");
  };
  const id = (await app.upload()).value.jobs[0].id;
  await app.approveImport(id, "crop"); await running;
  try {
    assert.equal((await app.api(`/api/import/jobs/${id}/cancel`, "POST")).status, 200);
    assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/retry`, "POST")).status, 409);
    assert.equal(app.jobs.running, true);
  } finally { finish(); }
  await until(() => !app.jobs.running);
  assert.equal((await app.store.job(id)).stages.garment.status, "failed");
  assert.equal((await app.api(`/api/import/jobs/${id}/stages/garment/retry`, "POST")).status, 200);
  await until(async () => (await app.store.job(id)).stages.garment.status === "review");
  assert.equal(requests, 1);
});
