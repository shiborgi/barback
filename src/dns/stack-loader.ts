import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { ConfigError } from "../config/loader.ts";
import type { BarbackConfig } from "../config/schema.ts";
import { type StackConfig, stackSchema } from "./stack-schema.ts";

function resolveEnvironment(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string" && value.startsWith("env:") && value.length > 4) {
    const name = value.slice(4);
    const resolved = env[name];
    if (!resolved) throw new ConfigError(`Missing environment variable at env:${name}`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveEnvironment(entry, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvironment(entry, env)]),
    );
  }
  return value;
}

function formatIssues(error: unknown): string {
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    return issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function parseStack(value: unknown): StackConfig {
  try {
    return stackSchema.parse(value);
  } catch (error) {
    throw new ConfigError(formatIssues(error));
  }
}

export async function loadStack(
  path = process.env.BARBACK_STACK_CONFIG ?? "barback-stack.yaml",
  env: Record<string, string | undefined> = process.env,
): Promise<StackConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Cannot read stack configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseStack(resolveEnvironment(parse(source, { maxAliasCount: 0 }), env));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`Invalid stack configuration: ${formatIssues(error)}`);
  }
}

function mcpUrl(url: string | undefined): URL | undefined {
  if (!url) return undefined;
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function validateStackAgainstBarback(stack: StackConfig, config: BarbackConfig): void {
  const errors: string[] = [];
  const networkServices = Object.entries(stack.services).filter(
    ([, service]) => service.role === "mcp",
  );
  const servers = config.mcp.servers;

  for (const [serviceId, service] of networkServices) {
    const server = servers.find((candidate) => candidate.id === serviceId);
    if (!server) {
      errors.push(
        `MCP ${serviceId} is present in the stack registry but missing from barback.mcp.servers`,
      );
      continue;
    }
    if (server.transport !== "streamable-http") {
      errors.push(`MCP ${serviceId} must use streamable-http in barback.mcp.servers`);
    }
    const parsed = mcpUrl(server.url);
    if (!parsed) {
      errors.push(`MCP ${serviceId} must define a valid URL`);
      continue;
    }
    const expectedPath = service.path ?? "/mcp";
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== service.dns ||
      parsed.port !== String(service.port) ||
      parsed.pathname !== expectedPath ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    ) {
      errors.push(
        `MCP ${serviceId} URL must be http://${service.dns}:${service.port}${expectedPath}`,
      );
    }
  }

  for (const server of servers) {
    if (server.transport === "stdio") continue;
    const service = stack.services[server.id];
    if (service?.role !== "mcp") {
      errors.push(`Network MCP ${server.id} is missing from the stack registry`);
    }
  }

  if (errors.length > 0) throw new ConfigError(errors.join("; "));
}
