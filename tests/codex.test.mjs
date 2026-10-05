import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Codex, safeError } from "../server/codex.mjs";
import { fixture, until } from "./helpers.mjs";

for (const delayedMethod of ["account/read", "account/rateLimits/read", "model/list"]) {
  test(`logout invalidates a pending ${delayedMethod} refresh without resuming the queue`, async (t) => {
    const c = new Codex({ stateDir: await fixture(t) }); c.ready = true;
    let release; let captured = false; let disconnected = false;
    const responses = (method) => method === "account/read" ? { account: disconnected ? null : { type: "chatgpt", planType: "plus" } }
      : method === "model/list" ? { data: [{ model: "test", isDefault: true }] } : { rateLimits: { primary: { usedPercent: 10 } } };
    c.rpc = async (method) => {
      if (method === "account/logout") { disconnected = true; return {}; }
      if (method === delayedMethod && !captured) { captured = true; const value = responses(method); return new Promise((resolve) => { release = () => resolve(value); }); }
      return responses(method);
    };
    let resumed = false;
    c.on("change", () => { if (disconnected && c.status.connected) resumed = true; });
    const refreshing = c.refresh();
    await until(() => Boolean(release));
    await c.logout();
    release(); await refreshing;
    assert.equal(c.status.connected, false); assert.equal(c.status.planType, null);
    assert.deepEqual(c.status.models, []); assert.equal(c.status.rateLimits, null);
    assert.equal(resumed, false);
  });
}

test("a newer refresh supersedes delayed account reads and errors", async (t) => {
  for (const failure of [false, true]) {
    const c = new Codex({ stateDir: await fixture(t) }); c.ready = true;
    let release; let reads = 0;
    c.rpc = async (method) => {
      if (method === "account/read" && ++reads === 1) return new Promise((resolve, reject) => { release = () => failure ? reject(new Error("Old account read failed")) : resolve({ account: { type: "chatgpt", planType: "plus" } }); });
      return { account: null };
    };
    const older = c.refresh();
    await until(() => Boolean(release));
    await c.refresh(); release(); await older;
    assert.equal(c.status.connected, false); assert.equal(c.status.error, null);
  }
});

test("disconnect notifications invalidate pending reads and refreshes during logout stay disconnected", async (t) => {
  const c = new Codex({ stateDir: await fixture(t) }); c.ready = true;
  let releaseRead; let releaseLogout; let reads = 0;
  c.rpc = async (method) => {
    if (method === "account/read") {
      reads++;
      if (reads === 1) return new Promise((resolve) => { releaseRead = () => resolve({ account: { type: "chatgpt", planType: "plus" } }); });
      return { account: null };
    }
    if (method === "account/logout") return new Promise((resolve) => { releaseLogout = resolve; });
    return {};
  };
  const refreshing = c.refresh();
  await until(() => Boolean(releaseRead));
  c.message({ method: "account/updated", params: { authMode: null } });
  releaseRead(); await refreshing;
  assert.equal(c.status.connected, false);
  const loggingOut = c.logout();
  await until(() => Boolean(releaseLogout));
  await c.refresh(); assert.equal(reads, 1);
  c.message({ method: "account/updated", params: { authMode: "chatgpt" } });
  assert.equal(c.status.connected, false);
  releaseLogout({}); await loggingOut;
  assert.equal(c.status.connected, false);
});

test("a connection notification supersedes pending login refreshes and loads current models", async (t) => {
  const c = new Codex({ stateDir: await fixture(t) }); c.ready = true;
  let release; let reads = 0;
  c.rpc = async (method) => {
    if (method === "account/read") {
      if (++reads === 1) return new Promise((resolve) => { release = () => resolve({ account: null }); });
      return { account: { type: "chatgpt", planType: "plus" } };
    }
    return method === "model/list" ? { data: [{ model: "test", isDefault: true }] } : { rateLimits: {} };
  };
  const refreshing = c.refresh(); await until(() => Boolean(release));
  c.message({ method: "account/updated", params: { authMode: "chatgpt" } });
  await until(() => c.status.models.length === 1);
  release(); await refreshing;
  assert.equal(c.status.connected, true); assert.equal(c.status.models[0].model, "test");
});

