import { expect, test } from "bun:test";
import { exactCacheId } from "../../src/cache/cache-key.ts";
import { ExactCache } from "../../src/cache/exact-cache.ts";
import { MemoryStore } from "../../src/storage/valkey.ts";

const identity = {
  client: "client",
  namespace: "namespace",
  provider: "provider",
  model: "model",
  request: {
    model: "model",
    messages: [{ role: "user" as const, content: "hello\r\nworld" }],
    stream: false,
    temperature: 1,
  },
};

test("exact cache key is deterministic but isolates clients", () => {
  expect(exactCacheId(identity)).toBe(exactCacheId(structuredClone(identity)));
  expect(exactCacheId(identity)).not.toBe(exactCacheId({ ...identity, client: "other" }));
});

test("exact cache stores and invalidates by namespace", async () => {
  const cache = new ExactCache(new MemoryStore(), "test");
  await cache.put(
    "id",
    "namespace",
    {
      id: "response",
      model: "model",
      created: 1,
      content: "hello",
      finishReason: "stop",
      usage: { source: "provider" },
    },
    1000,
  );
  expect((await cache.get("id"))?.response.content).toBe("hello");
  await cache.invalidateNamespace("namespace");
  expect(await cache.get("id")).toBeUndefined();
});
