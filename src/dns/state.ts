import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";
import { z } from "zod";
import { ConfigError } from "../config/loader.ts";

const serviceIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const containerNamePattern = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;
const zonePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const timestamp = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    const date = new Date(value);
    const canonical = date.toISOString();
    return (
      Number.isFinite(date.getTime()) &&
      canonical === (value.includes(".") ? value : value.replace("Z", ".000Z"))
    );
  },
  {
    message: "must be an ISO-8601 timestamp",
  },
);

const ipAddress = z.string().refine((value) => isIP(value) !== 0, {
  message: "must be an IP address",
});

function isIpLiteralUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.replace(/^\[|\]$/g, "");
    return isIP(hostname) !== 0;
  } catch {
    return false;
  }
}

const applicationUrl = z.url().superRefine((value, ctx) => {
  const url = new URL(value);
  if (isIpLiteralUrl(value)) {
    ctx.addIssue({ code: "custom", message: "application URL must not contain an IP literal" });
  }
  if (url.hostname !== "barback.internal") {
    ctx.addIssue({ code: "custom", message: "application URL must use barback.internal" });
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: "custom", message: "application URL must not contain credentials" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "application URL must use HTTP or HTTPS" });
  }
  if (url.search || url.hash) {
    ctx.addIssue({
      code: "custom",
      message: "application URL must not contain a query or fragment",
    });
  }
});

export const leaseSchema = strictObject({
  schemaVersion: z.literal(1),
  stackId: z.string().regex(serviceIdPattern),
  dnsGeneration: z.string().min(1),
  sequence: z.int().nonnegative(),
  validUntil: timestamp,
});

export type DnsLease = z.infer<typeof leaseSchema>;

export interface DnsGenerationState {
  dnsGeneration: string;
  resolverAddresses: string[];
  resolverInstanceId: string;
}

const persistedStateSchema = strictObject({
  schemaVersion: z.literal(1),
  stackId: z.string().regex(serviceIdPattern),
  dnsGeneration: z.string().min(1),
  resolverAddresses: z.array(ipAddress).min(1),
  resolverInstanceId: z.string().min(1),
  lease: leaseSchema.optional(),
}).superRefine((state, ctx) => {
  if (new Set(state.resolverAddresses).size !== state.resolverAddresses.length) {
    ctx.addIssue({
      code: "custom",
      path: ["resolverAddresses"],
      message: "Resolver addresses must be unique",
    });
  }
  if (state.lease && state.lease.stackId !== state.stackId) {
    ctx.addIssue({
      code: "custom",
      path: ["lease", "stackId"],
      message: "Lease belongs to a different stack",
    });
  }
  if (state.lease && state.lease.dnsGeneration !== state.dnsGeneration) {
    ctx.addIssue({
      code: "custom",
      path: ["lease", "dnsGeneration"],
      message: "Lease generation does not match DNS state",
    });
  }
});

export type DnsState = z.infer<typeof persistedStateSchema>;

export const clientConfigSchema = strictObject({
  schemaVersion: z.literal(1),
  stackId: z.string().regex(serviceIdPattern),
  network: z.string().regex(containerNamePattern),
  hostGateway: ipAddress,
  dnsServers: z.array(ipAddress).min(1),
  dnsSearch: z.array(z.string().regex(zonePattern)).min(1),
  dnsGeneration: z.string().min(1),
  generatedAt: timestamp,
  validUntil: timestamp,
  apiBaseUrl: applicationUrl,
  mcpUrl: applicationUrl,
  credentialMode: z.literal("onecli-proxy"),
}).superRefine((config, ctx) => {
  if (!config.dnsSearch.includes("barback.internal")) {
    ctx.addIssue({ code: "custom", path: ["dnsSearch"], message: "must include barback.internal" });
  }
  if (new Set(config.dnsServers).size !== config.dnsServers.length) {
    ctx.addIssue({ code: "custom", path: ["dnsServers"], message: "DNS servers must be unique" });
  }
  const api = new URL(config.apiBaseUrl);
  const mcp = new URL(config.mcpUrl);
  if (api.pathname !== "/v1" || api.port !== "8080") {
    ctx.addIssue({
      code: "custom",
      path: ["apiBaseUrl"],
      message: "must be http://barback.internal:8080/v1",
    });
  }
  if (mcp.pathname !== "/mcp" || mcp.port !== "8080") {
    ctx.addIssue({
      code: "custom",
      path: ["mcpUrl"],
      message: "must be http://barback.internal:8080/mcp",
    });
  }
  if (Date.parse(config.validUntil) <= Date.parse(config.generatedAt)) {
    ctx.addIssue({
      code: "custom",
      path: ["validUntil"],
      message: "must be later than generatedAt",
    });
  }
});

