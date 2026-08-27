import { timingSafeEqual } from "node:crypto";
import type { ClientConfig, GatepatrolConfig } from "../config/schema.ts";

function equals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authenticate(
  header: string | undefined,
  config: GatepatrolConfig,
): ClientConfig | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const key = header.slice(7);
  let match: ClientConfig | undefined;
  for (const client of config.auth.clients) {
    if (equals(key, client.key)) match = client;
  }
  return match;
}

export function hasScope(client: ClientConfig, scope: ClientConfig["scopes"][number]): boolean {
  return client.scopes.includes(scope) || client.scopes.includes("admin");
}
