import { describe, expect, test } from "bun:test";
import { loadConfig } from "../../src/config/loader.ts";
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

  test("loads the example with the Google calendar toolset", async () => {
    const config = await loadConfig("config/barback.example.yaml", {
      BARBACK_SERVER_HOST: "127.0.0.1",
      BARBACK_ADMIN_HOST: "127.0.0.1",
      BARBACK_CLIENT_KEY: "client-key",
      BARBACK_ADMIN_KEY: "admin-key",
      OLLAMA_API_KEY: "ollama-key",
      OLLAMA_CODE_MODEL: "chat-model",
      OLLAMA_EMBEDDING_MODEL: "embedding-model",
      VALKEY_URL: "redis://127.0.0.1:6379",
      GOOGLE_MCP_URL: "http://google-mcp.test:8090/mcp",
      GOOGLE_MCP_TOKEN: "google-token",
    });

    expect(config.policies.standard?.mcpToolsets).toEqual(["calendar"]);
    expect(config.mcp.servers[0]?.id).toBe("google");
    expect(config.mcp.toolsets.calendar).toContain("google:list_calendars");
  });
});
