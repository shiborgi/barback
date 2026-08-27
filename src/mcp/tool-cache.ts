import { sha256 } from "../cache/cache-key.ts";
import { stableJson } from "../cache/canonicalize.ts";
import type { OperationalStore } from "../storage/valkey.ts";

export class McpToolCache {
  constructor(
    private readonly store: OperationalStore,
    private readonly prefix: string,
  ) {}

  id(client: string, server: string, tool: string, args: unknown): string {
    return sha256(stableJson({ version: 1, client, server, tool, args }));
  }

  async get(id: string): Promise<unknown | undefined> {
    try {
      const raw = await this.store.get(`${this.prefix}:cache:mcp:${id}`);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  async put(id: string, value: unknown, ttlMs: number): Promise<void> {
    try {
      await this.store.set(`${this.prefix}:cache:mcp:${id}`, JSON.stringify(value), ttlMs);
    } catch {
      // Tool cache is best effort.
    }
  }
}
