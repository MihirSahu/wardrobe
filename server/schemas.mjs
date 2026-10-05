import Ajv from "ajv";
import { fail } from "./store.mjs";
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: "string", maxLength: 1200 };
const color = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" };
const part = { type: "string", enum: ["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"] };
export const clothesSchema = object({ items: { type: "array", maxItems: 8, items: object({
  name: { ...text, minLength: 1, maxLength: 120 }, part, color, secondaryColor: { anyOf: [color, { type: "null" }] },
  tags: { type: "array", maxItems: 12, items: { type: "string", maxLength: 40 } },
  boundingBox: object({ x: { type: "integer", minimum: 0, maximum: 999 }, y: { type: "integer", minimum: 0, maximum: 999 }, width: { type: "integer", minimum: 1, maximum: 1000 }, height: { type: "integer", minimum: 1, maximum: 1000 } }),
}) } });
export const outfitsSchema = object({ outfits: { type: "array", minItems: 1, maxItems: 12, items: object({
  name: { ...text, minLength: 1, maxLength: 120 }, garmentIds: { type: "array", minItems: 2, maxItems: 5, uniqueItems: true, items: { type: "string", maxLength: 100 } },
  reason: text, setting: text, occasion: { type: "array", maxItems: 5, items: { type: "string", maxLength: 80 } },
}) } });
const ajv = new Ajv();
const validators = new Map([[clothesSchema, ajv.compile(clothesSchema)], [outfitsSchema, ajv.compile(outfitsSchema)]]);
export function validate(schema, value) {
  if (!validators.get(schema)(value)) throw fail("Codex returned an invalid structured result. Review or explicitly retry the job.", 422);
  return value;
}
export function validateOutfits(value, inventory, count, existing = []) {
  validate(outfitsSchema, value);
  if (value.outfits.length !== count) throw fail(`Expected ${count} outfits, received ${value.outfits.length}`, 422);
  const records = new Map(inventory.map((item) => [item.id, item]));
  const combinations = new Set(existing.map((o) => [...o.garmentIds].sort().join("|")));
  for (const outfit of value.outfits) {
    const counts = {};
    for (const id of outfit.garmentIds) {
      const item = records.get(id); if (!item) throw fail("Outfit references a missing garment", 422);
      counts[item.part] = (counts[item.part] || 0) + 1;
    }
    if (counts.upperbody !== 1 || counts.lowerbody !== 1 || Object.values(counts).some((n) => n > 1)) throw fail("Each outfit needs one top, one bottom, and at most one of each supporting piece", 422);
    const key = [...outfit.garmentIds].sort().join("|");
    if (combinations.has(key)) throw fail("Codex proposed duplicate garment combinations", 422);
    combinations.add(key);
  }
  return value.outfits;
}
