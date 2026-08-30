import { isIP } from "node:net";
import { ConfigError } from "../config/loader.ts";
import { applyLease, type DnsLease, leaseSchema } from "./state.ts";

const dnsRecordName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*barback\.internal$/;

export interface DnsRecord {
  name: string;
  address: string;
}

export type PrivateZoneStatus = "active" | "servfail";

export function renderDnsRecords(records: DnsRecord[], ttl = 5): string {
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 30) {
    throw new ConfigError("DNS record TTL must be between 1 and 30 seconds");
  }
  if (records.length === 0) throw new ConfigError("DNS records must not be empty");

  const names = new Set<string>();
  for (const record of records) {
    if (!dnsRecordName.test(record.name)) {
      throw new ConfigError("DNS record must be inside barback.internal");
    }
    if (isIP(record.address) !== 4)
      throw new ConfigError("DNS records must contain IPv4 A addresses");
    if (names.has(record.name)) throw new ConfigError(`Duplicate DNS record: ${record.name}`);
    names.add(record.name);
  }
  if (!names.has("barback.internal")) {
    throw new ConfigError("DNS records must include barback.internal");
  }
  if (!names.has("dns.barback.internal")) {
    throw new ConfigError("DNS records must include dns.barback.internal");
  }

  return [
    "$ORIGIN barback.internal.",
    `$TTL ${ttl}`,
    "@ IN SOA dns.barback.internal. hostmaster.barback.internal. 1 60 30 300 5",
    "@ IN NS dns.barback.internal.",
    ...[...records]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(
        (record) =>
          `${record.name === "barback.internal" ? "@" : record.name.slice(0, -17)} IN A ${record.address}`,
      ),
    "",
  ].join("\n");
}

/** Keeps the last known-good records while a valid lease is active. */
export class DnsLeaseSupervisor {
  #lease: DnsLease | undefined;
  #records: string | undefined;

  constructor(
    readonly stackId: string,
    readonly dnsGeneration: string,
  ) {}

  renew(replacement: unknown, now = new Date()): DnsLease {
    const candidate = leaseSchema.parse(replacement);
    if (candidate.dnsGeneration !== this.dnsGeneration) {
      throw new ConfigError("Lease generation does not match DNS supervisor");
    }
    const lease = applyLease(this.#lease, candidate, now, this.stackId);
    this.#lease = lease;
    return lease;
  }

  status(now = new Date()): { healthy: boolean; privateZone: PrivateZoneStatus } {
    const healthy = Boolean(this.#lease && Date.parse(this.#lease.validUntil) > now.getTime());
    return { healthy, privateZone: healthy ? "active" : "servfail" };
  }

  async reload(
    records: DnsRecord[],
    reload: (rendered: string) => Promise<void>,
    now = new Date(),
  ): Promise<void> {
    if (!this.status(now).healthy)
      throw new ConfigError("Cannot reload records without an active lease");
    const rendered = renderDnsRecords(records);
    await reload(rendered);
    this.#records = rendered;
  }

  get activeRecords(): string | undefined {
    return this.#records;
  }
}
