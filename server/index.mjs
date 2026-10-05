import http from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIPX, createIPXNodeServer, ipxFSStorage } from "ipx";
import { Store, inside } from "./store.mjs";
import { Codex } from "./codex.mjs";
import { Jobs } from "./jobs.mjs";
import { Backup } from "./backup.mjs";
import { createApi } from "./api.mjs";
import { stateDirectory } from "./state.mjs";
import { createLogger } from "./logging.mjs";

export async function application({ root = process.cwd(), dataDir = path.join(root, "data"), stateDir = process.env.WARDROBE_STATE_DIR || path.join(root, ".state"), codex: providedCodex, backupOptions = {}, log = createLogger() } = {}) {
  const store = await new Store(dataDir).init(); stateDir = await stateDirectory(stateDir, store.root);
  // Check existing child aliases before any credentials or checkpoints are written.
  for (const name of ["codex", "scratch", "receipts", "backup"]) await stateDirectory(path.join(stateDir, name), store.root);
  const codex = providedCodex || new Codex({ stateDir, binary: process.env.CODEX_BINARY || path.join(root, "node_modules/.bin/codex"), log });
  const jobs = await new Jobs(store, codex, stateDir, log).init();
  const backup = await new Backup(store, { stateDir, log, ...backupOptions }).init();
  const api = createApi({ store, codex, jobs, backup, log });
  const dist = path.join(root, "dist");
  const ipx = createIPXNodeServer(createIPX({ storage: ipxFSStorage({ dir: [path.join(root, "public"), dist] }) }));
  const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };
  const server = http.createServer((req, res) => {
    const started = performance.now(); const method = req.method; const pathname = req.url.split("?")[0];
    let finished = false;
    res.once("finish", () => { finished = true; log("http", "request", { method, path: pathname, status: res.statusCode, durationMs: Math.round(performance.now() - started) }); });
    res.once("close", () => { if (!finished) log("http", "closed", { method, path: pathname, durationMs: Math.round(performance.now() - started) }); });
    if (pathname === "/api/events") log("http", "stream opened", { method, path: pathname });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    void api(req, res, async () => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/_ipx/")) { req.url = req.url.slice(5); return ipx(req, res); }
      if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405); return res.end(); }
      try {
        const filename = path.resolve(dist, `.${decodeURIComponent(url.pathname)}`);
        if (!inside(dist, filename)) { res.writeHead(403); return res.end(); }
        let file;
        try { file = await realpath(filename); if (!inside(dist, file) || !(await stat(file)).isFile()) throw new Error("Invalid static file"); }
        catch { if (path.extname(filename)) { res.writeHead(404); return res.end(); } file = path.join(dist, "index.html"); }
        const bytes = await readFile(file);
        res.setHeader("Content-Type", contentTypes[path.extname(file)] || "application/octet-stream");
        res.setHeader("Cache-Control", path.basename(file) === "index.html" ? "no-cache" : "public, max-age=86400");
        res.end(req.method === "HEAD" ? undefined : bytes);
      } catch { res.writeHead(404); res.end("Build the frontend with sfw pnpm build"); }
    }).catch((error) => { log("http", "error", { method, path: pathname, error }); if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  server.requestTimeout = 120_000;
  async function close() {
    log("server", "stopping");
    api.close(); server.closeIdleConnections();
    const closed = server.listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
    // Stop dispatching before transport exit notifications can wake the queue again.
    const jobsClosed = jobs.close();
    await codex.close(); await jobsClosed; await backup.close(); await store.tail;
    await closed;
    log("server", "stopped");
  }
  log("server", "ready", { backupsConfigured: backup.status.configured });
  return { store, codex, jobs, backup, api, server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await application();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`Wardrobe listening on port ${port}`));
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; const force = setTimeout(() => process.exit(1), 30_000); force.unref(); await app.close(); clearTimeout(force); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
