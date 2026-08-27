import { parseDuration } from "../config/duration.ts";
import type { GatepatrolConfig } from "../config/schema.ts";
import { GatewayError } from "../core/errors.ts";
import type { OperationalStore } from "../storage/valkey.ts";

export interface UsageValues {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costEquivalentMicros: number;
}

export interface UsageByBasis {
  provider: UsageValues;
  served: UsageValues;
}

export interface WindowStatus {
  id: string;
  basis: "provider" | "served" | "requests";
  used: UsageValues;
  status: "ok" | "warning" | "exhausted";
  estimatedResetAt: string;
  source: "observed";
}

const ZERO: UsageValues = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costEquivalentMicros: 0,
};

const RESERVE_SCRIPT = `
local zkey, ikey = KEYS[1], KEYS[2]
local now, start, requestId, valuesJson, hardJson, softJson, ttl = tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[3], ARGV[4], ARGV[5], ARGV[6], tonumber(ARGV[7])
redis.call('ZREMRANGEBYSCORE', zkey, '-inf', start - 1)
local existing = redis.call('HGET', ikey, requestId)
if existing then return cjson.encode({allowed=true, idempotent=true}) end
local totals = {requests=0,inputTokens=0,outputTokens=0,totalTokens=0,costEquivalentMicros=0}
for _, member in ipairs(redis.call('ZRANGEBYSCORE', zkey, start, '+inf')) do
  local event = cjson.decode(member)
  for field, _ in pairs(totals) do totals[field] = totals[field] + (event[field] or 0) end
end
local values, hard, soft = cjson.decode(valuesJson), cjson.decode(hardJson), cjson.decode(softJson)
for field, value in pairs(values) do totals[field] = (totals[field] or 0) + value end
for field, limit in pairs(hard) do
  if totals[field] > limit then return cjson.encode({allowed=false,field=field,used=totals[field],limit=limit}) end
end
values.requestId = requestId
local member = cjson.encode(values)
redis.call('ZADD', zkey, now, member)
redis.call('HSET', ikey, requestId, member)
redis.call('PEXPIRE', zkey, ttl)
redis.call('PEXPIRE', ikey, ttl)
local warning = false
for field, limit in pairs(soft) do if totals[field] >= limit then warning = true end end
return cjson.encode({allowed=true,warning=warning,used=totals})
`;

const RECONCILE_SCRIPT = `
local zkey, ikey = KEYS[1], KEYS[2]
local requestId, valuesJson, now, ttl = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local old = redis.call('HGET', ikey, requestId)
if not old then return 0 end
local current = cjson.decode(old)
if current.reconciled then return 0 end
redis.call('ZREM', zkey, old)
local values = cjson.decode(valuesJson)
values.requestId = requestId
values.reconciled = true
local member = cjson.encode(values)
redis.call('ZADD', zkey, now, member)
redis.call('HSET', ikey, requestId, member)
redis.call('PEXPIRE', zkey, ttl)
redis.call('PEXPIRE', ikey, ttl)
return 1
`;

const SUM_SCRIPT = `
local zkey = KEYS[1]
local start = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', zkey, '-inf', start - 1)
local totals = {requests=0,inputTokens=0,outputTokens=0,totalTokens=0,costEquivalentMicros=0}
for _, member in ipairs(redis.call('ZRANGEBYSCORE', zkey, start, '+inf')) do
  local event = cjson.decode(member)
  for field, _ in pairs(totals) do totals[field] = totals[field] + (event[field] or 0) end
end
return cjson.encode(totals)
`;

function scopeMatches(
  window: GatepatrolConfig["usageWindows"][number],
  client: string,
  provider: string,
  model: string,
) {
  return (
    (!window.scope.client || window.scope.client === client) &&
    (!window.scope.provider || window.scope.provider === provider) &&
    (!window.scope.model || window.scope.model === model)
  );
}

function durationMs(value: string): number {
  if (value.endsWith("M")) return 31 * 86_400_000;
  return parseDuration(value);
}

function bounds(window: GatepatrolConfig["usageWindows"][number], now: number) {
  if (window.type === "rolling") return { start: now - durationMs(window.duration), end: now };
  if (window.timezone !== "UTC") {
    throw new Error("Calendar windows currently require UTC");
  }
  const date = new Date(now);
  if (window.duration.endsWith("M")) {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return { start, end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) };
  }
  if (window.duration.endsWith("w")) {
    const day = (date.getUTCDay() + 6) % 7;
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
    return { start, end: start + 7 * 86_400_000 };
  }
  const duration = durationMs(window.duration);
  const start = Math.floor(now / duration) * duration;
  return { start, end: start + duration };
}

