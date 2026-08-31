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

describe("Restart convergence integration", () => {
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

  test("converges within 15s using a monotonic clock and keeps gateway intact", async () => {
    if (process.env.BARBACK_APPLE_CONTAINER_TESTS !== "true") {
      console.log("Skipping Apple Container tests (set BARBACK_APPLE_CONTAINER_TESTS=true)");
      return;
    }
    if (!hasContainer) {
      console.log("Skipping Apple Container tests because runtime is unavailable");
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "barback-convergence-"));
    try {
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("container", ["network", "create", "barback-convergence-net"]);
      } catch {}
      await adapter.run({
        name: "barback-convergence-gateway",
        image: "alpine:latest",
        network: "barback-convergence-net",
        command: ["sleep", "3600"],
        labels: {
          "io.shiborgi.barback.stack": "barback-convergence",
          "io.shiborgi.barback.service": "barback",
          "io.shiborgi.barback.role": "gateway",
        },
      });
      await adapter.run({
        name: "barback-convergence-valkey",
        image: "alpine:latest",
        network: "barback-convergence-net",
        command: ["sleep", "3600"],
        labels: {
          "io.shiborgi.barback.stack": "barback-convergence",
          "io.shiborgi.barback.service": "valkey",
          "io.shiborgi.barback.role": "storage",
        },
      });
      const stack = parseStack({
        version: 1,
        stackId: "barback-convergence",
        network: "barback-convergence-net",
        dns: {
          zone: "barback.internal",
          container: "barback-convergence-dns",
          image: "barback-dns:build-sha256-1234567890abcdef",
          buildContext: "dns",
          ttl: "5s",
          lease: "30s",
        },
        services: {
          barback: {
            role: "gateway",
            container: "barback-convergence-gateway",
            dns: "barback.internal",
            port: 8080,
            required: true,
            runtime: {
              mode: "adopted",
              labels: {
                "io.shiborgi.barback.stack": "barback-convergence",
                "io.shiborgi.barback.service": "barback",
                "io.shiborgi.barback.role": "gateway",
              },
            },
            health: { type: "exec", command: ["true"] },
          },
          valkey: {
            role: "storage",
            container: "barback-convergence-valkey",
            dns: "valkey.barback.internal",
            port: 6379,
            required: true,
            runtime: {
              mode: "adopted",
              labels: {
                "io.shiborgi.barback.stack": "barback-convergence",
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

      const inspect1 = await adapter.inspect("barback-convergence-gateway");
      const id1 = inspect1?.id;

      // Stop valkey to simulate a restart / address change
      await adapter.remove("barback-convergence-valkey");

      const startedAt = performance.now();

      // We manually bring it back up to get a new IP
      await reconciler.reconcile();

      const elapsed = performance.now() - startedAt;
      expect(elapsed).toBeLessThan(15000);

      const inspect2 = await adapter.inspect("barback-convergence-gateway");
      expect(inspect2?.id).toBe(id1!);

      // Check FQDN traffic succeeds from gateway
      await adapter.exec("barback-convergence-gateway", [
        "ping",
        "-c",
        "1",
        "valkey.barback.internal",
      ]);
    } finally {
      await adapter.remove("barback-convergence-gateway").catch(() => {});
      await adapter.remove("barback-convergence-valkey").catch(() => {});
      await adapter.remove("barback-convergence-dns").catch(() => {});
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("container", ["network", "delete", "barback-convergence-net"]);
      } catch {}
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
