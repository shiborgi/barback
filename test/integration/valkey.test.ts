import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ExactCache } from "../../src/cache/exact-cache.ts";
import type { BarbackConfig } from "../../src/config/schema.ts";
import { ValkeyStore } from "../../src/storage/valkey.ts";
import { WindowTracker } from "../../src/usage/window-tracker.ts";
import { testConfig } from "../fixtures/config.ts";

const url = process.env.VALKEY_URL;

describe.skipIf(!url)("Valkey integration", () => {
  const prefix = `barback:test:${crypto.randomUUID()}`;
  const valkeyConfig = { ...testConfig().storage.valkey, url: url ?? "" };
  const store = new ValkeyStore(valkeyConfig);

  beforeAll(() => store.connect());
  afterAll(() => store.close());

  test("stores and invalidates exact entries", async () => {
    const cache = new ExactCache(store, prefix);
    await cache.put(
      "entry",
      "namespace",
      {
        id: "response",
        model: "chat",
        created: 1,
        content: "hello",
        finishReason: "stop",
        usage: { source: "provider" },
      },
      1000,
    );
    expect((await cache.get("entry"))?.response.content).toBe("hello");
    expect(await cache.invalidateNamespace("namespace")).toBe(1);
  });

  test("reserves usage atomically and idempotently", async () => {
    const windows: BarbackConfig["usageWindows"] = [
      {
        id: "requests",
        type: "rolling",
        duration: "1h",
        timezone: "UTC",
        basis: "provider",
        operations: ["chat"],
        scope: {},
        failClosed: true,
        hardLimit: { requests: 1 },
      },
    ];
    const tracker = new WindowTracker(store, prefix, windows);
    const usage = {
      requests: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costEquivalentMicros: 0,
    };
    await expect(
      tracker.reserve("one", "client", "provider", "model", "chat", usage),
    ).resolves.toBe("ok");
    await expect(
      tracker.reserve("one", "client", "provider", "model", "chat", usage),
    ).resolves.toBe("ok");
    await expect(
      tracker.reserve("two", "client", "provider", "model", "chat", usage),
    ).rejects.toMatchObject({ status: 429, code: "usage_window_exhausted" });
  });
});
