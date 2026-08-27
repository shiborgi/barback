import { expect, test } from "bun:test";
import type { RequestContext } from "../../src/core/request-context.ts";
import { OllamaCloudAdapter } from "../../src/providers/ollama-cloud/adapter.ts";
import { testConfig } from "../fixtures/config.ts";

const ctx = {
  requestId: "request",
  client: testConfig().auth.clients[0],
  policy: testConfig().policies.standard,
  startedAt: 0,
  signal: new AbortController().signal,
} as RequestContext;

test("maps Ollama native usage into OpenAI-normalized usage", async () => {
  const fetcher: typeof fetch = Object.assign(
    async () =>
      Response.json({
        message: { role: "assistant", content: "hello" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 5,
        eval_count: 2,
      }),
    { preconnect: fetch.preconnect },
  );
  const provider = testConfig().providers.ollama;
  if (!provider) throw new Error("Missing test provider");
  const adapter = new OllamaCloudAdapter("ollama", provider, fetcher);
  const response = await adapter.chat(
    { model: "chat", messages: [{ role: "user", content: "hello" }], stream: false },
    "upstream",
    ctx,
  );
  expect("usage" in response && response.usage.totalTokens).toBe(7);
});
