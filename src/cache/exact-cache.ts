import type { GatewayChatResponse } from "../providers/provider.ts";
import type { OperationalStore } from "../storage/valkey.ts";

export interface CachedChatResponse {
  response: GatewayChatResponse;
  createdAt: string;
  expiresAt: string;
}

const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class ExactCache {
  constructor(
    private readonly store: OperationalStore,
    private readonly prefix: string,
  ) {}

  #key(id: string) {
    return `${this.prefix}:cache:exact:${id}`;
  }
  #index(namespace: string) {
    return `${this.prefix}:cache:index:namespace:${namespace}`;
  }

  async get(id: string): Promise<CachedChatResponse | undefined> {
    try {
      const value = await this.store.get(this.#key(id));
      return value ? (JSON.parse(value) as CachedChatResponse) : undefined;
    } catch {
      return undefined;
    }
  }

  async put(
    id: string,
    namespace: string,
    response: GatewayChatResponse,
    ttlMs: number,
  ): Promise<void> {
    const entry: CachedChatResponse = {
      response,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    try {
      const key = this.#key(id);
      await this.store.set(key, JSON.stringify(entry), ttlMs);
      await this.store.sadd(this.#index(namespace), key);
      await this.store.expire(this.#index(namespace), Math.ceil(ttlMs / 1000) + 60);
    } catch {
      // Cache writes are best effort.
    }
  }

  async invalidateId(id: string): Promise<number> {
    return this.store.del(this.#key(id));
  }

  async invalidateNamespace(namespace: string): Promise<number> {
    const index = this.#index(namespace);
    const keys = await this.store.smembers(index);
    return (await this.store.del(...keys)) + (await this.store.del(index));
  }

  async lock(id: string, ttlMs = 5_000): Promise<string | undefined> {
    const token = crypto.randomUUID();
    try {
      const result = await this.store.command([
        "SET",
        `${this.prefix}:lock:${id}`,
        token,
        "PX",
        ttlMs,
        "NX",
      ]);
      return result === "OK" ? token : undefined;
    } catch {
      return undefined;
    }
  }

  async unlock(id: string, token: string): Promise<void> {
    try {
      await this.store.eval(RELEASE_LOCK, [`${this.prefix}:lock:${id}`], [token]);
    } catch {
      // Lock expiry is the fallback.
    }
  }
}
