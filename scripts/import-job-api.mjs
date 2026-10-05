// Compatibility exports for the repository's existing garment-processing skills.
// HTTP endpoints now live in server/api.mjs and run without Vite or an API key.
export { buildGarmentPrompt, frameTransparentGarment, processChromaBackground, removeChromaBackground } from "../server/image-ops.mjs";
