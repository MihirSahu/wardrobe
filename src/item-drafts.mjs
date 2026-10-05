export function itemDraft(item) {
  return { name: item.name || "", part: item.part, color: item.color || "#9a9286", secondaryColor: item.secondaryColor || null, tags: [...(item.tags || [])] };
}

export function refreshItemDraft(item, { draft, baseline }) {
  const fresh = itemDraft(item); const merged = { ...fresh };
  for (const key of Object.keys(fresh)) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])) merged[key] = draft[key];
  }
  return { draft: merged, baseline: fresh };
}

export function itemDraftPatch(draft, baseline) {
  const canonical = (value) => ({ ...value, name: value.name.trim(), color: value.color?.toLowerCase() || null,
    secondaryColor: value.secondaryColor?.toLowerCase() || null, tags: value.tags.map((tag) => tag.trim()).filter(Boolean) });
  const current = canonical(draft); const previous = canonical(baseline);
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key])));
}

export function acknowledgeItemDraft(item, submitted, current) {
  const saved = itemDraft(item); const next = { ...current };
  for (const key of Object.keys(saved)) {
    if (JSON.stringify(current[key]) === JSON.stringify(submitted[key])) next[key] = saved[key];
  }
  return next;
}
