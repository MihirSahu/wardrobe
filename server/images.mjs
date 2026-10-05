import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { fail } from "./store.mjs";

export async function normalize(bytes) {
  if (!bytes?.length || bytes.length > 25 * 1024 * 1024) throw fail("Choose an image smaller than 25 MB", 413);
  try {
    const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw fail("Choose a single still photo");
    return await image.rotate().resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true }).toColorspace("srgb").png().toBuffer();
  } catch (error) {
    if (error.status) throw error;
    throw fail("Could not decode this image. Try JPEG, PNG, or WebP; HEIC depends on the server decoder.", 422);
  }
}

// Pixel cleanup loops run off the HTTP event loop; Sharp itself uses native workers.
export function imageOperation(operation, bytes, options = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./image-worker.mjs", import.meta.url), {
      workerData: { operation, bytes, options },
      // Image files run independently of host --eval/--input-type and test-runner flags.
      execArgv: [],
    });
    worker.once("message", (result) => result.error ? reject(new Error(result.error)) : resolve({ ...result, bytes: Buffer.from(result.bytes) }));
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code) reject(new Error(`Image worker exited (${code})`)); });
  });
}
