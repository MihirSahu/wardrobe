import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { inside } from "./store.mjs";

export async function stateDirectory(directory, dataRoot) {
  const requested = path.resolve(directory);
  const separate = (candidate) => {
    if (inside(dataRoot, candidate) || inside(candidate, dataRoot)) throw new Error("Operational state and data directories must be separate");
  };
  separate(requested);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const canonical = await realpath(requested);
  separate(canonical);
  return canonical;
}
