import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../../src/api/app.ts";
import { ConfigStore } from "../../src/config/loader.ts";
import { Runtime } from "../../src/core/runtime.ts";
import { MemoryStore } from "../../src/storage/valkey.ts";
import { testConfig } from "../fixtures/config.ts";
import { FakeProvider } from "../fixtures/provider.ts";

describe("OpenAI-compatible API", () => {
  let runtime: Runtime;
  let provider: FakeProvider;

  beforeEach(async () => {
    runtime = await Runtime.create(new ConfigStore(testConfig()), new MemoryStore());
    provider = new FakeProvider();
    runtime.providers.set("ollama", provider);
  });

  test("rejects missing credentials", async () => {
    const response = await createApp(runtime).request("/v1/models");
    expect(response.status).toBe(401);
  });

  test("lists only policy models", async () => {
    const response = await createApp(runtime).request("/v1/models", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [{ id: "chat", object: "model", created: 0, owned_by: "barback" }],
    });
  });

  test("returns a non-streaming completion and clamps output", async () => {
    const response = await createApp(runtime).request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 9999,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("hello");
    expect(provider.lastRequest?.max_completion_tokens).toBe(512);
  });

  test("streams SSE and terminates with DONE", async () => {
    const response = await createApp(runtime).request("/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    const text = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"content":"hello"');
    expect(text).toEndWith("data: [DONE]\n\n");
  });
});
