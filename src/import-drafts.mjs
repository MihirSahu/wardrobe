export function defaultDraft(job) {
  const metadata = job.metadata || {};
  return {
    boundingBox: metadata.boundingBox || { x: 0, y: 0, width: 1000, height: 1000 },
    generateModeled: true,
    name: metadata.name || "New piece",
    part: metadata.part || "upperbody",
    color: metadata.color || "#d8d0c2",
    secondaryColor: metadata.secondaryColor || "",
    tags: Array.isArray(metadata.tags) ? metadata.tags.join(", ") : (metadata.tags || ""),
  };
}

export function importDraftPatch(draft, baseline) {
  const metadata = (value) => ({ name: value.name.trim(), part: value.part, color: value.color.toLowerCase(),
    secondaryColor: value.secondaryColor?.toLowerCase() || null,
    tags: value.tags.split(",").map((tag) => tag.trim()).filter(Boolean), boundingBox: value.boundingBox });
  const current = metadata(draft); const previous = metadata(baseline);
  return Object.fromEntries(Object.entries(current).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key])));
}

// Compare local fields with the last server values before applying fresh ones.
export function refreshDrafts(jobs, previous) {
  const drafts = {}; const baselines = {};
  for (const job of jobs) {
    const fresh = defaultDraft(job); const local = previous.drafts[job.id]; const baseline = previous.baselines[job.id];
    const merged = { ...fresh };
    if (local && baseline) for (const key of Object.keys(fresh)) {
      if (JSON.stringify(local[key]) !== JSON.stringify(baseline[key])) merged[key] = local[key];
    }
    drafts[job.id] = merged; baselines[job.id] = fresh;
  }
  return { drafts, baselines };
}

// Apply canonical saved values without discarding edits made during the request.
export function acknowledgeDraft(job, submitted, previous) {
  const local = previous.drafts[job.id];
  if (!local) return previous;
  const fresh = defaultDraft(job); const saved = { ...local };
  for (const key of Object.keys(fresh)) {
    if (key !== "generateModeled" && JSON.stringify(local[key]) === JSON.stringify(submitted[key])) saved[key] = fresh[key];
  }
  return { drafts: { ...previous.drafts, [job.id]: saved }, baselines: { ...previous.baselines, [job.id]: fresh } };
}
