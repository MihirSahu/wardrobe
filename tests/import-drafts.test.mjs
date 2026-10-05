import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgeDraft, importDraftPatch, refreshDrafts } from "../src/import-drafts.mjs";
import { testApp } from "./helpers.mjs";

const empty = () => ({ drafts: {}, baselines: {} });
const job = (metadata = {}) => ({ id: "import", metadata: { name: "Tee", color: "#b72b30", tags: ["cotton"], ...metadata } });

test("pristine import fields follow remote metadata and crop changes", () => {
  const initial = refreshDrafts([job()], empty());
  const boundingBox = { x: 100, y: 200, width: 500, height: 600 };
  const next = refreshDrafts([job({ name: "Remote name", boundingBox, tags: ["linen"] })], initial);
  assert.equal(next.drafts.import.name, "Remote name");
  assert.deepEqual(next.drafts.import.boundingBox, boundingBox);
  assert.equal(next.drafts.import.tags, "linen");
});

test("refresh preserves locally edited fields while updating untouched fields", () => {
  const initial = refreshDrafts([job()], empty());
  initial.drafts.import.name = "Unsaved local name";
  initial.drafts.import.generateModeled = false;
  const boundingBox = { x: 20, y: 30, width: 700, height: 800 };
  let next = refreshDrafts([job({ name: "Remote name", boundingBox })], initial);
  next = refreshDrafts([job({ name: "Another remote name", boundingBox, color: "#001122" })], next);
  assert.equal(next.drafts.import.name, "Unsaved local name");
  assert.equal(next.drafts.import.generateModeled, false);
  assert.deepEqual(next.drafts.import.boundingBox, boundingBox);
  assert.equal(next.drafts.import.color, "#001122");
});

test("local crop edits survive remote updates and become pristine once saved", () => {
  const initial = refreshDrafts([job()], empty());
  const boundingBox = { x: 10, y: 20, width: 700, height: 800 };
  initial.drafts.import.boundingBox = boundingBox;
  const next = refreshDrafts([job({ name: "Remote name" })], initial);
  assert.deepEqual(next.drafts.import.boundingBox, boundingBox);
  assert.equal(next.drafts.import.name, "Remote name");
  const saved = refreshDrafts([job({ name: "Remote name", boundingBox })], next);
  const updated = refreshDrafts([job()], saved);
  assert.deepEqual(updated.drafts.import.boundingBox, { x: 0, y: 0, width: 1000, height: 1000 });
});

test("completed imports release their draft and baseline", () => {
  const initial = refreshDrafts([job()], empty());
  assert.deepEqual(refreshDrafts([], initial), empty());
});

test("normalized saved values become pristine and follow later remote edits", () => {
  const initial = refreshDrafts([job()], empty());
  initial.drafts.import.name = " Local tee "; initial.drafts.import.tags = " Cotton, LINEN ";
  const submitted = structuredClone(initial.drafts.import);
  const saved = acknowledgeDraft(job({ name: "Local tee", tags: ["cotton", "linen"] }), submitted, initial);
  assert.equal(saved.drafts.import.name, "Local tee");
  assert.equal(saved.drafts.import.tags, "cotton, linen");
  const updated = refreshDrafts([job({ name: "Remote rename", tags: ["wool"] })], saved);
  assert.equal(updated.drafts.import.name, "Remote rename");
  assert.equal(updated.drafts.import.tags, "wool");
});

test("save acknowledgement preserves edits made while the save was pending", () => {
  const initial = refreshDrafts([job()], empty());
  initial.drafts.import.name = "First local name";
  const submitted = structuredClone(initial.drafts.import);
  initial.drafts.import.name = "Newer local name"; initial.drafts.import.generateModeled = false;
  const saved = acknowledgeDraft(job({ name: "First local name" }), submitted, initial);
  const updated = refreshDrafts([job({ name: "Remote name", color: "#001122" })], saved);
  assert.equal(updated.drafts.import.name, "Newer local name");
  assert.equal(updated.drafts.import.generateModeled, false);
  assert.equal(updated.drafts.import.color, "#001122");
  assert.deepEqual(acknowledgeDraft(job(), submitted, empty()), empty());
});

test("import preview and approval metadata preserve another device's unseen fields", async (t) => {
  const app = await testApp(t); const uploaded = await app.upload(); const id = uploaded.value.jobs[0].id;
  const original = uploaded.value.jobs[0];
  const state = refreshDrafts([original], empty());
  state.drafts[id].name = "My local tee";
  const boundingBox = { x: 40, y: 60, width: 500, height: 600 };
  const remote = await app.api(`/api/import/jobs/${id}/metadata`, "PATCH", { metadata: { color: "#112233", tags: ["wool"], boundingBox } });
  assert.equal(remote.status, 200);
  // The saving client has not received any of the remote changes yet.
  const metadata = importDraftPatch(state.drafts[id], state.baselines[id]);
  assert.deepEqual(metadata, { name: "My local tee" });
  const saved = await app.api(`/api/import/jobs/${id}/metadata`, "PATCH", { metadata });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.metadata.name, "My local tee");
  assert.equal(saved.value.metadata.color, "#112233");
  assert.deepEqual(saved.value.metadata.tags, ["wool"]);
  assert.deepEqual(saved.value.metadata.boundingBox, boundingBox);
  const acknowledged = acknowledgeDraft(saved.value, state.drafts[id], state);
  assert.deepEqual(importDraftPatch(acknowledged.drafts[id], acknowledged.baselines[id]), {});
});
