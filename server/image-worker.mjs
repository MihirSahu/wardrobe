import { parentPort, workerData } from "node:worker_threads";
import { cropDetectedItem, processChromaBackground, frameTransparentGarment, prepareGarment } from "./image-ops.mjs";
try {
  const { operation, bytes, options } = workerData;
  let result;
  if (operation === "crop") result = { bytes: await cropDetectedItem(Buffer.from(bytes), options.boundingBox) };
  else if (operation === "cleanup") result = await processChromaBackground(Buffer.from(bytes), options.key, options);
  else if (operation === "frame") result = { bytes: await frameTransparentGarment(Buffer.from(bytes)) };
  else if (operation === "garment") result = await prepareGarment(Buffer.from(bytes), options.key);
  else throw new Error("Unknown image operation");
  parentPort.postMessage(result);
} catch (error) { parentPort.postMessage({ error: error.message }); }
