import { z } from "zod";
import { parseBytes, parseDuration } from "./duration.ts";

const duration = z.string().transform((value, ctx) => {
  try {
    return parseDuration(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error) });
    return z.NEVER;
  }
});

const bytes = z.string().transform((value, ctx) => {
  try {
    return parseBytes(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: String(error) });
    return z.NEVER;
  }
});

const scope = z.enum(["llm:invoke", "llm:models", "mcp:list", "mcp:call", "admin"]);
const cacheMode = z.enum(["none", "exact", "semantic", "shadow"]);

const providerSchema = z.object({
  type: z.literal("ollama"),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  timeout: duration.default(120_000),
  connectTimeout: duration.default(10_000),
  retries: z
    .object({
      attempts: z.int().min(0).default(2),
      baseDelay: duration.default(250),
      maxDelay: duration.default(2_000),
    })
    .default({ attempts: 2, baseDelay: 250, maxDelay: 2_000 }),
  circuitBreaker: z
    .object({
      failureThreshold: z.int().positive().default(5),
      openDuration: duration.default(30_000),
    })
    .default({ failureThreshold: 5, openDuration: 30_000 }),
});

const pricingSchema = z.object({
  version: z.string().min(1),
  currency: z.string().length(3),
  inputPerMillionMicros: z.int().nonnegative().optional(),
  outputPerMillionMicros: z.int().nonnegative().optional(),
  reasoningPerMillionMicros: z.int().nonnegative().optional(),
  cachedInputPerMillionMicros: z.int().nonnegative().optional(),
});

const modelSchema = z.object({
  provider: z.string().min(1),
  upstreamModel: z.string().min(1),
  capability: z.enum(["chat", "embedding"]).default("chat"),
  contextWindow: z.int().positive().optional(),
  maxOutput: z.int().positive().optional(),
  tokenizer: z.literal("approximate").default("approximate"),
  dimensions: z.int().positive().optional(),
  pricing: pricingSchema.optional(),
});

const toolPolicySchema = z.object({
  effect: z.enum(["read", "write", "unknown"]).default("unknown"),
  cache: z
    .object({ mode: z.enum(["none", "exact"]).default("none"), ttl: duration.optional() })
    .default({ mode: "none" }),
});

const mcpServerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  transport: z.enum(["streamable-http", "sse", "stdio"]),
  url: z.url().optional(),
  command: z.array(z.string()).min(1).optional(),
  required: z.boolean().default(false),
  auth: z.object({ bearerToken: z.string().min(1) }).optional(),
  tools: z.object({
    default: z.literal("deny").default("deny"),
    allow: z.array(z.string()).default([]),
    policies: z.record(z.string(), toolPolicySchema).default({}),
  }),
});

const limitValues = z.object({
  requests: z.int().positive().optional(),
  inputTokens: z.int().positive().optional(),
  outputTokens: z.int().positive().optional(),
  totalTokens: z.int().positive().optional(),
  costEquivalentMicros: z.int().positive().optional(),
});

const usageWindowSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["rolling", "calendar"]),
  duration: z.string().regex(/^\d+(ms|s|m|h|d|w|M)$/),
  timezone: z.string().default("UTC"),
  basis: z.enum(["provider", "served", "requests"]).default("provider"),
  operations: z.array(z.enum(["chat", "embedding", "mcp"])).default(["chat", "embedding", "mcp"]),
  scope: z.object({
    client: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
  }),
  softLimit: limitValues.optional(),
  hardLimit: limitValues.optional(),
  failClosed: z.boolean().default(true),
});

