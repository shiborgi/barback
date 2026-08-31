import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../../src/config/loader.ts";
import { AppleContainerCli } from "../../src/dns/apple-container.ts";
import { StackReconciler } from "../../src/dns/reconciler.ts";
import { parseStack } from "../../src/dns/stack-loader.ts";
import { DnsStateStore } from "../../src/dns/state.ts";
import { testConfigInput } from "../fixtures/config.ts";

describe("Lifecycle integration tests", () => {
  let adapter: AppleContainerCli;
  let hasContainer = false;

  beforeAll(async () => {
    if (process.env.BARBACK_APPLE_CONTAINER_TESTS !== "true") return;
    adapter = new AppleContainerCli();
    try {
      await adapter.ensureSystem();
      hasContainer = true;
    } catch {
      hasContainer = false;
    }
  });

  test("recreates the resolver, changes generation, and replaces bootstrap-DNS consumers", async () => {
    if (process.env.BARBACK_APPLE_CONTAINER_TESTS !== "true") {
      console.log("Skipping Apple Container tests (set BARBACK_APPLE_CONTAINER_TESTS=true)");
      return;
    }
    if (!hasContainer) {
      console.log("Skipping Apple Container tests because runtime is unavailable");
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "barback-lifecycle-"));
    try {
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("container", ["network", "create", "barback-lifecycle-net"]);
      } catch {}
      await adapter.run({
        name: "barback-lifecycle-consumer",
        image: "alpine:latest",
        network: "barback-lifecycle-net",
        command: ["sleep", "3600"],
        labels: {
          "io.shiborgi.barback.stack": "barback-lifecycle",
          "io.shiborgi.barback.service": "barback",
          "io.shiborgi.barback.role": "gateway",
        },
      });
      await adapter.run({
        name: "barback-lifecycle-valkey",
        image: "alpine:latest",
        network: "barback-lifecycle-net",
        command: ["sleep", "3600"],
        labels: {
          "io.shiborgi.barback.stack": "barback-lifecycle",
          "io.shiborgi.barback.service": "valkey",
          "io.shiborgi.barback.role": "storage",
        },
      });
      const stack = parseStack({
        version: 1,
        stackId: "barback-lifecycle",
        network: "barback-lifecycle-net",
        dns: {
          zone: "barback.internal",
          container: "barback-lifecycle-dns",
          image: "barback-dns:build-sha256-1234567890abcdef",
          buildContext: "dns",
          ttl: "5s",
          lease: "30s",
        },
        services: {
          barback: {
            role: "gateway",
            container: "barback-lifecycle-consumer",
            dns: "barback.internal",
            port: 80,
            required: true,
            runtime: {
              mode: "adopted",
              labels: {
                "io.shiborgi.barback.stack": "barback-lifecycle",
                "io.shiborgi.barback.service": "barback",
                "io.shiborgi.barback.role": "gateway",
              },
            },
            health: { type: "exec", command: ["true"] },
          },
          valkey: {
            role: "storage",
            container: "barback-lifecycle-valkey",
            dns: "valkey.barback.internal",
            port: 6379,
            required: true,
            runtime: {
              mode: "adopted",
              labels: {
                "io.shiborgi.barback.stack": "barback-lifecycle",
                "io.shiborgi.barback.service": "valkey",
                "io.shiborgi.barback.role": "storage",
              },
            },
            health: { type: "exec", command: ["true"] },
          },
        },
      });
      const config = new ConfigStore(testConfigInput() as any).get();
      const state = new DnsStateStore(stack.stackId, root);
      const reconciler = new StackReconciler(stack, config, adapter, state);

      await reconciler.up();

      const inspect1 = await adapter.inspect("barback-lifecycle-consumer");
      const dns1 = inspect1?.addresses?.[0];
      const gen1 = inspect1?.labels["io.shiborgi.barback.resolver-generation"];
      const id1 = inspect1?.id;

      expect(dns1).toBeTruthy();
      expect(gen1).toBeTruthy();

      // Delete the resolver to force recreation
      await adapter.remove("barback-lifecycle-dns");

      await reconciler.reconcile();

      const inspect2 = await adapter.inspect("barback-lifecycle-consumer");
      const dns2 = inspect2?.addresses?.[0];
      const gen2 = inspect2?.labels["io.shiborgi.barback.resolver-generation"];
      const id2 = inspect2?.id;

      expect(dns2).toBeTruthy();
      expect(gen2).toBeTruthy();
      expect(gen2).not.toBe(gen1!);
      expect(id2).not.toBe(id1!); // Consumer replaced
    } finally {
      await adapter.remove("barback-lifecycle-consumer").catch(() => {});
      await adapter.remove("barback-lifecycle-valkey").catch(() => {});
      await adapter.remove("barback-lifecycle-dns").catch(() => {});
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("container", ["network", "delete", "barback-lifecycle-net"]);
      } catch {}
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
