import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppleContainerAdapter, ContainerSnapshot } from "../../src/dns/apple-container.ts";
import { StackReconciler } from "../../src/dns/reconciler.ts";
import { parseStack } from "../../src/dns/stack-loader.ts";
import { DnsStateStore } from "../../src/dns/state.ts";

const stack = parseStack({
  version: 1,
  stackId: "barback-local",
  network: "barback",
  dns: {
    zone: "barback.internal",
    container: "barback-dns",
    image: "barback-dns:build-sha256-1234567890abcdef",
    ttl: "5s",
    lease: "30s",
  },
  services: {
    barback: {
      role: "gateway",
      container: "barback-gateway",
      dns: "barback.internal",
      port: 8080,
      required: true,
      runtime: {
        mode: "managed",
        image: "barback:build-sha256-1234567890abcdef",
        env: {
          BARBACK_CONFIG: "/app/barback.yaml",
          BARBACK_SERVER_HOST: "0.0.0.0",
          BARBACK_ADMIN_HOST: "0.0.0.0",
        },
        requiredEnv: ["BARBACK_CONFIG", "BARBACK_SERVER_HOST", "BARBACK_ADMIN_HOST"],
        mounts: [
          { source: "config/barback.example.yaml", target: "/app/barback.yaml", readOnly: true },
        ],
      },
      health: { type: "http", path: "/health" },
      publishedPorts: [{ hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 }],
    },
    valkey: {
      role: "storage",
      container: "barback-valkey",
      dns: "valkey.barback.internal",
      port: 6379,
      required: true,
      runtime: {
        mode: "adopted",
        labels: {
          "io.shiborgi.barback.stack": "barback-local",
          "io.shiborgi.barback.service": "valkey",
          "io.shiborgi.barback.role": "storage",
        },
      },
      health: { type: "exec", command: ["valkey-cli", "ping"] },
    },
    google: {
      role: "mcp",
      container: "google-mcp",
      dns: "google.mcp.barback.internal",
      port: 8090,
      path: "/mcp",
      required: false,
      runtime: {
        mode: "adopted",
        labels: {
          "io.shiborgi.barback.stack": "barback-local",
          "io.shiborgi.barback.service": "google",
          "io.shiborgi.barback.role": "mcp",
        },
      },
      health: { type: "http", path: "/health" },
    },
  },
});

function snapshot(
  id: string,
  address: string,
  labels: Record<string, string>,
  publishedPorts: ContainerSnapshot["publishedPorts"] = [],
): ContainerSnapshot {
  return {
    id,
    running: true,
    network: "barback",
    addresses: [address],
    hostAddress: "192.0.2.1",
    labels,
    publishedPorts,
  };
}

class FakeAdapter implements AppleContainerAdapter {
  runs: Array<Parameters<AppleContainerAdapter["run"]>[0]> = [];
  resolutions: Array<{ container: string; hostname: string; address: string }> = [];
  traffic: Array<{ container: string; hostname: string; port: number }> = [];
  httpProbes: Array<{ address: string; port: number; path: string }> = [];
  constructor(readonly items: Map<string, ContainerSnapshot>) {}
  async ensureSystem() {}
  async ensureNetwork() {}
  async inspectNetwork() {
    return { subnet: "192.0.2.0/24" };
  }
  async build() {}
  async run(input: Parameters<AppleContainerAdapter["run"]>[0]) {
    this.runs.push(input);
    const current = this.items.get(input.name);
    if (current) this.items.set(input.name, { ...current, labels: input.labels });
  }
  async remove() {}
  async probeHttp(address: string, port: number, path: string) {
    this.httpProbes.push({ address, port, path });
  }
  async resolveFrom(container: string, hostname: string, address: string) {
    this.resolutions.push({ container, hostname, address });
  }
  async probeFrom(container: string, hostname: string, port: number) {
    this.traffic.push({ container, hostname, port });
  }
  async exec() {}
  async inspect(name: string) {
    return this.items.get(name) ?? null;
  }
}

