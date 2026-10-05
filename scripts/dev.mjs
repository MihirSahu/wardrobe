import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Configuration is optional; only ask Node to load a file that exists.
const envArgs = existsSync(".env") ? ["--env-file=.env"] : [];
const monitor = fileURLToPath(new URL("./dev-child.mjs", import.meta.url));
const options = { stdio: ["inherit", "inherit", "inherit", "ipc"], detached: process.platform !== "win32" };
const server = spawn(process.execPath, [monitor, process.execPath, ...envArgs, "--watch", "server/index.mjs"], { ...options, env: { ...process.env, WARDROBE_LOGS: process.env.WARDROBE_LOGS ?? "1" } });
// The outer `sfw pnpm dev` already launches this supervisor. Running another
// sfw/pnpm wrapper here creates a separate process group beyond our supervision.
const web = spawn(process.execPath, [monitor, process.execPath, "node_modules/vite/bin/vite.js"], options);
const children = [server, web];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true; process.exitCode = code;
  for (const child of children) {
    if (child.connected) child.send({ type: "stop" }, (error) => { if (error) child.kill("SIGTERM"); });
    else if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
};
for (const child of children) {
  child.on("exit", (code) => stop(code ?? 1));
  child.on("error", (error) => { console.error(`Development startup failed: ${error.message}`); stop(1); });
}
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => stop());
