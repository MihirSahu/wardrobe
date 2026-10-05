import { createInterface } from "node:readline";
import assert from "node:assert/strict";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let connected = true;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line); if (!message.method) continue;
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize": process.stderr.write('Diagnostic probe refresh_token="FIXTURE_SECRET" data:image/png;base64,aW1hZ2UgYnl0ZXM=\n'); reply({}); break;
    case "account/read": reply({ account: connected ? { type: "chatgpt", planType: "plus" } : null }); break;
    case "account/rateLimits/read": reply({ rateLimits: { primary: { usedPercent: 20, resetsAt: 2_000_000_000 } } }); break;
    case "model/list": reply({ data: [{ model: "test", displayName: "Test", isDefault: true }] }); break;
    case "account/login/start": reply({ type: "chatgptDeviceCode", loginId: "test-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "TEST-CODE" }); break;
    case "account/login/cancel": reply({}); break;
    case "account/logout": connected = false; reply({}); break;
    case "thread/start": {
      assert.equal(message.params.permissions, "wardrobe");
      assert.equal(message.params.sandbox, undefined);
      assert.equal(message.params.approvalPolicy, "never");
      assert.deepEqual(message.params.runtimeWorkspaceRoots, [message.params.cwd]);
      assert.deepEqual(message.params.config.permissions.wardrobe, {
        filesystem: { ":minimal": "read", ":workspace_roots": { ".": "read" } }, network: { enabled: false },
      });
      assert.equal(message.params.config.features.code_mode_host, true, "Code Mode models need the host for native image tool calls");
      for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "hooks", "computer_use", "browser_use"]) assert.equal(message.params.config.features[feature], false);
      reply({ thread: { id: "thread-test" } }); break;
    }
    case "turn/interrupt": reply({}); break;
    case "turn/start": {
      assert.equal(message.params.permissions, "wardrobe");
      assert.equal(message.params.sandboxPolicy, undefined, "Restricted reads must use a named profile, not the removed readOnly.access field");
      if (message.params.input[0].text === "Wait for cancellation") {
        reply({ turn: { id: "turn-test" } });
        send({ method: "item/started", params: { threadId: "thread-test", item: { type: "imageGeneration" } } });
        setTimeout(() => {
          send({ method: "item/completed", params: { threadId: "thread-test", item: { type: "imageGeneration", status: "completed", result: "aW1hZ2UgYnl0ZXM=" } } });
          send({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "turn-test", status: "interrupted" } } });
        }, 150);
        break;
      }
      // Deliberately send completion events before the RPC response.
      send({ method: "item/completed", params: { threadId: "thread-test", item: message.params.outputSchema ? { type: "agentMessage", text: '{"answer":"ok"}' } : { type: "imageGeneration", status: "completed", result: "aW1hZ2UgYnl0ZXM=" } } });
      send({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "turn-test", status: "completed" } } });
      reply({ turn: { id: "turn-test" } }); break;
    }
    case "thread/archive": reply({}); break;
    case "fixture/error": send({ id: message.id, error: { code: -32600, message: 'Diagnostic failure api_key="FIXTURE_KEY"' } }); break;
  }
}
