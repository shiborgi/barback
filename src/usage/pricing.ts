import type { ModelConfig } from "../config/schema.ts";
import type { TokenUsage } from "../providers/provider.ts";

export function costEquivalentMicros(
  usage: TokenUsage,
  pricing: ModelConfig["pricing"],
): number | undefined {
  if (!pricing) return undefined;
  const components: Array<[number | undefined, number | undefined]> = [
    [usage.inputTokens, pricing.inputPerMillionMicros],
    [usage.outputTokens, pricing.outputPerMillionMicros],
    [usage.reasoningTokens, pricing.reasoningPerMillionMicros],
    [usage.cachedInputTokens, pricing.cachedInputPerMillionMicros],
  ];
  let total = 0;
  let known = false;
  for (const [tokens, rate] of components) {
    if (tokens === undefined) continue;
    if (rate === undefined) return undefined;
    total += (tokens * rate) / 1_000_000;
    known = true;
  }
  return known ? Math.round(total) : undefined;
}
