import { ExactCache } from "../cache/exact-cache.ts";
import { SemanticCache } from "../cache/semantic-cache.ts";
import { parseDuration } from "../config/duration.ts";
import type { ConfigStore } from "../config/loader.ts";
import { loadConfig } from "../config/loader.ts";
import { McpGateway } from "../mcp/gateway.ts";
import { McpRegistry } from "../mcp/registry.ts";
import { McpToolCache } from "../mcp/tool-cache.ts";
import { OllamaCloudAdapter } from "../providers/ollama-cloud/adapter.ts";
import type { LlmProvider } from "../providers/provider.ts";
import { type OperationalStore, ValkeyStore } from "../storage/valkey.ts";
import { Logger } from "../telemetry/logger.ts";
import { Metrics } from "../telemetry/metrics.ts";
import { UsageMeter } from "../usage/meter.ts";
import { WindowTracker } from "../usage/window-tracker.ts";

export class Runtime {
  store: OperationalStore;
  exactCache: ExactCache;
  semanticCache?: SemanticCache;
  providers: Map<string, LlmProvider>;
  mcpRegistry: McpRegistry;
  mcpGateway: McpGateway;
  windowTracker: WindowTracker;
  usageMeter: UsageMeter;
  metrics: Metrics;
  logger: Logger;

  private constructor(
    readonly configStore: ConfigStore,
    resources: Omit<Runtime, "configStore" | "reload" | "close">,
  ) {
    this.store = resources.store;
    this.exactCache = resources.exactCache;
    this.semanticCache = resources.semanticCache;
    this.providers = resources.providers;
    this.mcpRegistry = resources.mcpRegistry;
    this.mcpGateway = resources.mcpGateway;
    this.windowTracker = resources.windowTracker;
    this.usageMeter = resources.usageMeter;
    this.metrics = resources.metrics;
    this.logger = resources.logger;
  }

  static async create(
    configStore: ConfigStore,
    suppliedStore?: OperationalStore,
  ): Promise<Runtime> {
    const config = configStore.get();
    const logger = new Logger(config.telemetry.logging.level);
    const metrics = new Metrics();
    const store = suppliedStore ?? new ValkeyStore(config.storage.valkey);
    if (store instanceof ValkeyStore) {
      await store.connect().catch((error) => {
        logger.warn("valkey.connection_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const exactCache = new ExactCache(store, config.storage.valkey.keyPrefix);
    let semanticCache: SemanticCache | undefined;
    if (config.cache.semantic.enabled) {
      const embedding = config.models[config.cache.semantic.embeddingModel];
      semanticCache = new SemanticCache(
        store,
        config.storage.valkey.keyPrefix,
        embedding?.dimensions ?? 0,
        config.cache.semantic,
      );
      await semanticCache.initialize().catch((error) => {
        logger.warn("semantic_cache.initialization_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (config.cache.semantic.mode === "serving") throw error;
      });
    }
    const providers = new Map<string, LlmProvider>(
      Object.entries(config.providers).map(([id, provider]) => [
        id,
        new OllamaCloudAdapter(id, provider),
      ]),
    );
    const mcpRegistry = new McpRegistry(config.mcp, logger);
    await mcpRegistry.connect();
    const mcpGateway = new McpGateway(
      mcpRegistry,
      new McpToolCache(store, config.storage.valkey.keyPrefix),
      metrics,
      config.mcp.argumentLimit,
      config.mcp.protocol,
    );
    const windowTracker = new WindowTracker(
      store,
      config.storage.valkey.keyPrefix,
      config.usageWindows,
    );
    const retention = Math.max(
      86_400_000,
      ...config.usageWindows.map((window) =>
        window.duration.endsWith("M") ? 31 * 86_400_000 : parseDuration(window.duration),
      ),
    );
    const usageMeter = new UsageMeter(store, config.storage.valkey.keyPrefix, retention);
    return new Runtime(configStore, {
      store,
      exactCache,
      ...(semanticCache ? { semanticCache } : {}),
      providers,
      mcpRegistry,
      mcpGateway,
      windowTracker,
      usageMeter,
      metrics,
      logger,
    });
  }

  async reload(): Promise<void> {
    const next = await loadConfig(this.configStore.path);
    const { ConfigStore } = await import("../config/loader.ts");
    const replacement = await Runtime.create(new ConfigStore(next, this.configStore.path));
    const oldStore = this.store;
    const oldMcp = this.mcpRegistry;
    this.store = replacement.store;
    this.exactCache = replacement.exactCache;
    this.semanticCache = replacement.semanticCache;
    this.providers = replacement.providers;
    this.mcpRegistry = replacement.mcpRegistry;
    this.mcpGateway = replacement.mcpGateway;
    this.windowTracker = replacement.windowTracker;
    this.usageMeter = replacement.usageMeter;
    this.metrics = replacement.metrics;
    this.logger = replacement.logger;
    this.configStore.replace(next);
    await oldMcp.close().catch(() => undefined);
    await oldStore.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.mcpRegistry.close().catch(() => undefined);
    await this.store.close().catch(() => undefined);
  }
}
