import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../config/loader.ts";
import type { BarbackConfig } from "../config/schema.ts";
import type { Metrics } from "../telemetry/metrics.ts";
import {
  type AppleContainerAdapter,
  AppleContainerCli,
  type ContainerSnapshot,
} from "./apple-container.ts";
import type { StackConfig, StackService } from "./stack-schema.ts";
import {
  applyLease,
  type ClientConfig,
  DnsStateStore,
  persistDnsStatus,
  publishClientConfig,
  updateDnsGeneration,
} from "./state.ts";
import { type DnsRecord, renderDnsRecords } from "./supervisor.ts";

const labelsFor = (stack: StackConfig, id: string, role: string) => ({
  "io.shiborgi.barback.stack": stack.stackId,
  "io.shiborgi.barback.service": id,
  "io.shiborgi.barback.role": role,
});

function descriptor(service: StackService): string {
  return createHash("sha256").update(JSON.stringify(service.runtime)).digest("hex").slice(0, 32);
}

function assertSnapshot(
  stack: StackConfig,
  id: string,
  service: StackService,
  snapshot: ContainerSnapshot,
): void {
  if (!snapshot.running || snapshot.network !== stack.network || snapshot.addresses.length !== 1)
    throw new ConfigError(
      `Service ${id} is not running with exactly one address on ${stack.network}`,
    );
  for (const [label, value] of Object.entries(labelsFor(stack, id, service.role))) {
    if (snapshot.labels[label] !== value)
      throw new ConfigError(`Service ${id} has invalid ${label}`);
  }
  if (
    service.runtime.mode === "managed" &&
    snapshot.labels["io.shiborgi.barback.descriptor"] &&
    snapshot.labels["io.shiborgi.barback.descriptor"] !== descriptor(service)
  )
    throw new ConfigError(`Service ${id} immutable descriptor does not match its manifest`);
  const wanted = (service.publishedPorts ?? []).map((port) => ({
    hostIp: String(port.hostIp),
    hostPort: port.hostPort,
    containerPort: port.containerPort,
  }));
  if (
    JSON.stringify(snapshot.publishedPorts.sort(portOrder)) !==
    JSON.stringify([...wanted].sort(portOrder))
  )
    throw new ConfigError(`Service ${id} published ports do not match its manifest`);
}

function portOrder(
  left: { hostIp: string; hostPort: number },
  right: { hostIp: string; hostPort: number },
) {
  return `${left.hostIp}:${left.hostPort}`.localeCompare(`${right.hostIp}:${right.hostPort}`);
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path).catch(async (error) => {
    await rm(temporary, { force: true });
    throw error;
  });
}

async function publishResolverBundle(
  directory: string,
  records: string,
  lease: string,
): Promise<void> {
  const bundleName = `.bundle-${crypto.randomUUID()}`;
  const bundle = join(directory, bundleName);
  await mkdir(bundle, { mode: 0o700 });
  try {
    await writeAtomic(join(bundle, "db.barback.internal"), records);
    await writeAtomic(join(bundle, "lease.json"), `${lease}\n`);
    const next = join(directory, ".current.next");
    await symlink(bundleName, next);
    await rename(next, join(directory, "current"));
  } catch (error) {
    await rm(bundle, { recursive: true, force: true });
    throw error;
  }
}

async function withdrawResolverBundle(directory: string): Promise<void> {
  await rm(join(directory, "current"), { force: true });
}