test("a delayed device-login response cannot restore a cancelled sign-in after logout", async (t) => {
  const c = new Codex({ stateDir: await fixture(t) }); c.ready = true;
  let release; const cancelled = [];
  c.rpc = async (method, params) => {
    if (method === "account/login/start") return new Promise((resolve) => { release = resolve; });
    if (method === "account/login/cancel") cancelled.push(params.loginId);
    return method === "account/read" ? { account: null } : {};
  };
  const login = c.login(); const failed = assert.rejects(login, { status: 409 });
  await until(() => Boolean(release)); await c.logout();
  release({ type: "chatgptDeviceCode", loginId: "old-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "OLD-CODE" });
  await failed;
  assert.equal(c.status.login, null); assert.equal(c.status.connected, false);
  assert.deepEqual(cancelled, ["old-login"]);
});

test("installed native app-server accepts the restricted profile before inference", async (t) => {
  const root = await fixture(t);
  const binary = fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url));
  const c = new Codex({ stateDir: root, binary }); t.after(() => c.close());
  await c.start();
  // Exercise production thread creation with a fresh credential-free home.
  // Stop at turn/start so this test never submits a model request or uses quota.
  c.status.connected = true; c.status.models = [{ model: "gpt-5.6-sol", isDefault: true }];
  const rpc = c.rpc.bind(c); let thread; let turnParams;
  c.rpc = async (method, params) => {
    if (method === "turn/start") { turnParams = params; throw new Error("Stopped before inference"); }
    const result = await rpc(method, params);
    if (method === "thread/start") thread = result;
    return result;
  };
  await assert.rejects(c.run({ scratch: c.work, prompt: "Preflight only" }), /Stopped before inference/);
  assert.equal(thread.activePermissionProfile.id, "wardrobe");
  assert.equal(thread.approvalPolicy, "never");
  assert.deepEqual(thread.sandbox, { type: "readOnly", networkAccess: false });
  assert.equal(turnParams.permissions, "wardrobe");
  assert.equal(turnParams.sandboxPolicy, undefined);
});

test("managed device login, sanitized configuration, early image completion and structured turns", async (t) => {
  const root = await fixture(t); let environment;
  const c = new Codex({ stateDir: root, spawnProcess: (_, __, opts) => { environment = opts.env; return spawn(process.execPath, [fileURLToPath(new URL("./codex-fixture.mjs", import.meta.url))], opts); } }); t.after(() => c.close());
  await c.refresh(); assert.equal(c.status.connected, true);
  assert.equal(environment.CODEX_HOME, path.join(root, "codex")); assert.equal(environment.OPENAI_API_KEY, undefined); assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  const config = await readFile(path.join(root, "codex/config.toml"), "utf8"); assert.match(config, /shell_tool = false/); assert.match(config, /forced_login_method = "chatgpt"/);
  assert.match(config, /code_mode_host = true/);
  const login = await c.login(); assert.equal(login.verificationUrl, "https://auth.openai.com/codex/device"); await c.cancelLogin(); assert.equal(c.status.login, null);
  const scratch = path.join(c.work, "request"); await mkdir(scratch); let result;
  await c.run({ scratch, prompt: "Generate", onImage: async (bytes) => { result = bytes.toString(); } }); assert.equal(result, "image bytes");
  assert.deepEqual(await c.run({ scratch, prompt: "Analyze", schema: { type: "object" } }), { answer: "ok" });
  const logoutEvents = []; c.on("change", () => logoutEvents.push(c.status.connected));
  await c.logout(); assert.equal(c.status.connected, false); assert.ok(logoutEvents.every((connected) => !connected), "Logout must not resume an authentication-paused queue");
});

test("native output path must stay in scratch/generated_images and usage errors are recoverable", async (t) => {
  const root = await fixture(t); const c = new Codex({ stateDir: root }); const scratch = path.join(root, "scratch/request"); await mkdir(scratch, { recursive: true });
  const outside = path.join(root, "credential.txt"); await writeFile(outside, "private");
  await assert.rejects(c.imageBytes({ status: "completed", savedPath: outside }, scratch), /outside/);
  await assert.rejects(c.imageBytes({ failure: { type: "usageLimitExceeded" } }, scratch), { status: 429 });
  assert.equal(safeError("Bearer secret sk-testtoken eyJtest.payload.signature refresh_token=secret"), "Bearer [redacted] [redacted] [redacted] refresh_token=[redacted]");
});

test("cancellation waits for the native turn to stop and checkpoints late completed image bytes", async (t) => {
  const root = await fixture(t);
  const c = new Codex({ stateDir: root, spawnProcess: (_, __, opts) => spawn(process.execPath, [fileURLToPath(new URL("./codex-fixture.mjs", import.meta.url))], opts) }); t.after(() => c.close());
  await c.refresh(); const scratch = path.join(c.work, "request"); await mkdir(scratch);
  const controller = new AbortController(); let images = 0;
  const rpc = c.rpc.bind(c); let rejectInterrupt;
  c.rpc = (method, params) => method === "turn/interrupt" ? new Promise((_, reject) => { rejectInterrupt = reject; }) : rpc(method, params);
  await assert.rejects(c.run({ scratch, prompt: "Wait for cancellation", signal: controller.signal, onProgress: () => controller.abort(), onImage: async () => { images++; } }), /Cancelled|interrupted/);
  assert.equal(images, 1, "The worker must not dispatch another request while the previous native turn is still running");
  rejectInterrupt(new Error("Delayed interrupt RPC failure"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(c.status.available, true, "A late interrupt error must not terminate the transport after the canceled turn ended");
});
