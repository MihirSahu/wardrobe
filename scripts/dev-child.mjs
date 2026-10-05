import { spawn } from "node:child_process";

// Keep an independent monitor alive long enough to stop a service when the
// outer sfw/pnpm launcher exits before its signal handler can finish.
const grouped = process.platform !== "win32";
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit", detached: grouped });
let stopping = false; let code = 0; let wait; let force;
const signal = (name) => {
  if (!child.pid) return;
  try { grouped ? process.kill(-child.pid, name) : child.kill(name); }
  catch (error) { if (error.code !== "ESRCH") console.error(`Development shutdown: ${error.message}`); }
};
const alive = () => {
  if (!child.pid) return false;
  if (!grouped) return child.exitCode === null && child.signalCode === null;
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};
const finish = () => {
  clearInterval(wait); clearTimeout(force); process.exitCode = code;
  if (process.connected) process.disconnect();
};
const stop = (exitCode = 0) => {
  if (stopping) return;
  stopping = true; code = exitCode; signal("SIGTERM");
  force = setTimeout(() => { signal("SIGKILL"); finish(); }, 35_000);
  wait = setInterval(() => { if (!alive()) finish(); }, 50);
};
process.on("message", (message) => { if (message?.type === "stop") stop(); });
process.on("disconnect", () => stop());
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, () => stop());
child.on("exit", (exitCode) => stop(exitCode ?? 1));
child.on("error", (error) => { console.error(`Development startup failed: ${error.message}`); stop(1); });
