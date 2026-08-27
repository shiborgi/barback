import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export class Metrics {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: "barback_requests_total",
    help: "Gateway requests",
    labelNames: ["operation", "status", "client"] as const,
    registers: [this.registry],
  });
  readonly duration = new Histogram({
    name: "barback_request_duration_seconds",
    help: "Gateway request duration",
    labelNames: ["operation"] as const,
    registers: [this.registry],
  });
  readonly providerRequests = new Counter({
    name: "barback_provider_requests_total",
    help: "Provider requests",
    labelNames: ["provider", "operation", "status"] as const,
    registers: [this.registry],
  });
  readonly tokens = new Counter({
    name: "barback_tokens_total",
    help: "Observed tokens",
    labelNames: ["model", "kind", "basis", "operation"] as const,
    registers: [this.registry],
  });
  readonly contextUtilization = new Histogram({
    name: "barback_context_utilization_ratio",
    help: "Predicted context utilization",
    labelNames: ["model"] as const,
    buckets: [0.25, 0.5, 0.7, 0.85, 0.95, 1],
    registers: [this.registry],
  });
  readonly cacheLookups = new Counter({
    name: "barback_cache_lookups_total",
    help: "Cache lookups",
    labelNames: ["type", "status"] as const,
    registers: [this.registry],
  });
  readonly semanticSimilarity = new Histogram({
    name: "barback_semantic_similarity",
    help: "Semantic candidate similarity",
    buckets: [0.9, 0.95, 0.97, 0.98, 0.99, 1],
    registers: [this.registry],
  });
  readonly active = new Gauge({
    name: "barback_active_requests",
    help: "Active requests",
    labelNames: ["operation"] as const,
    registers: [this.registry],
  });
  readonly mcpCalls = new Counter({
    name: "barback_mcp_tool_calls_total",
    help: "MCP tool calls",
    labelNames: ["server", "tool", "status"] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "barback_process_" });
  }

  render() {
    return this.registry.metrics();
  }
  contentType() {
    return this.registry.contentType;
  }
}
