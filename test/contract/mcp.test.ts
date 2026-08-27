import { expect, test } from "bun:test";
import { createApp } from "../../src/api/app.ts";
import { ConfigStore } from "../../src/config/loader.ts";
import { Runtime } from "../../src/core/runtime.ts";
import { MemoryStore } from "../../src/storage/valkey.ts";
import { testConfig } from "../fixtures/config.ts";

test("negotiates the MCP version used by OpenCode", async () => {
  const runtime = await Runtime.create(new ConfigStore(testConfig()), new MemoryStore());
  const response = await createApp(runtime).request("/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { protocolVersion: string } };
  expect(body.result.protocolVersion).toBe("2025-11-25");
});

test("rejects mismatched 2026 request metadata", async () => {
  const runtime = await Runtime.create(new ConfigStore(testConfig()), new MemoryStore());
  const response = await createApp(runtime).request("/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(response.status).toBe(400);
});
