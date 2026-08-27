import Redis from "ioredis";
import type { BarbackConfig } from "../config/schema.ts";

export interface OperationalStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(...keys: string[]): Promise<number>;
  sadd(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
  eval(script: string, keys: string[], args: Array<string | number | Buffer>): Promise<unknown>;
  command(args: Array<string | number | Buffer>): Promise<unknown>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class ValkeyStore implements OperationalStore {
  readonly client: Redis;

  constructor(readonly config: BarbackConfig["storage"]["valkey"]) {
    this.client = new Redis(config.url, {
      connectTimeout: config.connectTimeout,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
    });
    this.client.on("error", () => undefined);
  }

  async connect() {
    if (this.client.status === "wait") await this.client.connect();
    await this.client.ping();
  }

  async get(key: string) {
    return this.client.get(key);
  }
  async set(key: string, value: string, ttlMs?: number) {
    if (ttlMs !== undefined) await this.client.set(key, value, "PX", ttlMs);
    else await this.client.set(key, value);
  }
  async del(...keys: string[]) {
    return keys.length ? this.client.del(...keys) : 0;
  }
  async sadd(key: string, ...members: string[]) {
    return members.length ? this.client.sadd(key, ...members) : 0;
  }
  async smembers(key: string) {
    return this.client.smembers(key);
  }
  async expire(key: string, seconds: number) {
    return this.client.expire(key, seconds);
  }
  async eval(script: string, keys: string[], args: Array<string | number | Buffer>) {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }
  async command(args: Array<string | number | Buffer>) {
    return this.client.call(...(args as [string, ...Array<string | number | Buffer>]));
  }
  async ping() {
    try {
      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }
  async close() {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

export class MemoryStore implements OperationalStore {
  #values = new Map<string, { value: string; expires?: number }>();
  #sets = new Map<string, Set<string>>();

  async get(key: string) {
    const entry = this.#values.get(key);
    if (entry?.expires !== undefined && entry.expires <= Date.now()) {
      this.#values.delete(key);
      return null;
    }
    return entry?.value ?? null;
  }
  async set(key: string, value: string, ttlMs?: number) {
    this.#values.set(key, {
      value,
      ...(ttlMs !== undefined ? { expires: Date.now() + ttlMs } : {}),
    });
  }
  async del(...keys: string[]) {
    let count = 0;
    for (const key of keys) {
      if (this.#values.delete(key)) count += 1;
      if (this.#sets.delete(key)) count += 1;
    }
    return count;
  }
  async sadd(key: string, ...members: string[]) {
    const set = this.#sets.get(key) ?? new Set<string>();
    const before = set.size;
    for (const member of members) set.add(member);
    this.#sets.set(key, set);
    return set.size - before;
  }
  async smembers(key: string) {
    return [...(this.#sets.get(key) ?? [])];
  }
  async expire(_key: string, _seconds: number) {
    return 1;
  }
  async eval() {
    throw new Error("MemoryStore does not implement scripts");
  }
  async command() {
    throw new Error("MemoryStore does not implement arbitrary commands");
  }
  async ping() {
    return true;
  }
  async close() {}
}
