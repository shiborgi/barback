import { ConfigError } from "../config/loader.ts";

export interface ContainerSnapshot {
  id: string;
  running: boolean;
  network: string;
  addresses: string[];
  hostAddress: string;
  labels: Record<string, string>;
  publishedPorts: Array<{ hostIp: string; hostPort: number; containerPort: number }>;
}

export interface AppleContainerAdapter {
  ensureSystem(): Promise<void>;
  ensureNetwork(name: string, mode: "nat"): Promise<void>;
  inspectNetwork(name: string): Promise<{ subnet: string } | null>;
  inspect(name: string): Promise<ContainerSnapshot | null>;
  build(image: string, context: string): Promise<void>;
  run(input: {
    name: string;
    image: string;
    network: string;
    labels: Record<string, string>;
    command?: string[];
    mounts?: Array<{ source: string; target: string; readOnly: boolean }>;
    envFile?: string;
    env?: Record<string, string>;
    dns?: string[];
    dnsSearch?: string[];
    publishedPorts?: Array<{ hostIp: string; hostPort: number; containerPort: number }>;
  }): Promise<void>;
  probeHttp(address: string, port: number, path: string): Promise<void>;
  resolveFrom(container: string, hostname: string, expectedAddress: string): Promise<void>;
  probeFrom(container: string, hostname: string, port: number, path?: string): Promise<void>;
  exec(name: string, command: string[]): Promise<void>;
  remove(name: string): Promise<void>;
}

export class AppleContainerCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly output: string,
  ) {
    super(`container ${args[0]} failed: ${output}`);
  }
}

export type AppleContainerCommand = (args: string[]) => Promise<string>;

async function command(args: string[]): Promise<string> {
  const process = Bun.spawn(["container", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new AppleContainerCommandError(args, stderr.trim() || stdout.trim());
  return stdout;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

export class AppleContainerCli implements AppleContainerAdapter {
  constructor(private readonly execute: AppleContainerCommand = command) {}

  async ensureSystem(): Promise<void> {
    try {
      await this.execute(["system", "status"]);
    } catch {
      await this.execute(["system", "start"]);
    }
  }

  async ensureNetwork(name: string, mode: "nat"): Promise<void> {
    try {
      const inspected = JSON.parse(await this.execute(["network", "inspect", name])) as Array<{
        configuration?: { mode?: string };
      }>;
      if (inspected[0]?.configuration?.mode !== mode)
        throw new ConfigError(`Network ${name} must use ${mode} mode`);
    } catch (error) {
      if (
        !(error instanceof AppleContainerCommandError) ||
        !/(not found|does not exist|no such)/i.test(error.output)
      )
        throw error;
      await this.execute(["network", "create", name]);
    }
  }

  async inspectNetwork(name: string): Promise<{ subnet: string } | null> {
    try {
      const inspected = JSON.parse(await this.execute(["network", "inspect", name])) as Array<{
        status?: { ipv4Subnet?: string };
        configuration?: { subnet?: string };
      }>;
      const subnet = inspected[0]?.status?.ipv4Subnet ?? inspected[0]?.configuration?.subnet;
      return subnet ? { subnet } : null;
    } catch {
      return null;
    }
  }

  async inspect(name: string): Promise<ContainerSnapshot | null> {
    try {
      const inspected = JSON.parse(await this.execute(["inspect", name])) as Array<
        Record<string, unknown>
      >;
      const item = inspected[0];
      if (!item) return null;
      const status = item.status as
        | { networks?: Array<{ ipv4Address?: string; hostAddress?: string }>; state?: string }
        | undefined;
      const configuration = item.configuration as
        | {
            networks?: Array<{ network?: string }>;
            labels?: Record<string, string>;
            publishedPorts?: Array<{
              hostIp?: string;
              hostPort?: unknown;
              containerPort?: unknown;
            }>;
          }
        | undefined;
      return {
        id: typeof item.id === "string" ? item.id : name,
        running: status?.state === "running" || status?.state === undefined,
        network: configuration?.networks?.[0]?.network ?? "",
        addresses: (status?.networks ?? [])
          .map((entry) => entry.ipv4Address?.split("/")[0])
          .filter((value): value is string => Boolean(value)),
        hostAddress:
          (status?.networks ?? []).find((entry) => Boolean(entry.hostAddress))?.hostAddress ?? "",
        labels: configuration?.labels ?? {},
        publishedPorts: (configuration?.publishedPorts ?? []).flatMap((port) => {
          const hostPort = number(port.hostPort);
          const containerPort = number(port.containerPort);
          return hostPort !== undefined && containerPort !== undefined
            ? [{ hostIp: port.hostIp ?? "", hostPort, containerPort }]
            : [];
        }),
      };
    } catch {
      return null;
    }
  }

  async build(image: string, context: string): Promise<void> {
    await this.execute(["build", "--tag", image, context]);
  }

  async run(input: Parameters<AppleContainerAdapter["run"]>[0]): Promise<void> {
    const args = ["run", "--detach", "--name", input.name, "--network", input.network];
    for (const [key, value] of Object.entries(input.labels))
      args.push("--label", `${key}=${value}`);
    for (const mount of input.mounts ?? [])
      args.push("--volume", `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`);
    for (const [key, value] of Object.entries(input.env ?? {}))
      args.push("--env", `${key}=${value}`);
    if (input.envFile) args.push("--env-file", input.envFile);
    for (const dns of input.dns ?? []) args.push("--dns", dns);
    for (const search of input.dnsSearch ?? []) args.push("--dns-search", search);
    for (const port of input.publishedPorts ?? [])
      args.push("--publish", `${port.hostIp}:${port.hostPort}:${port.containerPort}`);
    args.push(input.image, ...(input.command ?? []));
    await this.execute(args);
  }

  async probeHttp(address: string, port: number, path: string): Promise<void> {
    const hostname = address.includes(":") ? `[${address}]` : address;
    const response = await fetch(`http://${hostname}:${port}${path}`);
    if (!response.ok) throw new ConfigError(`HTTP health probe failed: ${response.status}`);
  }

  async resolveFrom(container: string, hostname: string, expectedAddress: string): Promise<void> {
    const script = `import { lookup } from "node:dns/promises"; const answer = await lookup(${JSON.stringify(hostname)}); if (answer.address !== ${JSON.stringify(expectedAddress)}) throw new Error(answer.address);`;
    await this.exec(container, ["bun", "-e", script]);
  }

  async probeFrom(container: string, hostname: string, port: number, path?: string): Promise<void> {
    const script = path
      ? `const response = await fetch(${JSON.stringify(`http://${hostname}:${port}${path}`)}); if (!response.ok) throw new Error(String(response.status));`
      : `const socket = await Bun.connect({ hostname: ${JSON.stringify(hostname)}, port: ${port}}, socket: { open(socket) { socket.end(); } } }); socket.end();`;
    await this.exec(container, ["bun", "-e", script]);
  }

  async exec(name: string, command: string[]): Promise<void> {
    await this.execute(["exec", name, ...command]);
  }

  async remove(name: string): Promise<void> {
    const existing = await this.inspect(name);
    if (!existing) return;
    if (existing.running) await this.execute(["stop", name]);
    await this.execute(["delete", name]);
  }
}