export type ClientConfig = z.infer<typeof clientConfigSchema>;

function generation(addresses: string[], runtimeInstanceId: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ addresses, runtimeInstanceId }))
    .digest("hex");
}

export function updateDnsGeneration(
  previous: DnsGenerationState | undefined,
  resolverAddresses: string[],
  resolverInstanceId: string,
): DnsGenerationState {
  if (!resolverInstanceId) throw new ConfigError("Resolver instance identity is required");
  const addresses = [...new Set(resolverAddresses)].sort();
  if (addresses.length === 0 || addresses.some((address) => isIP(address) === 0)) {
    throw new ConfigError("Resolver address set must contain at least one IP address");
  }
  if (
    previous &&
    previous.resolverInstanceId === resolverInstanceId &&
    [...new Set(previous.resolverAddresses)].sort().length === addresses.length &&
    [...new Set(previous.resolverAddresses)]
      .sort()
      .every((address, index) => address === addresses[index])
  ) {
    return previous;
  }
  return {
    resolverAddresses: addresses,
    resolverInstanceId,
    dnsGeneration: generation(addresses, resolverInstanceId),
  };
}

function parseLease(value: unknown): DnsLease {
  try {
    return leaseSchema.parse(value);
  } catch (error) {
    if (error && typeof error === "object" && "issues" in error) {
      const issues = (error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
      throw new ConfigError(
        issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    throw new ConfigError(
      `Invalid DNS lease: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function applyLease(
  previous: DnsLease | undefined,
  replacement: unknown,
  now = new Date(),
  expectedStackId?: string,
): DnsLease {
  const next = parseLease(replacement);
  if (!Number.isFinite(now.getTime())) throw new ConfigError("Invalid lease comparison time");
  if (expectedStackId && next.stackId !== expectedStackId) {
    throw new ConfigError("Lease belongs to a different stack");
  }
  if (Date.parse(next.validUntil) <= now.getTime()) throw new ConfigError("Lease is expired");

  if (!previous) return next;
  if (previous.stackId !== next.stackId)
    throw new ConfigError("Lease belongs to a different stack");
  if (next.sequence < previous.sequence) throw new ConfigError("Lease sequence must not decrease");
  if (next.sequence === previous.sequence) return previous;
  return next;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function existingPath(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
}

async function rejectSymlinkPath(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parsePath(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await existingPath(current);
    // macOS exposes temporary directories through /var and /tmp symlinks.
    if (stat?.isSymbolicLink() && current !== "/var" && current !== "/tmp") {
      throw new ConfigError(`symlink path is not allowed: ${current}`);
    }
    if (!stat) return;
  }
}

function requireAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new ConfigError("BARBACK_STATE_DIR must be an absolute path");
  return resolve(path);
}

async function ensureOwned(path: string, stat: Awaited<ReturnType<typeof lstat>>): Promise<void> {
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid)
    throw new ConfigError(`Path is not owned by the current user: ${path}`);
}

async function ensureStateDirectory(root: string): Promise<string> {
  const absolute = requireAbsolute(root);
  await rejectSymlinkPath(absolute);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await rejectSymlinkPath(absolute);
  const stat = await lstat(absolute);
  if (!stat.isDirectory()) throw new ConfigError(`State path is not a directory: ${absolute}`);
  await ensureOwned(absolute, stat);
  await chmod(absolute, 0o700);
  return absolute;
}

async function atomicWriteJson(root: string, filename: string, value: unknown): Promise<string> {
  const directory = await ensureStateDirectory(root);
  const target = join(directory, filename);
  await rejectSymlinkPath(target);
  const current = await existingPath(target);
  if (current?.isSymbolicLink()) throw new ConfigError(`Symlink path is not allowed: ${target}`);
  if (current) await ensureOwned(target, current);

  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await file.close();
  }
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const replaced = await lstat(target);
  await ensureOwned(target, replaced);
  await chmod(target, 0o600);
  try {
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Directory fsync is not available on every supported filesystem.
  }
  return target;
}

export function defaultStateRoot(env: Record<string, string | undefined> = process.env): string {
  return env.BARBACK_STATE_DIR || join(homedir(), ".local", "state", "barback");
}

export async function loadDnsState(root = defaultStateRoot()): Promise<DnsState | null> {
  const directory = requireAbsolute(root);
  await rejectSymlinkPath(directory);
  const directoryStat = await existingPath(directory);
  if (!directoryStat) return null;
  if (!directoryStat.isDirectory())
    throw new ConfigError(`State path is not a directory: ${directory}`);
  await ensureOwned(directory, directoryStat);
  const path = join(directory, "state.json");
  await rejectSymlinkPath(path);
  const stat = await existingPath(path);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new ConfigError(`symlink path is not allowed: ${path}`);
  await ensureOwned(path, stat);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Invalid DNS state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return persistedStateSchema.parse(value);
  } catch (error) {
    throw new ConfigError(
      `Invalid DNS state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function persistDnsState(root: string, state: DnsState): Promise<string> {
  const parsed = persistedStateSchema.parse(state);
  return atomicWriteJson(root, "state.json", parsed);
}

export function validateClientConfig(value: unknown, now = new Date()): ClientConfig {
  const config = clientConfigSchema.parse(value);
  if (!Number.isFinite(now.getTime()))
    throw new ConfigError("Invalid client-config comparison time");
  if (Date.parse(config.validUntil) <= now.getTime())
    throw new ConfigError("Client configuration is expired");
  return config;
}

export async function publishClientConfig(root: string, config: ClientConfig): Promise<string> {
  const parsed = clientConfigSchema.parse(config);
  return atomicWriteJson(root, "client-config.json", parsed);
}

export async function loadClientConfig(
  root = defaultStateRoot(),
  now = new Date(),
): Promise<ClientConfig> {
  const directory = requireAbsolute(root);
  await rejectSymlinkPath(directory);
  const path = join(directory, "client-config.json");
  await rejectSymlinkPath(path);
  const stat = await existingPath(path);
  if (!stat) throw new ConfigError(`Client configuration does not exist: ${path}`);
  if (stat.isSymbolicLink()) throw new ConfigError(`symlink path is not allowed: ${path}`);
  await ensureOwned(path, stat);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `Invalid client configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return validateClientConfig(value, now);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      `Invalid client configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class DnsStateStore {
  readonly root: string;
  readonly stackId: string;

  constructor(stackId: string, root = defaultStateRoot()) {
    if (!serviceIdPattern.test(stackId)) throw new ConfigError("Invalid stack ID");
    this.stackId = stackId;
    this.root = requireAbsolute(root);
  }

  async load(): Promise<DnsState | null> {
    const state = await loadDnsState(this.root);
    if (state && state.stackId !== this.stackId)
      throw new ConfigError("DNS state belongs to a different stack");
    return state;
  }

  async updateResolver(addresses: string[], resolverInstanceId: string): Promise<DnsState> {
    const current = await this.load();
    const nextGeneration = updateDnsGeneration(current ?? undefined, addresses, resolverInstanceId);
    const next: DnsState = {
      schemaVersion: 1,
      stackId: this.stackId,
      ...nextGeneration,
      ...(current?.lease && current.dnsGeneration === nextGeneration.dnsGeneration
        ? { lease: current.lease }
        : {}),
    };
    await persistDnsState(this.root, next);
    return next;
  }

  async replaceLease(replacement: unknown, now = new Date()): Promise<DnsLease> {
    const current = await this.load();
    if (!current) throw new ConfigError("Resolver state must exist before applying a lease");
    const lease = applyLease(current.lease, replacement, now, this.stackId);
    if (lease.dnsGeneration !== current.dnsGeneration) {
      throw new ConfigError("Lease generation does not match DNS state");
    }
    await persistDnsState(this.root, { ...current, lease });
    return lease;
  }
}