export class WindowTracker {
  constructor(
    private readonly store: OperationalStore,
    private readonly prefix: string,
    private readonly windows: GatepatrolConfig["usageWindows"],
  ) {}

  #scopeKey(
    window: GatepatrolConfig["usageWindows"][number],
    client: string,
    provider: string,
    model: string,
  ) {
    return [
      window.scope.client ? client : "*",
      window.scope.provider ? provider : "*",
      window.scope.model ? model : "*",
    ].join(":");
  }

  #keys(window: GatepatrolConfig["usageWindows"][number], scopeKey: string) {
    return [
      `${this.prefix}:usage:window:${window.id}:${scopeKey}`,
      `${this.prefix}:usage:index:${window.id}:${scopeKey}`,
    ];
  }

  async reserve(
    requestId: string,
    client: string,
    provider: string,
    model: string,
    operation: "chat" | "embedding" | "mcp",
    values: UsageValues,
    now = Date.now(),
  ): Promise<"ok" | "warning"> {
    let status: "ok" | "warning" = "ok";
    for (const window of this.windows) {
      if (!window.operations.includes(operation) || !scopeMatches(window, client, provider, model))
        continue;
      const { start } = bounds(window, now);
      const ttl = durationMs(window.duration) + 86_400_000;
      try {
        const result = JSON.parse(
          String(
            await this.store.eval(
              RESERVE_SCRIPT,
              this.#keys(window, this.#scopeKey(window, client, provider, model)),
              [
                now,
                start,
                requestId,
                JSON.stringify(values),
                JSON.stringify(window.hardLimit ?? {}),
                JSON.stringify(window.softLimit ?? {}),
                ttl,
              ],
            ),
          ),
        ) as { allowed: boolean; warning?: boolean; field?: string };
        if (!result.allowed) {
          throw new GatewayError(
            `Usage window ${window.id} exceeded for ${result.field}`,
            429,
            "budget_exceeded_error",
            "usage_window_exhausted",
          );
        }
        if (result.warning) status = "warning";
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        if (window.hardLimit && window.failClosed) {
          throw new GatewayError(
            "Usage window state unavailable",
            503,
            "budget_exceeded_error",
            "usage_state_unavailable",
          );
        }
      }
    }
    return status;
  }

  async reconcile(
    requestId: string,
    client: string,
    provider: string,
    model: string,
    operation: "chat" | "embedding" | "mcp",
    values: UsageByBasis,
    now = Date.now(),
  ): Promise<void> {
    for (const window of this.windows) {
      if (!window.operations.includes(operation) || !scopeMatches(window, client, provider, model))
        continue;
      try {
        const selected =
          window.basis === "provider"
            ? values.provider
            : window.basis === "served"
              ? values.served
              : { ...ZERO, requests: values.served.requests };
        await this.store.eval(
          RECONCILE_SCRIPT,
          this.#keys(window, this.#scopeKey(window, client, provider, model)),
          [requestId, JSON.stringify(selected), now, durationMs(window.duration) + 86_400_000],
        );
      } catch {
        // The usage event remains observable in logs if reconciliation storage fails.
      }
    }
  }

  async inspect(
    client: string,
    provider: string,
    model: string,
    now = Date.now(),
  ): Promise<WindowStatus[]> {
    const output: WindowStatus[] = [];
    for (const window of this.windows) {
      if (!scopeMatches(window, client, provider, model)) continue;
      const { start, end } = bounds(window, now);
      const raw = await this.store.eval(
        SUM_SCRIPT,
        [this.#keys(window, this.#scopeKey(window, client, provider, model))[0] ?? ""],
        [start],
      );
      const used = { ...ZERO, ...(JSON.parse(String(raw)) as Partial<UsageValues>) };
      const hard = window.hardLimit;
      const soft = window.softLimit;
      const exhausted =
        hard &&
        Object.entries(hard).some(
          ([key, limit]) => limit !== undefined && used[key as keyof UsageValues] >= limit,
        );
      const warning =
        soft &&
        Object.entries(soft).some(
          ([key, limit]) => limit !== undefined && used[key as keyof UsageValues] >= limit,
        );
      output.push({
        id: window.id,
        basis: window.basis,
        used,
        status: exhausted ? "exhausted" : warning ? "warning" : "ok",
        estimatedResetAt: new Date(
          window.type === "rolling" ? now + durationMs(window.duration) : end,
        ).toISOString(),
        source: "observed",
      });
    }
    return output;
  }
}

export function usageValues(inputTokens = 0, outputTokens = 0, cost = 0): UsageValues {
  return {
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costEquivalentMicros: cost,
  };
}
