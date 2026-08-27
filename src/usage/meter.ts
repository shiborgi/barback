import type { TokenUsage } from "../providers/provider.ts";
import type { OperationalStore } from "../storage/valkey.ts";
import type { UsageEvent } from "./events.ts";

export class UsageMeter {
  constructor(
    private readonly store: OperationalStore,
    private readonly prefix: string,
    private readonly retentionMs: number,
  ) {}

  async record(event: UsageEvent): Promise<void> {
    try {
      await this.store.set(
        `${this.prefix}:usage:event:${event.requestId}`,
        JSON.stringify(event),
        this.retentionMs,
      );
      await this.store.sadd(`${this.prefix}:usage:client:${event.clientId}`, event.requestId);
      await this.store.expire(
        `${this.prefix}:usage:client:${event.clientId}`,
        Math.ceil(this.retentionMs / 1000),
      );
    } catch {
      // Enforcement reservations remain independent from reporting events.
    }
  }
}

export function actualUtilization(usage: TokenUsage, contextWindow: number | undefined) {
  if (!contextWindow || usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return undefined;
  }
  return (usage.inputTokens + usage.outputTokens) / contextWindow;
}
