import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshGate } from "../src/refresh-gate.mjs";

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function client() {
  const gate = createRefreshGate(); const state = { records: [], error: null, loading: true };
  const refresh = async (response) => {
    const current = gate.begin();
    try { const records = await response; if (current()) { state.records = records; state.error = null; } }
    catch (e) { if (current()) state.error = e.message; }
    finally { if (current()) state.loading = false; }
  };
  return { state, refresh, mutate(records) { gate.invalidate(); state.records = records; } };
}

test("late initial reads and errors cannot overwrite a newer event refresh", async () => {
  const app = client(); const initial = deferred(); const failed = deferred();
  const oldRead = app.refresh(initial.promise); const oldError = app.refresh(failed.promise);
  await app.refresh(Promise.resolve([{ id: "tee", name: "Fresh tee" }]));
  initial.resolve([{ id: "tee", name: "Original tee" }]); failed.reject(new Error("Old connection error"));
  await Promise.all([oldRead, oldError]);
  assert.deepEqual(app.state, { records: [{ id: "tee", name: "Fresh tee" }], error: null, loading: false });
});

test("pending reads cannot resurrect deleted items or revert a saved record", async () => {
  for (const saved of [[], [{ id: "tee", name: "Saved tee" }]]) {
    const app = client(); const response = deferred(); const read = app.refresh(response.promise);
    app.mutate(saved); response.resolve([{ id: "tee", name: "Original tee" }]); await read;
    assert.deepEqual(app.state.records, saved);
    await app.refresh(Promise.resolve(saved));
    assert.equal(app.state.loading, false);
  }
});
