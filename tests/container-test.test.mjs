import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, readdir, symlink, writeFile, access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./helpers.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/container-test.sh", import.meta.url));
const config = fileURLToPath(new URL("../compose.test.yaml", import.meta.url));

async function runner(t) {
  const root = path.join(await realpath(await fixture(t)), "repo with spaces");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "data", "empty"), { recursive: true });
  await mkdir(path.join(root, "bin"));
  await copyFile(script, path.join(root, "scripts/container-test.sh"));
  await copyFile(config, path.join(root, "compose.test.yaml"));
  await writeFile(path.join(root, "data/library.json"), "[]\n");
  await writeFile(path.join(root, "data/.hidden"), "hidden bytes");
  const marker = path.join(root, "env-was-executed");
  await writeFile(path.join(root, ".env"), `AWS_SECRET_ACCESS_KEY=$(touch "${marker}")\n`);
  const calls = path.join(root, "docker-calls.jsonl");
  const mock = `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CONTAINER_TEST_CALLS, JSON.stringify({ args: process.argv.slice(2), port: process.env.WARDROBE_TEST_PORT, uid: process.env.WARDROBE_TEST_UID, gid: process.env.WARDROBE_TEST_GID }) + "\\n");
`;
  await writeFile(path.join(root, "bin/docker"), mock, { mode: 0o700 });
  const run = (...args) => execute("bash", [path.join(root, "scripts/container-test.sh"), ...args], {
    cwd: path.dirname(root), env: { ...process.env, PATH: `${path.join(root, "bin")}:${process.env.PATH}`, CONTAINER_TEST_CALLS: calls, WARDROBE_TEST_PORT: "3001" },
  });
  const readCalls = async () => (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  return { root, run, readCalls, marker, testData: path.join(root, ".state/container-test/data") };
}

test("container runner copies all data once, preserves test edits and loads env without shell execution", async (t) => {
  const app = await runner(t);
  const result = await app.run("--port", "3002", "up");
  assert.equal(await readFile(path.join(app.testData, ".hidden"), "utf8"), "hidden bytes");
  assert.deepEqual(await readdir(path.join(app.testData, "empty")), []);
  await assert.rejects(access(app.marker), { code: "ENOENT" });
  assert.match(result.stdout, /http:\/\/localhost:3002/);
  assert.doesNotMatch(result.stdout, /AWS_SECRET_ACCESS_KEY|touch/);
  const [call] = await app.readCalls();
  assert.deepEqual(call.args, ["compose", "--env-file", path.join(app.root, ".env"), "-p", "wardrobe-container-test", "-f", path.join(app.root, "compose.test.yaml"), "up", "--build", "--wait", "--wait-timeout", "120"]);
  assert.equal(call.port, "3002");
  assert.match(call.uid, /^\d+$/); assert.match(call.gid, /^\d+$/);
  await writeFile(path.join(app.testData, "library.json"), "test edits");
  await app.run("up");
  assert.equal(await readFile(path.join(app.testData, "library.json"), "utf8"), "test edits");
  assert.equal(await readFile(path.join(app.root, "data/library.json"), "utf8"), "[]\n");
});

test("container status, logs, health and shutdown do not initialize or replace test data", async (t) => {
  const app = await runner(t);
  await app.run("ps"); await app.run("logs", "--tail", "100"); await app.run("health"); await app.run("down");
  await assert.rejects(access(app.testData), { code: "ENOENT" });
  const calls = await app.readCalls();
  assert.deepEqual(calls[0].args.slice(7), ["ps"]);
  assert.deepEqual(calls[1].args.slice(7), ["logs", "--follow", "--tail", "100", "wardrobe"]);
  assert.deepEqual(calls[2].args.slice(7, 12), ["exec", "-T", "wardrobe", "node", "-e"]);
  assert.deepEqual(calls[3].args.slice(7), ["down"]);
});

test("container initialization supports an empty wardrobe and rejects links to the working wardrobe", async (t) => {
  const app = await runner(t);
  await app.run("--empty", "init");
  assert.deepEqual(await readdir(app.testData), []);
  await app.run("init"); // Existing empty test data must not be overwritten.
  assert.deepEqual(await readdir(app.testData), []);
  const other = await runner(t);
  await mkdir(path.dirname(other.testData), { recursive: true });
  await symlink(path.join(other.root, "data"), other.testData);
  await assert.rejects(other.run("up"), (error) => /must not contain symbolic links/.test(error.stderr));
  assert.equal(await readFile(path.join(other.root, "data/library.json"), "utf8"), "[]\n");
});

test("container runner rejects invalid arguments before creating data or invoking Docker", async (t) => {
  const app = await runner(t);
  for (const args of [["--port", "0", "up"], ["--port", "65536", "up"], ["--port", "bad", "up"], ["unknown"], ["--empty", "down"], ["--env-file", path.join(app.root, "missing.env"), "up"]]) {
    await assert.rejects(app.run(...args));
  }
  await assert.rejects(access(app.testData), { code: "ENOENT" });
  await assert.rejects(app.readCalls(), { code: "ENOENT" });
});
