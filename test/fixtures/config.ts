import { configSchema, type GatepatrolConfig } from "../../src/config/schema.ts";

export function testConfigInput() {
  return {
    version: 1,
    environment: "test",
    server: {
      host: "127.0.0.1",
      port: 8080,
      requestBodyLimit: "1mb",
      gracefulShutdown: "1s",
      allowedOrigins: [],
      admin: { host: "127.0.0.1", port: 8081 },
    },
    auth: {
      clients: [
        {
          id: "test",
          key: "test-key",
          policy: "standard",
          scopes: ["llm:invoke", "llm:models", "mcp:list", "mcp:call", "admin"],
        },
      ],
    },
    providers: {
      ollama: {
        type: "ollama",
        baseUrl: "https://ollama.test",
        apiKey: "secret",
        timeout: "2s",
        connectTimeout: "1s",
      },
    },
    models: {
      chat: {
        provider: "ollama",
        upstreamModel: "upstream-chat",
        capability: "chat",
        contextWindow: 8192,
        maxOutput: 1024,
      },
    },
    storage: {
      valkey: {
        url: "redis://127.0.0.1:6379",
        keyPrefix: "test",
        connectTimeout: "1s",
        vectorSearch: false,
      },
    },
    cache: {
      defaultMode: "none",
      maxResponseBytes: 100_000,
      exact: { enabled: true, defaultTtl: "1m" },
      semantic: {
        enabled: false,
        mode: "shadow",
        embeddingModel: "unused",
        threshold: 0.97,
        maxMessages: 3,
        defaultTtl: "1m",
        sampleValidationRate: 0.1,
        servingApproved: false,
        servingCriteria: {
          minimumCandidates: 500,
          minimumPrecision: 0.99,
          maximumFalseHitRate: 0.01,
        },
      },
    },
    contextWindow: {
      warningThreshold: 0.7,
      compactThreshold: 0.85,
      rejectThreshold: 0.95,
    },
    policies: {
      standard: { cache: "exact", maxOutput: 512, models: ["chat"], mcpToolsets: [] },
    },
    usageWindows: [],
    mcp: {
      endpoint: "/mcp",
      protocol: { primary: "2026-07-28", compatibility: ["2025-11-25", "2025-03-26"] },
      servers: [],
      toolsets: {},
      argumentLimit: "1mb",
    },
    telemetry: {
      serviceName: "gatepatrol-test",
      prometheus: { enabled: true, path: "/metrics" },
      otel: { enabled: false },
      logging: { level: "error", captureContent: false, captureHeaders: false },
    },
  };
}

export function testConfig(): GatepatrolConfig {
  return configSchema.parse(testConfigInput());
}
