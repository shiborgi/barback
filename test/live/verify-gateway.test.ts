import { describe, expect, test } from "bun:test";

const LIVE = process.env.BARBACK_LIVE_TESTS;
const BASE_URL = process.env.BARBACK_BASE_URL ?? "http://127.0.0.1:8080";
const CLIENT_KEY = process.env.BARBACK_CLIENT_KEY;

const describeLive = describe.skipIf(!LIVE);

describeLive("verify the running gateway stack", () => {
  test("advertises google.list_calendars over MCP", async () => {
    const headers = {
      authorization: `Bearer ${CLIENT_KEY}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    const init = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "verify-gateway", version: "1" },
        },
      }),
    });
    expect(init.status, `initialize HTTP ${init.status}`).toBe(200);

    const list = await fetch(`${BASE_URL}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status, `tools/list HTTP ${list.status}`).toBe(200);

    const body = (await list.json()) as {
      result?: { tools?: Array<{ name?: string }> };
    };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names, `tools found: ${names.length}`).toContain("google.list_calendars");
  });

  test("returns a non-streaming chat completion", async () => {
    const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${CLIENT_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "code-default",
        messages: [{ role: "user", content: "Reply with the single word ok." }],
        stream: false,
      }),
    });
    expect(response.status, `chat HTTP ${response.status}`).toBe(200);

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    expect(content.length, `assistant content length: ${content.length}`).toBeGreaterThan(0);
  });
});