describe("manifest reconciler", () => {
  test("writes records only after all required identities validate", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-reconciler-"));
    try {
      const labels = (service: string, role: string) => ({
        "io.shiborgi.barback.stack": "barback-local",
        "io.shiborgi.barback.service": service,
        "io.shiborgi.barback.role": role,
      });
      const adapter = new FakeAdapter(
        new Map([
          [
            "barback-dns",
            snapshot("resolver-a", "192.0.2.2", {
              ...labels("dns", "dns"),
              "io.shiborgi.barback.resolver-instance": "resolver-a",
            }),
          ],
          [
            "barback-gateway",
            snapshot("gateway", "192.0.2.3", labels("barback", "gateway"), [
              { hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 },
            ]),
          ],
          ["barback-valkey", snapshot("valkey", "192.0.2.4", labels("valkey", "storage"))],
        ]),
      );
      const reconciler = new StackReconciler(
        stack,
        {} as never,
        adapter,
        new DnsStateStore("barback-local", root),
      );
      await reconciler.reconcile(new Date("2026-08-30T12:00:00.000Z"));
      expect(
        await readFile(join(root, "records", "current", "db.barback.internal"), "utf8"),
      ).toContain("valkey IN A 192.0.2.4");
      adapter.items.set("barback-gateway", snapshot("gateway", "192.0.2.3", {}, []));
      await expect(reconciler.reconcile(new Date("2026-08-30T12:00:01.000Z"))).rejects.toThrow(
        /invalid/,
      );
      expect(
        await readFile(join(root, "records", "current", "db.barback.internal"), "utf8"),
      ).toContain("valkey IN A 192.0.2.4");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes the resolver only to managed consumers", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-reconciler-"));
    try {
      const labels = (service: string, role: string) => ({
        "io.shiborgi.barback.stack": "barback-local",
        "io.shiborgi.barback.service": service,
        "io.shiborgi.barback.role": role,
      });
      const adapter = new FakeAdapter(
        new Map([
          [
            "barback-dns",
            snapshot("resolver-a", "192.0.2.2", {
              ...labels("dns", "dns"),
              "io.shiborgi.barback.resolver-instance": "resolver-a",
            }),
          ],
          [
            "barback-gateway",
            snapshot("gateway", "192.0.2.3", labels("barback", "gateway"), [
              { hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 },
            ]),
          ],
          ["barback-valkey", snapshot("valkey", "192.0.2.4", labels("valkey", "storage"))],
        ]),
      );
      const reconciler = new StackReconciler(
        stack,
        {} as never,
        adapter,
        new DnsStateStore("barback-local", root),
      );
      await reconciler.up();
      expect(adapter.runs).toHaveLength(1);
      expect(adapter.runs[0]?.dns).toEqual(["192.0.2.2"]);
      expect(adapter.runs[0]?.dnsSearch).toEqual(["barback.internal"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("recreates managed consumers and atomically refreshes client config when resolver address changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-reconciler-"));
    try {
      const labels = (service: string, role: string) => ({
        "io.shiborgi.barback.stack": "barback-local",
        "io.shiborgi.barback.service": service,
        "io.shiborgi.barback.role": role,
      });
      const adapter = new FakeAdapter(
        new Map([
          [
            "barback-dns",
            snapshot("resolver-a", "192.0.2.2", {
              ...labels("dns", "dns"),
              "io.shiborgi.barback.resolver-instance": "resolver-a",
            }),
          ],
          [
            "barback-gateway",
            snapshot("gateway", "192.0.2.3", labels("barback", "gateway"), [
              { hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 },
            ]),
          ],
          ["barback-valkey", snapshot("valkey", "192.0.2.4", labels("valkey", "storage"))],
        ]),
      );
      const reconciler = new StackReconciler(
        stack,
        {} as never,
        adapter,
        new DnsStateStore("barback-local", root),
      );
      await reconciler.reconcile(new Date("2026-08-30T12:00:00.000Z"));
      const first = await reconciler.clientConfig(new Date("2026-08-30T12:00:01.000Z"));
      adapter.items.set(
        "barback-dns",
        snapshot("resolver-a", "192.0.2.9", {
          ...labels("dns", "dns"),
          "io.shiborgi.barback.resolver-instance": "resolver-a",
        }),
      );
      await reconciler.reconcile(new Date("2026-08-30T12:00:02.000Z"));
      expect(adapter.runs).toHaveLength(1);
      const published = JSON.parse(await readFile(join(root, "client-config.json"), "utf8"));
      expect(published.dnsGeneration).not.toBe(first.dnsGeneration);
      expect(published.hostGateway).toBe("192.0.2.1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the last valid bundle and lease when a required health probe fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-reconciler-"));
    try {
      const labels = (service: string, role: string) => ({
        "io.shiborgi.barback.stack": "barback-local",
        "io.shiborgi.barback.service": service,
        "io.shiborgi.barback.role": role,
      });
      const adapter = new FakeAdapter(
        new Map([
          [
            "barback-dns",
            snapshot("resolver-a", "192.0.2.2", {
              ...labels("dns", "dns"),
              "io.shiborgi.barback.resolver-instance": "resolver-a",
            }),
          ],
          [
            "barback-gateway",
            snapshot("gateway", "192.0.2.3", labels("barback", "gateway"), [
              { hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 },
            ]),
          ],
          ["barback-valkey", snapshot("valkey", "192.0.2.4", labels("valkey", "storage"))],
        ]),
      );
      const reconciler = new StackReconciler(
        stack,
        {} as never,
        adapter,
        new DnsStateStore("barback-local", root),
      );
      await reconciler.reconcile(new Date("2026-08-30T12:00:00.000Z"));
      adapter.probeHttp = async () => {
        throw new Error("unhealthy");
      };
      await expect(reconciler.reconcile(new Date("2026-08-30T12:00:01.000Z"))).rejects.toThrow(
        /health probe/,
      );
      expect(
        JSON.parse(await readFile(join(root, "records", "current", "lease.json"), "utf8")),
      ).toMatchObject({ sequence: 1 });
      expect((await reconciler.state.load())?.lease?.sequence).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reuses managed services on repeated up and verifies required traffic from the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-reconciler-"));
    try {
      const labels = (service: string, role: string) => ({
        "io.shiborgi.barback.stack": "barback-local",
        "io.shiborgi.barback.service": service,
        "io.shiborgi.barback.role": role,
      });
      const adapter = new FakeAdapter(
        new Map([
          [
            "barback-dns",
            snapshot("resolver-a", "192.0.2.2", {
              ...labels("dns", "dns"),
              "io.shiborgi.barback.resolver-instance": "resolver-a",
            }),
          ],
          [
            "barback-gateway",
            snapshot("gateway", "192.0.2.3", labels("barback", "gateway"), [
              { hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 },
            ]),
          ],
          ["barback-valkey", snapshot("valkey", "192.0.2.4", labels("valkey", "storage"))],
        ]),
      );
      const reconciler = new StackReconciler(
        stack,
        {} as never,
        adapter,
        new DnsStateStore("barback-local", root),
      );
      await reconciler.up();
      const firstRuns = adapter.runs.length;
      await reconciler.up();
      expect(adapter.runs).toHaveLength(firstRuns);
      expect(adapter.resolutions).toContainEqual({
        container: "barback-gateway",
        hostname: "valkey.barback.internal",
        address: "192.0.2.4",
      });
      expect(adapter.traffic).toContainEqual({
        container: "barback-gateway",
        hostname: "valkey.barback.internal",
        port: 6379,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes a complete bootstrap bundle before starting the resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-reconciler-"));
    try {
      const labels = (service: string, role: string) => ({
        "io.shiborgi.barback.stack": "barback-local",
        "io.shiborgi.barback.service": service,
        "io.shiborgi.barback.role": role,
      });
      const adapter = new FakeAdapter(
        new Map([
          [
            "barback-gateway",
            snapshot("gateway", "192.0.2.3", labels("barback", "gateway"), [
              { hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 },
            ]),
          ],
          ["barback-valkey", snapshot("valkey", "192.0.2.4", labels("valkey", "storage"))],
        ]),
      );
      const run = adapter.run.bind(adapter);
      adapter.run = async (input) => {
        if (input.name === "barback-dns") {
          const records = await readFile(
            join(root, "records", "current", "db.barback.internal"),
            "utf8",
          );
          const lease = JSON.parse(
            await readFile(join(root, "records", "current", "lease.json"), "utf8"),
          );
          expect(records).toContain("@ IN A 127.0.0.1");
          expect(lease.sequence).toBe(0);
          adapter.items.set("barback-dns", snapshot("resolver-a", "192.0.2.2", input.labels));
        }
        await run(input);
      };
      const reconciler = new StackReconciler(
        stack,
        {} as never,
        adapter,
        new DnsStateStore("barback-local", root),
      );
      await reconciler.up();
      expect(
        await readFile(join(root, "records", "current", "db.barback.internal"), "utf8"),
      ).toContain("dns IN A 192.0.2.2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("converges dependency FQDNs within the restart window without replacing the gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "barback-reconciler-"));
    try {
      const labels = (service: string, role: string) => ({
        "io.shiborgi.barback.stack": "barback-local",
        "io.shiborgi.barback.service": service,
        "io.shiborgi.barback.role": role,
      });
      const adapter = new FakeAdapter(
        new Map([
          [
            "barback-dns",
            snapshot("resolver-a", "192.0.2.2", {
              ...labels("dns", "dns"),
              "io.shiborgi.barback.resolver-instance": "resolver-a",
            }),
          ],
          [
            "barback-gateway",
            snapshot("gateway-stable", "192.0.2.3", labels("barback", "gateway"), [
              { hostIp: "127.0.0.1", hostPort: 8080, containerPort: 8080 },
            ]),
          ],
          ["barback-valkey", snapshot("valkey-a", "192.0.2.4", labels("valkey", "storage"))],
          ["google-mcp", snapshot("google-a", "192.0.2.5", labels("google", "mcp"))],
        ]),
      );
      const reconciler = new StackReconciler(
        stack,
        {} as never,
        adapter,
        new DnsStateStore("barback-local", root),
      );
      const startedAt = new Date("2026-08-30T12:00:00.000Z");
      await reconciler.reconcile(startedAt);
      const gatewayId = (await adapter.inspect("barback-gateway"))?.id;

      adapter.items.set(
        "barback-valkey",
        snapshot("valkey-b", "192.0.2.40", labels("valkey", "storage")),
      );
      adapter.items.set("google-mcp", snapshot("google-b", "192.0.2.50", labels("google", "mcp")));
      const convergedAt = new Date("2026-08-30T12:00:10.000Z");
      await reconciler.reconcile(convergedAt);

      const records = await readFile(
        join(root, "records", "current", "db.barback.internal"),
        "utf8",
      );
      expect(convergedAt.getTime() - startedAt.getTime()).toBeLessThan(15_000);
      expect(records).toContain("valkey IN A 192.0.2.40");
      expect(records).toContain("google.mcp IN A 192.0.2.50");
      expect(adapter.resolutions).toContainEqual({
        container: "barback-gateway",
        hostname: "valkey.barback.internal",
        address: "192.0.2.40",
      });
      expect(adapter.traffic).toContainEqual({
        container: "barback-gateway",
        hostname: "valkey.barback.internal",
        port: 6379,
      });
      expect(adapter.httpProbes).toContainEqual({
        address: "192.0.2.50",
        port: 8090,
        path: "/health",
      });
      expect((await adapter.inspect("barback-gateway"))?.id).toBe(gatewayId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
