import type { TokenUsage } from "../providers/provider.ts";

export interface UsageEvent {
  schemaVersion: 1;
  timestamp: string;
  requestId: string;
  traceId?: string;
  clientId: string;
  provider: string;
  model: string;
  operation: "chat" | "embedding" | "mcp";
  providerUsage?: TokenUsage;
  servedUsage: TokenUsage;
  costEquivalentMicros?: number;
  pricingVersion?: string;
  cache: {
    status: "bypass" | "miss" | "hit" | "shadow-hit";
    type?: "exact" | "semantic";
    savedInputTokens?: number;
    savedOutputTokens?: number;
  };
  context: {
    window?: number;
    predictedUtilization?: number;
    actualUtilization?: number;
  };
  latencyMs: number;
  firstTokenLatencyMs?: number;
  success: boolean;
  errorCode?: string;
}