export const configSchema = z
  .object({
    version: z.literal(1),
    environment: z.string().default("local"),
    server: z.object({
      host: z.string().default("127.0.0.1"),
      port: z.int().min(1).max(65535).default(8080),
      requestBodyLimit: bytes.default(10 * 1024 * 1024),
      gracefulShutdown: duration.default(30_000),
      allowedOrigins: z.array(z.string()).default([]),
      admin: z
        .object({
          host: z.string().default("127.0.0.1"),
          port: z.int().min(1).max(65535).default(8081),
        })
        .default({ host: "127.0.0.1", port: 8081 }),
    }),
    auth: z.object({
      clients: z
        .array(
          z.object({
            id: z.string().min(1),
            key: z.string().min(1),
            policy: z.string().min(1),
            scopes: z.array(scope).min(1),
          }),
        )
        .min(1),
    }),
    providers: z.record(z.string(), providerSchema),
    models: z.record(z.string(), modelSchema),
    storage: z.object({
      valkey: z.object({
        url: z.string().min(1),
        keyPrefix: z.string().default("barback"),
        connectTimeout: duration.default(5_000),
        vectorSearch: z.boolean().default(false),
      }),
    }),
    cache: z.object({
      defaultMode: z.enum(["none", "exact"]).default("none"),
      maxResponseBytes: z.int().positive().default(2_097_152),
      exact: z.object({
        enabled: z.boolean().default(true),
        defaultTtl: duration.default(900_000),
      }),
      semantic: z.object({
        enabled: z.boolean().default(false),
        mode: z.enum(["shadow", "serving"]).default("shadow"),
        embeddingModel: z.string().min(1),
        threshold: z.number().min(0).max(1).default(0.97),
        maxMessages: z.int().positive().default(3),
        defaultTtl: duration.default(900_000),
        sampleValidationRate: z.number().min(0).max(1).default(0.1),
        servingApproved: z.boolean().default(false),
        servingCriteria: z.object({
          minimumCandidates: z.int().positive().default(500),
          minimumPrecision: z.number().min(0).max(1).default(0.99),
          maximumFalseHitRate: z.number().min(0).max(1).default(0.01),
        }),
      }),
    }),
    contextWindow: z.object({
      warningThreshold: z.number().min(0).max(1).default(0.7),
      compactThreshold: z.number().min(0).max(1).default(0.85),
      rejectThreshold: z.number().min(0).max(1).default(0.95),
    }),
    policies: z.record(
      z.string(),
      z.object({
        cache: cacheMode.default("none"),
        maxOutput: z.int().positive().optional(),
        models: z.array(z.string()).default([]),
        mcpToolsets: z.array(z.string()).default([]),
      }),
    ),
    usageWindows: z.array(usageWindowSchema).default([]),
    mcp: z.object({
      endpoint: z.literal("/mcp").default("/mcp"),
      protocol: z.object({
        primary: z.literal("2026-07-28").default("2026-07-28"),
        compatibility: z
          .array(z.enum(["2025-11-25", "2025-03-26"]))
          .default(["2025-11-25", "2025-03-26"]),
      }),
      servers: z.array(mcpServerSchema).default([]),
      toolsets: z.record(z.string(), z.array(z.string())).default({}),
      argumentLimit: bytes.default(1024 * 1024),
    }),
    telemetry: z.object({
      serviceName: z.string().default("barback"),
      prometheus: z.object({
        enabled: z.boolean().default(true),
        path: z.literal("/metrics").default("/metrics"),
      }),
      otel: z.object({ enabled: z.boolean().default(false), endpoint: z.url().optional() }),
      logging: z.object({
        level: z.enum(["debug", "info", "warn", "error"]).default("info"),
        captureContent: z.literal(false).default(false),
        captureHeaders: z.literal(false).default(false),
      }),
    }),
  })
  .superRefine((config, ctx) => {
    const clientIds = new Set<string>();
    for (const [index, client] of config.auth.clients.entries()) {
      if (clientIds.has(client.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["auth", "clients", index, "id"],
          message: "Duplicate client ID",
        });
      }
      clientIds.add(client.id);
    }
    for (const [alias, model] of Object.entries(config.models)) {
      if (!config.providers[model.provider]) {
        ctx.addIssue({
          code: "custom",
          path: ["models", alias, "provider"],
          message: "Unknown provider",
        });
      }
      if (model.capability === "embedding" && !model.dimensions) {
        ctx.addIssue({
          code: "custom",
          path: ["models", alias, "dimensions"],
          message: "Embedding dimensions are required",
        });
      }
      if (model.capability === "chat" && (!model.contextWindow || !model.maxOutput)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", alias],
          message: "Chat contextWindow and maxOutput are required",
        });
      }
    }
    for (const [id, provider] of Object.entries(config.providers)) {
      if (provider.connectTimeout > provider.timeout) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", id, "connectTimeout"],
          message: "Connect timeout exceeds total timeout",
        });
      }
    }
    for (const client of config.auth.clients) {
      if (!config.policies[client.policy]) {
        ctx.addIssue({
          code: "custom",
          path: ["auth", "clients"],
          message: `Unknown policy ${client.policy}`,
        });
      }
    }
    for (const [name, policy] of Object.entries(config.policies)) {
      for (const model of policy.models) {
        if (config.models[model]?.capability !== "chat") {
          ctx.addIssue({
            code: "custom",
            path: ["policies", name, "models"],
            message: `Unknown chat model ${model}`,
          });
        }
      }
      for (const toolset of policy.mcpToolsets) {
        if (!config.mcp.toolsets[toolset]) {
          ctx.addIssue({
            code: "custom",
            path: ["policies", name, "mcpToolsets"],
            message: `Unknown toolset ${toolset}`,
          });
        }
      }
    }
    if (config.cache.semantic.enabled) {
      const embedding = config.models[config.cache.semantic.embeddingModel];
      if (embedding?.capability !== "embedding") {
        ctx.addIssue({
          code: "custom",
          path: ["cache", "semantic", "embeddingModel"],
          message: "Semantic cache requires an embedding model",
        });
      }
      if (!config.storage.valkey.vectorSearch) {
        ctx.addIssue({
          code: "custom",
          path: ["storage", "valkey", "vectorSearch"],
          message: "Semantic cache requires vector search",
        });
      }
      if (config.cache.semantic.mode === "serving" && !config.cache.semantic.servingApproved) {
        ctx.addIssue({
          code: "custom",
          path: ["cache", "semantic", "servingApproved"],
          message: "Semantic serving requires explicit approval",
        });
      }
    }
    for (const [name, toolset] of Object.entries(config.mcp.toolsets)) {
      for (const reference of toolset) {
        const [serverId, tool] = reference.split(":");
        const server = config.mcp.servers.find((item) => item.id === serverId);
        if (!server || !tool || !server.tools.allow.includes(tool)) {
          ctx.addIssue({
            code: "custom",
            path: ["mcp", "toolsets", name],
            message: `Unknown tool ${reference}`,
          });
        }
      }
    }
    for (const server of config.mcp.servers) {
      if (server.transport === "stdio" && !server.command) {
        ctx.addIssue({
          code: "custom",
          path: ["mcp", "servers", server.id],
          message: "stdio requires command",
        });
      }
      if (server.transport !== "stdio" && !server.url) {
        ctx.addIssue({
          code: "custom",
          path: ["mcp", "servers", server.id],
          message: "HTTP transport requires URL",
        });
      }
      for (const [tool, policy] of Object.entries(server.tools.policies)) {
        if (policy.effect !== "read" && policy.cache.mode !== "none") {
          ctx.addIssue({
            code: "custom",
            path: ["mcp", "servers", server.id, "tools", "policies", tool],
            message: "Only read tools may be cached",
          });
        }
      }
    }
    for (const [index, window] of config.usageWindows.entries()) {
      if (window.scope.client && !clientIds.has(window.scope.client)) {
        ctx.addIssue({
          code: "custom",
          path: ["usageWindows", index, "scope", "client"],
          message: "Unknown client",
        });
      }
      if (window.scope.provider && !config.providers[window.scope.provider]) {
        ctx.addIssue({
          code: "custom",
          path: ["usageWindows", index, "scope", "provider"],
          message: "Unknown provider",
        });
      }
      if (window.scope.model && !config.models[window.scope.model]) {
        ctx.addIssue({
          code: "custom",
          path: ["usageWindows", index, "scope", "model"],
          message: "Unknown model",
        });
      }
      for (const [field, hard] of Object.entries(window.hardLimit ?? {})) {
        const soft = window.softLimit?.[field as keyof NonNullable<typeof window.softLimit>];
        if (soft !== undefined && hard !== undefined && hard < soft) {
          ctx.addIssue({
            code: "custom",
            path: ["usageWindows", index, "hardLimit", field],
            message: "Hard limit must be greater than or equal to soft limit",
          });
        }
      }
      if (
        (window.hardLimit?.costEquivalentMicros || window.softLimit?.costEquivalentMicros) &&
        window.scope.model &&
        !config.models[window.scope.model]?.pricing
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["usageWindows", index],
          message: "Cost limits require model pricing",
        });
      }
    }
  });

export type BarbackConfig = z.infer<typeof configSchema>;
export type ClientConfig = BarbackConfig["auth"]["clients"][number];
export type PolicyConfig = BarbackConfig["policies"][string];
export type ModelConfig = BarbackConfig["models"][string];

export function isEnvReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("env:") && value.length > 4;
}
