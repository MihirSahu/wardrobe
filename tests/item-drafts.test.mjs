import test from "node:test";
import assert from "node:assert/strict";
import { acknowledgeItemDraft, itemDraft, itemDraftPatch, refreshItemDraft } from "../src/item-drafts.mjs";
import { normalizeMetadata } from "../server/image-ops.mjs";
import { testApp } from "./helpers.mjs";

const item = { name: "Tee", part: "upperbody", color: "#b72b30", secondaryColor: null, tags: ["cotton"] };

test("gallery save accepts the server's normalized tags and trimmed name", () => {
  const submitted = { ...itemDraft(item), name: " Edited tee ", tags: [" LINEN ", "Cotton"] };
  const saved = normalizeMetadata(submitted);
  assert.deepEqual(acknowledgeItemDraft(saved, submitted, submitted), itemDraft(saved));
  assert.deepEqual(saved.tags, ["linen", "cotton"]);
});

test("gallery save preserves newer local edits made during the request", () => {
  const submitted = { ...itemDraft(item), tags: ["LINEN"] };
  const current = { ...submitted, name: "New unsaved name", color: "#112233" };
  const saved = normalizeMetadata(submitted);
  const draft = acknowledgeItemDraft(saved, submitted, current);
  assert.equal(draft.name, "New unsaved name"); assert.equal(draft.color, "#112233");
  assert.deepEqual(draft.tags, ["linen"]);
});

test("gallery save does not overwrite tags changed while waiting", () => {
  const submitted = { ...itemDraft(item), name: " Edited tee ", tags: ["LINEN"] };
  const current = { ...submitted, tags: ["wool"] };
  const saved = normalizeMetadata(submitted);
  const draft = acknowledgeItemDraft(saved, submitted, current);
  assert.equal(draft.name, "Edited tee"); assert.deepEqual(draft.tags, ["wool"]);
});

test("dirty gallery fields survive remote updates while untouched fields refresh", () => {
  const baseline = itemDraft(item); const draft = { ...baseline, name: "My tee" };
  const remote = { ...item, tags: ["linen"], color: "#112233" };
  const refreshed = refreshItemDraft(remote, { draft, baseline });
  assert.equal(refreshed.draft.name, "My tee");
  assert.deepEqual(refreshed.draft.tags, ["linen"]); assert.equal(refreshed.draft.color, "#112233");
  assert.deepEqual(itemDraftPatch(refreshed.draft, refreshed.baseline), { name: "My tee" });
});

test("gallery name saves preserve remote tags before and after event refresh", async (t) => {
  const app = await testApp(t); const original = { ...item, id: "tee" };
  await app.store.lock(() => app.store.write("library.json", [original]));
  let state = { draft: { ...itemDraft(original), name: "My tee" }, baseline: itemDraft(original) };
  const first = await app.api("/api/import/wardrobe/tee", "PATCH", { metadata: { tags: ["linen"] } });
  assert.equal(first.status, 200);
  state = refreshItemDraft(first.value, state);
  // A second update arrives before this client receives its event.
  assert.equal((await app.api("/api/import/wardrobe/tee", "PATCH", { metadata: { tags: ["wool"] } })).status, 200);
  const patch = itemDraftPatch(state.draft, state.baseline);
  assert.deepEqual(patch, { name: "My tee" });
  const saved = await app.api("/api/import/wardrobe/tee", "PATCH", { metadata: patch });
  assert.equal(saved.status, 200); assert.equal(saved.value.name, "My tee");
  assert.deepEqual(saved.value.tags, ["wool"]);
  const acknowledged = acknowledgeItemDraft(saved.value, state.draft, { ...state.draft, color: "#112233" });
  assert.deepEqual(acknowledged.tags, ["wool"]);
  assert.deepEqual(itemDraftPatch(acknowledged, itemDraft(saved.value)), { color: "#112233" });
});
