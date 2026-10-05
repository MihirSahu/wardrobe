import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLogger, streamDiagnostics } from "../server/logging.mjs";
import { Codex } from "../server/codex.mjs";
import { fixture, testApp, until, MemoryS3 } from "./helpers.mjs";

function capture() { const lines = []; return { lines, log: createLogger({ enabled: true, sink: (line) => lines.push(line) }) }; }

test("terminal logs redact credentials, encoded images and nested payloads and tolerate failed sinks", () => {
  const { log, lines } = capture();
  log("probe", "error", { error: new Error('refresh_token="quoted secret" api_key=another-secret Bearer bearer-secret sk-test-key eyJabc.payload.signature AWS_SECRET_ACCESS_KEY="raw-aws-secret" https://proxy-user:proxy-secret@localhost'), userCode: "DEVICE-CODE", nested: { AWS_SECRET_ACCESS_KEY: "aws-secret", result: "private output", prompt: "private prompt" }, bytes: Buffer.from("private bytes"), message: 'data:image/png;base64,aW1hZ2UgYnl0ZXM= ' + "A".repeat(200) });
  const output = lines.join("\n");
  for (const secret of ["quoted secret", "another-secret", "bearer-secret", "sk-test-key", "eyJabc.payload.signature", "DEVICE-CODE", "aws-secret", "raw-aws-secret", "proxy-secret", "proxy-user", "private output", "private prompt", "private bytes", "aW1hZ2UgYnl0ZXM=", "A".repeat(120)]) assert.ok(!output.includes(secret), secret);
  assert.match(output, /^\d{4}-.* \[probe\] error /); assert.match(output, /redacted/);
  createLogger({ enabled: false, sink: () => assert.fail("disabled logger emitted") })("probe", "event");
  assert.doesNotThrow(() => createLogger({ enabled: true, sink: () => { throw new Error("closed terminal"); } })("probe", "event"));
});

test("native diagnostic streaming joins chunks, bounds oversized lines and flushes the last line", async () => {
  const { log, lines } = capture(); const stream = new PassThrough(); streamDiagnostics(stream, log);
  const ended = once(stream, "end");
  stream.write('warning refresh_token="chunk'); stream.write('ed-secret"\n');
  stream.write("X".repeat(9000)); stream.write("\nlast diagnostic"); stream.end(); await ended;
  assert.equal(lines.length, 3); assert.match(lines[0], /warning/); assert.ok(!lines[0].includes("chunked-secret"));
  assert.match(lines[1], /Oversized diagnostic omitted/); assert.match(lines[2], /last diagnostic/);
});

test("Codex logs diagnostics, RPC failures and turn progress without protocol payloads or device codes", async (t) => {
  const root = await fixture(t); const { log, lines } = capture();
  const c = new Codex({ stateDir: root, log, spawnProcess: (_, __, options) => spawn(process.execPath, [fileURLToPath(new URL("./codex-fixture.mjs", import.meta.url))], options) }); t.after(() => c.close());
  await c.refresh(); await c.login();
  await c.run({ scratch: c.work, prompt: "PRIVATE_TASK", onImage: async () => {} });
  await assert.rejects(c.rpc("fixture/error"), /Diagnostic failure/);
  await until(() => lines.some((line) => line.includes("Diagnostic probe")));
  const output = lines.join("\n");
  for (const text of ["[codex] stderr", "thread/start", "turn/start", "item/completed", "imageGeneration", "request failed", "Diagnostic failure"]) assert.ok(output.includes(text), text);
  for (const secret of ["FIXTURE_SECRET", "FIXTURE_KEY", "TEST-CODE", "PRIVATE_TASK", "aW1hZ2UgYnl0ZXM="]) assert.ok(!output.includes(secret), secret);
});

test("request, job and backup lifecycle logs reach the application sink without request bodies or query secrets", async (t) => {
  const { log, lines } = capture(); const app = await testApp(t, { log, backupOptions: { bucket: "test", region: "us-east-1", client: new MemoryS3() } });
  await fetch(app.base + "/api/health?token=QUERY_SECRET");
  await fetch(app.base + "/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "BODY_SECRET" }) });
  const job = (await app.upload(false)).value.jobs[0];
  await until(async () => (await app.store.job(job.id)).stages.analysis.status === "complete");
  await until(() => lines.some((line) => line.includes("[job] finished")));
  await app.backup.trigger();
  const output = lines.join("\n");
  for (const text of ["[http] request", '"status":200', "[api] error", "[job] started", "[job] finished", "[backup] uploading", "[backup] completed"]) assert.ok(output.includes(text), text);
  assert.ok(!output.includes("QUERY_SECRET")); assert.ok(!output.includes("BODY_SECRET"));
});
