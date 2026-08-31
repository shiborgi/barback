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

describe("Apple Container resolver integration", () => {
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

  test("exercises UDP/TCP, TTL, private NXDOMAIN, forwarding, expiry, and recovery", async () => {
    if (process.env.BARBACK_APPLE_CONTAINER_TESTS !== "true") {
      console.log("Skipping Apple Container tests (set BARBACK_APPLE_CONTAINER_TESTS=true)");
      return;
    }
    if (!hasContainer) {
      console.log("Skipping Apple Container tests because runtime is unavailable");
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "barback-test-resolver-"));
    let resolverAddress = "";

    try {
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("container", ["network", "create", "barback-test-net"]);
      } catch {}
      await adapter.run({
        name: "barback-test-gateway",
        image: "alpine:latest",
        network: "barback-test-net",
        command: ["sleep", "3600"],
        labels: {
          "io.shiborgi.barback.stack": "barback-test",
          "io.shiborgi.barback.service": "barback",
          "io.shiborgi.barback.role": "gateway",
        },
      });
      await adapter.run({
        name: "barback-test-valkey",
        image: "alpine:latest",
        network: "barback-test-net",
        command: ["sleep", "3600"],
        labels: {
          "io.shiborgi.barback.stack": "barback-test",
          "io.shiborgi.barback.service": "valkey",
          "io.shiborgi.barback.role": "storage",
        },
      });
      const stack = parseStack({
        version: 1,
        stackId: "barback-test",
        network: "barback-test-net",
        dns: {
          zone: "barback.internal",
          container: "barback-test-dns",
          image: "barback-dns:build-sha256-1234567890abcdef",
          buildContext: "dns",
          ttl: "5s",
          lease: "10s",
        },
        services: {
          barback: {
            role: "gateway",
            container: "barback-test-gateway",
            dns: "barback.internal",
            port: 8080,
            required: true,
            runtime: {
              mode: "adopted",
              labels: {
                "io.shiborgi.barback.stack": "barback-test",
                "io.shiborgi.barback.service": "barback",
                "io.shiborgi.barback.role": "gateway",
              },
            },
            health: { type: "exec", command: ["true"] },
          },
          valkey: {
            role: "storage",
            container: "barback-test-valkey",
            dns: "valkey.barback.internal",
            port: 6379,
            required: true,
            runtime: {
              mode: "adopted",
              labels: {
                "io.shiborgi.barback.stack": "barback-test",
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

      const inspect = await adapter.inspect("barback-test-dns");
      resolverAddress = inspect?.addresses[0] ?? "";
      expect(resolverAddress).toBeTruthy();

      // Test UDP resolution
      const resolveUdp = (name: string) =>
        new Promise((resolve, _reject) => {
          const { spawn } = require("node:child_process");
          const proc = spawn("dig", [
            "+short",
            "+timeout=2",
            "+tries=1",
            `@${resolverAddress}`,
            name,
          ]);
          let out = "";
          proc.stdout.on("data", (d: any) => (out += d));
          proc.on("close", () => resolve(out.trim()));
        });

      // Test TCP resolution
      const resolveTcp = (name: string) =>
        new Promise((resolve, _reject) => {
          const { spawn } = require("node:child_process");
          const proc = spawn("dig", [
            "+short",
            "+tcp",
            "+timeout=2",
            "+tries=1",
            `@${resolverAddress}`,
            name,
          ]);
          let out = "";
          proc.stdout.on("data", (d: any) => (out += d));
          proc.on("close", () => resolve(out.trim()));
        });

      expect(await resolveUdp("dns.barback.internal")).toBe(resolverAddress);
      expect(await resolveTcp("dns.barback.internal")).toBe(resolverAddress);

      // Test forwarding (public domain)
      const publicRes = await resolveUdp("example.com");
      expect(publicRes).toBeTruthy();

      // Test private NXDOMAIN (fast fail)
      const privRes = await resolveUdp("unknown.barback.internal");
      expect(privRes).toBe("");

      // Wait for expiry
      await new Promise((r) => setTimeout(r, 4000));
      const expiredRes = await resolveUdp("dns.barback.internal");
      // The supervisor stops returning records when lease expires
      expect(expiredRes).toBe("");

      // Recover
      await reconciler.reconcile();
      const recoveredRes = await resolveUdp("dns.barback.internal");
      expect(recoveredRes).toBe(resolverAddress);
    } finally {
      await adapter.remove("barback-test-gateway").catch(() => {});
      await adapter.remove("barback-test-valkey").catch(() => {});
      await adapter.remove("barback-test-dns").catch(() => {});
      const { execFileSync } = require("node:child_process");
      try {
        execFileSync("container", ["network", "delete", "barback-test-net"]);
      } catch {}
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
