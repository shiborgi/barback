import { describe, expect, test } from "bun:test";
import { configSchema } from "../../src/config/schema.ts";
import { testConfig, testConfigInput } from "../fixtures/config.ts";

describe("configuration", () => {
  test("parses a valid independent client policy", () => {
    const config = testConfig();
    expect(config.auth.clients[0]?.id).toBe("test");
    expect(config.server.requestBodyLimit).toBe(1024 * 1024);
    expect(config.providers.ollama?.timeout).toBe(2000);
  });

  test("rejects unknown policy models", () => {
    const config = structuredClone(testConfigInput()) as unknown as Record<string, unknown>;
    const policies = config.policies as Record<string, { models: string[] }>;
    if (policies.standard) policies.standard.models = ["missing"];
    expect(() => configSchema.parse(config)).toThrow();
  });

  test("rejects semantic serving without approval", () => {
    const config = testConfigInput();
    const raw = {
      ...config,
      cache: {
        ...config.cache,
        semantic: { ...config.cache.semantic, enabled: true, mode: "serving" },
      },
      storage: { valkey: { ...config.storage.valkey, vectorSearch: true } },
      models: {
        ...config.models,
        embed: {
          provider: "ollama",
          upstreamModel: "embed",
          capability: "embedding",
          dimensions: 2,
          tokenizer: "approximate",
        },
      },
    };
    raw.cache.semantic.embeddingModel = "embed";
    expect(() => configSchema.parse(raw)).toThrow(/explicit approval/);
  });
});
