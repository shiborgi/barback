import { timingSafeEqual } from "node:crypto";
import type { BarbackConfig, ClientConfig } from "../config/schema.ts";

function equals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authenticate(
  header: string | undefined,
  config: BarbackConfig,
): ClientConfig | undefined {
  if (!header?.startsWith("Bearer ")) return undefined;
  const key = header.slice(7);
  let match: ClientConfig | undefined;
  for (const client of config.auth.clients) {
    if (equals(key, client.key)) match = client;
  }
  return match;
}

function ipv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    out = (out << 8) | octet;
  }
  return out >>> 0;
}

/** Resolve the configured relay identity only for a private trusted subnet. */
export function authenticateHostRelay(sourceIp: string | undefined, config: BarbackConfig): ClientConfig | undefined {
  if (!sourceIp || !config.auth.hostRelay) return undefined;
  const address = ipv4(sourceIp);
  if (address === undefined) return undefined;
  const trusted = config.auth.hostRelay.trustedCidrs.some((cidr) => {
    const [network, prefixText] = cidr.split("/");
    if (network === undefined || prefixText === undefined) return false;
    const prefix = Number(prefixText);
    const base = ipv4(network);
    if (base === undefined || prefix < 0 || prefix > 32) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (address & mask) === (base & mask);
  });
  if (!trusted) return undefined;
  return config.auth.clients.find((client) => client.id === config.auth.hostRelay!.client);
}

export function hasScope(client: ClientConfig, scope: ClientConfig["scopes"][number]): boolean {
  return client.scopes.includes(scope) || client.scopes.includes("admin");
}