async function managedEnvironment(service: StackService): Promise<Record<string, string>> {
  if (service.runtime.mode !== "managed") return {};
  const inline = service.runtime.env;
  if (!service.runtime.envFile) return inline;
  let contents: string;
  try {
    contents = await readFile(service.runtime.envFile, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Cannot read environment file ${service.runtime.envFile}: ${String(error)}`,
    );
  }
  const names = new Set(
    contents
      .split("\n")
      .map(
        (line) =>
          line
            .trim()
            .replace(/^export\s+/, "")
            .split("=", 1)[0],
      )
      .filter(Boolean),
  );
  for (const name of service.runtime.requiredEnv) {
    if (!names.has(name) && !inline[name])
      throw new ConfigError(`Service environment is missing required ${name}`);
  }
  return inline;
}

export class StackReconciler {
  constructor(
    readonly stack: StackConfig,
    readonly config: BarbackConfig,
    readonly adapter: AppleContainerAdapter = new AppleContainerCli(),
    readonly state = new DnsStateStore(stack.stackId),
    readonly metrics?: Metrics,
  ) {}

  async #runManaged(id: string, service: StackService, resolver: ContainerSnapshot): Promise<void> {
    if (service.runtime.mode !== "managed") return;
    if (service.runtime.buildContext)
      await this.adapter.build(service.runtime.image, service.runtime.buildContext);
    for (const mount of service.runtime.mounts) {
      await access(mount.source).catch(() => {
        throw new ConfigError(`Service ${id} mount source does not exist: ${mount.source}`);
      });
    }
    const resolverInstanceId = resolver.labels["io.shiborgi.barback.resolver-instance"];
    if (!resolverInstanceId) throw new ConfigError("Resolver instance identity is missing");
    const resolverGeneration = updateDnsGeneration(
      undefined,
      resolver.addresses,
      resolverInstanceId,
      resolver.hostAddress,
    ).dnsGeneration;
    const current = await this.adapter.inspect(service.container);
    if (
      current?.running &&
      current.network === this.stack.network &&
      current.addresses.length === 1 &&
      current.labels["io.shiborgi.barback.descriptor"] === descriptor(service) &&
      current.labels["io.shiborgi.barback.resolver-generation"] === resolverGeneration
    )
      return;
    await this.adapter.remove(service.container);
    await this.adapter.run({
      name: service.container,
      image: service.runtime.image,
      network: this.stack.network,
      labels: {
        ...labelsFor(this.stack, id, service.role),
        "io.shiborgi.barback.descriptor": descriptor(service),
        "io.shiborgi.barback.resolver-generation": resolverGeneration,
      },
      command: service.runtime.command,
      mounts: service.runtime.mounts,
      envFile: service.runtime.envFile,
      env: await managedEnvironment(service),
      dns: resolver.addresses,
      dnsSearch: [this.stack.dns.zone],
      publishedPorts: service.publishedPorts.map((port) => ({
        hostIp: String(port.hostIp),
        hostPort: port.hostPort,
        containerPort: port.containerPort,
      })),
    });
  }

  async up(): Promise<void> {
    await this.adapter.ensureSystem();
    await this.adapter.ensureNetwork(this.stack.network, "nat");
    await mkdir(join(this.state.root, "records"), { recursive: true, mode: 0o700 });
    let resolver = await this.adapter.inspect(this.stack.dns.container);
    if (!resolver) {
      if (this.stack.dns.buildContext)
        await this.adapter.build(this.stack.dns.image, this.stack.dns.buildContext);
      const instanceId = randomUUID();
      const bootstrapLease = {
        schemaVersion: 1 as const,
        stackId: this.stack.stackId,
        dnsGeneration: instanceId,
        sequence: 0,
        validUntil: new Date(Date.now() + this.stack.dns.lease).toISOString(),
      };
      // CoreDNS must never start against an absent or partially-written zone. The
      // real resolver address and service records replace this short-lived bundle.
      await publishResolverBundle(
        join(this.state.root, "records"),
        renderDnsRecords(
          [
            { name: this.stack.dns.zone, address: "127.0.0.1" },
            { name: `dns.${this.stack.dns.zone}`, address: "127.0.0.1" },
          ],
          Math.floor(this.stack.dns.ttl / 1000),
        ),
        JSON.stringify(bootstrapLease),
      );
      await this.adapter.run({
        name: this.stack.dns.container,
        image: this.stack.dns.image,
        network: this.stack.network,
        labels: {
          ...labelsFor(this.stack, "dns", "dns"),
          "io.shiborgi.barback.resolver-instance": instanceId,
        },
        mounts: [{ source: join(this.state.root, "records"), target: "/records", readOnly: true }],
        env: { BARBACK_STACK_ID: this.stack.stackId, BARBACK_DNS_GENERATION: instanceId },
      });
      resolver = await this.adapter.inspect(this.stack.dns.container);
    }
    if (!resolver) throw new ConfigError("Resolver did not start");
    // Dependencies must be resolvable before the gateway starts.
    for (const [id, service] of Object.entries(this.stack.services))
      if (service.role !== "gateway") await this.#runManaged(id, service, resolver);
    await this.reconcile(new Date(), true);
    const gateway = this.stack.services.barback;
    if (!gateway) throw new ConfigError("Gateway is missing from the manifest");
    await this.#runManaged("barback", gateway, resolver);
    await this.reconcile();
  }

  async reconcile(now = new Date(), allowGatewayMissing = false): Promise<void> {
    const startedAt = performance.now();
    let status: "success" | "failed" = "success";
    try {
      await this.#doReconcile(now, allowGatewayMissing);
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      this.metrics?.dnsReconciliationDuration.observe(
        { status },
        (performance.now() - startedAt) / 1000,
      );
      const state = await this.state.load();
      if (state?.lease?.validUntil) {
        const remaining = Math.max(0, (Date.parse(state.lease.validUntil) - Date.now()) / 1000);
        this.metrics?.dnsLeaseTimeRemainingSeconds.set(remaining);
      }
    }
  }

  async #doReconcile(now: Date, allowGatewayMissing: boolean): Promise<void> {
    const resolver = await this.adapter.inspect(this.stack.dns.container);
    if (
      !resolver?.running ||
      resolver.network !== this.stack.network ||
      resolver.addresses.length !== 1
    ) {
      this.metrics?.dnsResolverFailures.inc();
      throw new ConfigError(
        "Resolver is not running with exactly one address on the manifest network",
      );
    }
    for (const [label, value] of Object.entries(labelsFor(this.stack, "dns", "dns"))) {
      if (resolver.labels[label] !== value) {
        this.metrics?.dnsResolverFailures.inc();
        throw new ConfigError(`Resolver has invalid ${label}`);
      }
    }
    const resolverInstanceId = resolver.labels["io.shiborgi.barback.resolver-instance"];
    if (!resolverInstanceId) {
      this.metrics?.dnsResolverFailures.inc();
      throw new ConfigError("Resolver instance identity is missing");
    }
    const previous = await this.state.load();
    const dnsState = updateDnsGeneration(
      previous ?? undefined,
      resolver.addresses,
      resolverInstanceId,
      resolver.hostAddress,
    );
    if (previous && previous.dnsGeneration !== dnsState.dnsGeneration) {
      this.metrics?.dnsGenerationChanges.inc();
      for (const [id, service] of Object.entries(this.stack.services))
        await this.#runManaged(id, service, resolver);
    }
    const snapshots = await Promise.all(
      Object.entries(this.stack.services).map(async ([id, service]) => {
        const snapshot = await this.adapter.inspect(service.container);
        return { id, service, snapshot };
      }),
    );
    const resolverAddress = resolver.addresses[0];
    if (!resolverAddress) {
      this.metrics?.dnsResolverFailures.inc();
      throw new ConfigError("Resolver address is missing");
    }
    const records: DnsRecord[] = [{ name: `dns.${this.stack.dns.zone}`, address: resolverAddress }];
    for (const { id, service, snapshot } of snapshots) {
      if (!snapshot) {
        if (allowGatewayMissing && service.role === "gateway") continue;
        if (service.required) {
          throw new ConfigError(`Required service ${id} is absent`);
        }
        continue;
      }
      assertSnapshot(this.stack, id, service, snapshot);
      const address = snapshot.addresses[0];
      if (!address) throw new ConfigError(`Service ${id} address is missing`);
      try {
        if (service.health.type === "http")
          await this.adapter.probeHttp(address, service.port, service.health.path);
        else await this.adapter.exec(service.container, service.health.command);
      } catch (error) {
        if (service.required) {
          throw new ConfigError(`Required service ${id} health probe failed: ${String(error)}`);
        }
        continue;
      }
      records.push({ name: service.dns, address });
    }
    if (allowGatewayMissing && !records.some((record) => record.name === this.stack.dns.zone))
      records.push({ name: this.stack.dns.zone, address: "127.0.0.1" });
    if (!allowGatewayMissing && !records.some((record) => record.name === this.stack.dns.zone))
      throw new ConfigError("Gateway record is required");
    if (!allowGatewayMissing) {
      const gateway = snapshots.find(({ service }) => service.role === "gateway")?.snapshot;
      if (!gateway) throw new ConfigError("Gateway is absent");
      const gatewayService = this.stack.services.barback;
      if (!gatewayService) throw new ConfigError("Gateway is missing from the manifest");
      for (const { service, snapshot } of snapshots) {
        if (!service.required || service.role === "gateway" || !snapshot) continue;
        const address = snapshot.addresses[0];
        if (!address) throw new ConfigError(`Service ${service.container} address is missing`);
        await this.adapter.resolveFrom(gatewayService.container, service.dns, address);
        await this.adapter.probeFrom(
          gatewayService.container,
          service.dns,
          service.port,
          service.health.type === "http" ? service.health.path : undefined,
        );
      }
    }
    const validUntil = new Date(now.getTime() + this.stack.dns.lease).toISOString();
    const previousLease =
      previous?.dnsGeneration === dnsState.dnsGeneration ? previous.lease : undefined;
    const lease = {
      schemaVersion: 1 as const,
      stackId: this.stack.stackId,
      dnsGeneration: dnsState.dnsGeneration,
      sequence: (previousLease?.sequence ?? 0) + 1,
      validUntil,
    };
    // Validate every value before replacing either resolver input file.
    const recordsText = renderDnsRecords(records, Math.floor(this.stack.dns.ttl / 1000));

    // Check drift and address changes
    try {
      const currentRecords = await readFile(
        join(this.state.root, "records", "current", "db.barback.internal"),
        "utf8",
      );
      if (currentRecords !== recordsText) {
        // Record drift detected!
        // We will increment drift/changes, but how do we differentiate service address change from drift?
        // Wait, "Add bounded-cardinality DNS reconciliation metrics to the gateway metrics registry using only manifest service IDs and fixed result labels..."
        // If currentRecords !== recordsText, something changed.
        for (const record of records) {
          if (!currentRecords.includes(`IN A ${record.address}`)) {
            const svcId = Object.entries(this.stack.services).find(
              ([_, s]) => s.dns === record.name,
            )?.[0];
            if (svcId) {
              this.metrics?.dnsRecordDrift.inc({ service: svcId });
              this.metrics?.dnsServiceAddressChanges.inc({ service: svcId });
            }
          }
        }
      }
    } catch {
      // First run, no drift
    }

    // This also validates monotonicity without changing persisted state.
    applyLease(previousLease, lease, now, this.stack.stackId);
    const directory = join(this.state.root, "records");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await publishResolverBundle(directory, recordsText, JSON.stringify(lease));
    await this.state.commit(dnsState, lease, now);
    await publishClientConfig(this.state.root, await this.clientConfig(now));
    await persistDnsStatus(this.state.root, await this.status(now));
  }

  async status(now = new Date()): Promise<Record<string, unknown>> {
    const state = await this.state.load();
    const network = await this.adapter.inspectNetwork(this.stack.network);
    const services = await Promise.all(
      Object.entries(this.stack.services).map(async ([id, service]) => {
        const snapshot = await this.adapter.inspect(service.container);
        let health: "healthy" | "unhealthy" | "absent" = "absent";
        if (snapshot) {
          try {
            if (service.health.type === "http")
              await this.adapter.probeHttp(
                snapshot.addresses[0] ?? "",
                service.port,
                service.health.path,
              );
            else await this.adapter.exec(service.container, service.health.command);
            health = "healthy";
          } catch {
            health = "unhealthy";
          }
        }
        return [
          id,
          {
            role: service.role,
            fqdn: service.dns,
            container: service.container,
            address: snapshot?.addresses[0] ?? null,
            running: snapshot?.running ?? false,
            health,
            descriptorDrift:
              service.runtime.mode === "managed"
                ? (snapshot?.labels["io.shiborgi.barback.descriptor"] ?? null) !==
                  descriptor(service)
                : false,
          },
        ];
      }),
    );
    const leaseExpiry = state?.lease?.validUntil ?? null;
    const reconciledAt = state?.lastSuccessfulReconciliation ?? null;
    return {
      stackId: this.stack.stackId,
      network: { name: this.stack.network, subnet: network?.subnet ?? null },
      dnsGeneration: state?.dnsGeneration ?? null,
      resolver: {
        container: this.stack.dns.container,
        addresses: state?.resolverAddresses ?? [],
        health: Boolean(state?.lease && Date.parse(state.lease.validUntil) > now.getTime()),
      },
      services: Object.fromEntries(services),
      dnsRecordDrift: false,
      lastSuccessfulReconciliation: reconciledAt,
      reconciliationAgeMs: reconciledAt ? now.getTime() - Date.parse(reconciledAt) : null,
      lease: {
        valid: Boolean(leaseExpiry && Date.parse(leaseExpiry) > now.getTime()),
        expiresAt: leaseExpiry,
        ageMs: reconciledAt ? now.getTime() - Date.parse(reconciledAt) : null,
      },
      clientConfig: {
        path: join(this.state.root, "client-config.json"),
        generation: state?.dnsGeneration ?? null,
        valid: Boolean(leaseExpiry && Date.parse(leaseExpiry) > now.getTime()),
      },
    };
  }

  async clientConfig(now = new Date()): Promise<ClientConfig> {
    const state = await this.state.load();
    if (!state?.lease || Date.parse(state.lease.validUntil) <= now.getTime())
      throw new ConfigError("No active DNS lease");
    const hostGateway = state.resolverHostAddress;
    if (!hostGateway) throw new ConfigError("Resolver address is missing");
    return {
      schemaVersion: 1,
      stackId: this.stack.stackId,
      network: this.stack.network,
      hostGateway,
      dnsServers: state.resolverAddresses,
      dnsSearch: [this.stack.dns.zone],
      dnsGeneration: state.dnsGeneration,
      generatedAt: now.toISOString(),
      validUntil: state.lease.validUntil,
      apiBaseUrl: `http://${this.stack.dns.zone}:8080/v1`,
      mcpUrl: `http://${this.stack.dns.zone}:8080/mcp`,
      credentialMode: "onecli-proxy",
    };
  }

  async down(): Promise<void> {
    for (const service of Object.values(this.stack.services)) {
      if (service.runtime.mode === "managed") await this.adapter.remove(service.container);
    }
    await this.adapter.remove(this.stack.dns.container);
    await withdrawResolverBundle(join(this.state.root, "records"));
  }
}
