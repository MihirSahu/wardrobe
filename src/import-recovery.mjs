export function failedImageStage(job) {
  return ["modeled", "garment"].find((name) => job.stages?.[name]?.status === "failed") || null;
}

export function canCleanGarment(job) {
  const state = job.stages?.garment;
  return state?.status === "failed" && Boolean(state.rawAsset && state.chromaKey && state.failedAssetUrl);
}
