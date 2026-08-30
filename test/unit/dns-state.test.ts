import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLease,
  clientConfigSchema,
  DnsStateStore,
  loadDnsState,
  publishClientConfig,
  updateDnsGeneration,
  validateClientConfig,
} from "../../src/dns/state.ts";
import { DnsLeaseSupervisor, renderDnsRecords } from "../../src/dns/supervisor.ts";

const now = new Date("2026-08-29T12:00:00.000Z");

describe("DNS control-plane state", () => {
  test("keeps generation stable for equal resolver identity and persists changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-state-"));
    try {
      const first = updateDnsGeneration(undefined, ["192.0.2.10"], "dns-1");
      const same = updateDnsGeneration(first, ["192.0.2.10"], "dns-1");
      const changedAddress = updateDnsGeneration(first, ["192.0.2.11"], "dns-1");
      const changed = updateDnsGeneration(first, ["192.0.2.10"], "dns-2");
      expect(same.dnsGeneration).toBe(first.dnsGeneration);
      expect(changedAddress.dnsGeneration).not.toBe(first.dnsGeneration);
      expect(changed.dnsGeneration).not.toBe(first.dnsGeneration);
      await expect(loadDnsState(root)).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts only monotonic, current leases", () => {
    const lease = {
      schemaVersion: 1 as const,
      stackId: "barback-local",
      dnsGeneration: "generation-1",
      sequence: 2,
      validUntil: "2026-08-29T12:00:30.000Z",
    };
    expect(applyLease(undefined, lease, now)).toEqual(lease);
    expect(applyLease(lease, { ...lease, validUntil: "2026-08-29T12:01:00.000Z" }, now)).toEqual(
      lease,
    );
    expect(() => applyLease(lease, { ...lease, sequence: 1 }, now)).toThrow(/sequence/);
    expect(() => applyLease(lease, { ...lease, validUntil: now.toISOString() }, now)).toThrow(
      /expired/,
    );
  });

  test("persists resolver identity and drops a lease when generation changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-state-"));
    try {
      const store = new DnsStateStore("barback-local", root);
      const first = await store.updateResolver(["192.0.2.10"], "dns-1");
      await store.replaceLease(
        {
          schemaVersion: 1,
          stackId: "barback-local",
          dnsGeneration: first.dnsGeneration,
          sequence: 1,
          validUntil: "2026-08-29T12:00:30.000Z",
        },
        now,
      );
      expect((await loadDnsState(root))?.lease?.sequence).toBe(1);
      const changed = await store.updateResolver(["192.0.2.11"], "dns-2");
      expect(changed.dnsGeneration).not.toBe(first.dnsGeneration);
      expect(changed.lease).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes a validated secret-free client configuration with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-state-"));
    try {
      const config = clientConfigSchema.parse({
        schemaVersion: 1,
        stackId: "barback-local",
        network: "barback",
        hostGateway: "192.0.2.1",
        dnsServers: ["192.0.2.10"],
        dnsSearch: ["barback.internal"],
        dnsGeneration: "generation-1",
        generatedAt: now.toISOString(),
        validUntil: "2026-08-29T12:00:30.000Z",
        apiBaseUrl: "http://barback.internal:8080/v1",
        mcpUrl: "http://barback.internal:8080/mcp",
        credentialMode: "onecli-proxy",
      });
      const path = await publishClientConfig(root, config);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
      expect((await lstat(path)).mode & 0o077).toBe(0);
      await symlink(root, join(root, "link"));
      await expect(publishClientConfig(join(root, "link"), config)).rejects.toThrow(/symlink/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects expired and IP-literal application endpoints", () => {
    const input = {
      schemaVersion: 1,
      stackId: "barback-local",
      network: "barback",
      hostGateway: "192.0.2.1",
      dnsServers: ["192.0.2.10"],
      dnsSearch: ["barback.internal"],
      dnsGeneration: "generation-1",
      generatedAt: now.toISOString(),
      validUntil: "2026-08-29T11:59:59.000Z",
      apiBaseUrl: "http://192.0.2.10:8080/v1",
      mcpUrl: "http://barback.internal:8080/mcp",
      credentialMode: "onecli-proxy",
    };
    expect(() => clientConfigSchema.parse(input)).toThrow(/IP literal/);

    const valid = clientConfigSchema.parse({
      ...input,
      validUntil: "2026-08-29T12:00:30.000Z",
      apiBaseUrl: "http://barback.internal:8080/v1",
    });
    expect(() => validateClientConfig(valid, new Date("2026-08-29T12:00:31.000Z"))).toThrow(
      /expired/,
    );
    expect(() => clientConfigSchema.parse({ ...valid, generatedAt: "not-a-date" })).toThrow(
      /ISO-8601/,
    );
    expect(() => clientConfigSchema.parse({ ...valid, token: "secret" })).toThrow();
  });

  test("fails closed on expiry, recovers on renewal, and rejects invalid lease updates", () => {
    const supervisor = new DnsLeaseSupervisor("barback-local", "generation-1");
    const lease = {
      schemaVersion: 1,
      stackId: "barback-local",
      dnsGeneration: "generation-1",
      sequence: 2,
      validUntil: "2026-08-29T12:00:30.000Z",
    };
    supervisor.renew(lease, now);
    expect(supervisor.status(now)).toEqual({ healthy: true, privateZone: "active" });
    expect(supervisor.status(new Date("2026-08-29T12:00:31.000Z"))).toEqual({
      healthy: false,
      privateZone: "servfail",
    });
    expect(() => supervisor.renew({ ...lease, sequence: 1 }, now)).toThrow(/sequence/);
    expect(() => supervisor.renew({ ...lease, stackId: "other-stack", sequence: 3 }, now)).toThrow(
      /different stack/,
    );
    expect(() => supervisor.renew({ ...lease, dnsGeneration: "other", sequence: 3 }, now)).toThrow(
      /generation/,
    );
    expect(() => supervisor.renew({ ...lease, dnsGeneration: "other" }, now)).toThrow(/generation/);
    expect(() => supervisor.renew({ schemaVersion: 1 }, now)).toThrow(/stackId/);
    supervisor.renew({ ...lease, sequence: 3, validUntil: "2026-08-29T12:01:00.000Z" }, now);
    expect(supervisor.status(new Date("2026-08-29T12:00:31.000Z"))).toEqual({
      healthy: true,
      privateZone: "active",
    });
  });

  test("keeps valid records when a reload fails and renders explicit A records only", async () => {
    const supervisor = new DnsLeaseSupervisor("barback-local", "generation-1");
    supervisor.renew(
      {
        schemaVersion: 1,
        stackId: "barback-local",
        dnsGeneration: "generation-1",
        sequence: 1,
        validUntil: "2026-08-29T12:00:30.000Z",
      },
      now,
    );
    const records = [
      { name: "barback.internal", address: "192.0.2.10" },
      { name: "dns.barback.internal", address: "192.0.2.12" },
      { name: "valkey.barback.internal", address: "192.0.2.11" },
    ];
    await supervisor.reload(records, async () => {}, now);
    const active = supervisor.activeRecords;
    await expect(
      supervisor.reload(records, async () => Promise.reject(new Error("reload failed")), now),
    ).rejects.toThrow(/reload failed/);
    expect(supervisor.activeRecords).toBe(active);
    expect(renderDnsRecords(records)).toContain("@ IN A 192.0.2.10");
    expect(renderDnsRecords(records)).toContain("@ IN SOA dns.barback.internal.");
    expect(() =>
      renderDnsRecords([{ name: "Bad.barback.internal", address: "192.0.2.10" }]),
    ).toThrow(/inside barback.internal/);
  });
});
