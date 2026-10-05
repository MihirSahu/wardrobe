import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fixture, until } from "./helpers.mjs";

const launcher = fileURLToPath(new URL("../scripts/dev.mjs", import.meta.url));
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const action of ["SIGINT", "SIGTERM", "SIGHUP", "SIGKILL", "backend watcher exit"]) {
  test(`development ${action} stops both listeners and nested wrappers`, { skip: process.platform === "win32" }, async (t) => {
    const root = await fixture(t);
    await mkdir(path.join(root, "server")); await mkdir(path.join(root, "node_modules/vite/bin"), { recursive: true });
    const service = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((_, response) => response.end("probe"));
server.listen(0, "127.0.0.1", () => {
 console.log(process.env.WARDROBE_TEST_ROLE + " stdout probe"); console.error(process.env.WARDROBE_TEST_ROLE + " stderr probe");
 writeFileSync(process.env.WARDROBE_TEST_ROOT + "/" + process.env.WARDROBE_TEST_ROLE + ".json", JSON.stringify({pid: process.pid, parent: process.ppid, port: server.address().port, env: process.env.WARDROBE_TEST_ENV || null, logs: process.env.WARDROBE_LOGS}));
});
process.on("SIGTERM", () => server.close());
`;
    await writeFile(path.join(root, "service.mjs"), service);
    await writeFile(path.join(root, "server/index.mjs"), 'process.env.WARDROBE_TEST_ROLE = "backend"; await import("../service.mjs");');
    await writeFile(path.join(root, "web.mjs"), `import { spawn } from "node:child_process";
spawn(process.execPath, [process.env.WARDROBE_TEST_ROOT + "/service.mjs"], {stdio:"inherit", env:{...process.env, WARDROBE_TEST_ROLE:"frontend"}});
// Simulate a package-manager wrapper exiting without forwarding its signal.
process.on("SIGTERM", () => process.exit(0));
`);
    await writeFile(path.join(root, "node_modules/vite/bin/vite.js"), 'await import(process.env.WARDROBE_TEST_ROOT + "/web.mjs");');
    if (action === "SIGTERM") await writeFile(path.join(root, ".env"), "WARDROBE_TEST_ENV=loaded\n");
    const proc = spawn(process.execPath, [launcher], { cwd: root, env: { ...process.env, WARDROBE_TEST_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] });
    let diagnostics = ""; proc.stdout.on("data", (chunk) => { diagnostics += chunk; }); proc.stderr.on("data", (chunk) => { diagnostics += chunk; });
    let exited = false; const closed = new Promise((resolve) => proc.once("close", (code) => { exited = true; resolve(code); }));
    let backend, frontend;
    t.after(async () => {
      if (!exited) proc.kill("SIGTERM");
      for (const service of [backend, frontend]) if (service && running(service.pid)) process.kill(service.pid, "SIGKILL");
      await closed;
    });
    await until(async () => {
      try { backend = JSON.parse(await readFile(path.join(root, "backend.json"))); frontend = JSON.parse(await readFile(path.join(root, "frontend.json"))); return true; }
      catch { if (exited) throw new Error(diagnostics); return false; }
    });
    assert.equal(backend.env, action === "SIGTERM" ? "loaded" : null);
    assert.equal(backend.logs, "1");
    for (const role of ["backend", "frontend"]) for (const stream of ["stdout", "stderr"]) assert.ok(diagnostics.includes(`${role} ${stream} probe`), diagnostics);
    assert.doesNotMatch(diagnostics, /\.env not found/);
    for (const service of [backend, frontend]) assert.equal((await fetch(`http://127.0.0.1:${service.port}`)).status, 200);
    if (action === "backend watcher exit") process.kill(backend.parent, "SIGTERM"); else proc.kill(action);
    await until(() => exited, 10_000);
    const exitCode = await closed;
    if (!["backend watcher exit", "SIGKILL"].includes(action)) assert.equal(exitCode, 0, diagnostics);
    await until(() => !running(backend.pid) && !running(frontend.pid), 5000);
    for (const service of [backend, frontend]) await assert.rejects(fetch(`http://127.0.0.1:${service.port}`));
  });
}
