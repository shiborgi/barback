import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { BarbackConfig, PolicyConfig } from "../config/schema.ts";
import { GatewayError } from "../core/errors.ts";
import type { Logger } from "../telemetry/logger.ts";

type McpConfig = BarbackConfig["mcp"];
type ServerConfig = McpConfig["servers"][number];

interface ConnectedServer {
  config: ServerConfig;
  client: Client;
  tools: Tool[];
}

export interface ExposedTool extends Tool {
  name: string;
}

function externalName(server: string, tool: string): string {
  const name = `${server}.${tool}`;
  if (name.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Invalid external MCP tool name: ${name}`);
  }
  return name;
}

export class McpRegistry {
  #connected = new Map<string, ConnectedServer>();
  #status = new Map<string, "connected" | "failed">();

  constructor(
    private readonly config: McpConfig,
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    await Promise.all(
      this.config.servers.map(async (server) => {
        const client = new Client({ name: "barback", version: "0.1.0" }, { capabilities: {} });
        try {
          const headers = server.auth
            ? { authorization: `Bearer ${server.auth.bearerToken}` }
            : undefined;
          const transport =
            server.transport === "stdio"
              ? new StdioClientTransport({
                  command: server.command?.[0] ?? "",
                  args: server.command?.slice(1) ?? [],
                  stderr: "pipe",
                })
              : server.transport === "sse"
                ? new SSEClientTransport(new URL(server.url ?? ""), {
                    requestInit: headers ? { headers } : undefined,
                  })
                : new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
                    requestInit: headers ? { headers } : undefined,
                  });
          await client.connect(transport);
          const listed = await client.listTools();
          const seen = new Set<string>();
          for (const tool of listed.tools) {
            const name = externalName(server.id, tool.name);
            if (seen.has(name)) throw new Error(`MCP tool collision: ${name}`);
            seen.add(name);
          }
          this.#connected.set(server.id, { config: server, client, tools: listed.tools });
          this.#status.set(server.id, "connected");
        } catch (error) {
          this.#status.set(server.id, "failed");
          this.logger.warn("mcp.connection_failed", {
            server: server.id,
            error: error instanceof Error ? error.message : String(error),
          });
          await client.close().catch(() => undefined);
          if (server.required) throw error;
        }
      }),
    );
  }

  async #reconnect(server: ServerConfig): Promise<void> {
    const previous = this.#connected.get(server.id);
    this.#connected.delete(server.id);
    await previous?.client.close().catch(() => undefined);
    // Constructing a new transport from the FQDN deliberately forces the next request
    // through a fresh resolver lookup rather than retaining a failed connection.
    const client = new Client({ name: "barback", version: "0.1.0" }, { capabilities: {} });
    const headers = server.auth
      ? { authorization: `Bearer ${server.auth.bearerToken}` }
      : undefined;
    const transport = new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
      requestInit: headers ? { headers } : undefined,
    });
    await client.connect(transport);
    const listed = await client.listTools();
    this.#connected.set(server.id, { config: server, client, tools: listed.tools });
    this.#status.set(server.id, "connected");
  }

  ready(): boolean {
    return this.config.servers
      .filter((server) => server.required)
      .every((server) => this.#status.get(server.id) === "connected");
  }

  #allowed(policy: PolicyConfig): Set<string> {
    const references = policy.mcpToolsets.flatMap((name) => this.config.toolsets[name] ?? []);
    return new Set(references);
  }

  list(policy: PolicyConfig): ExposedTool[] {
    const allowed = this.#allowed(policy);
    const output: ExposedTool[] = [];
    for (const [serverId, server] of [...this.#connected.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      for (const tool of server.tools) {
        if (
          !server.config.tools.allow.includes(tool.name) ||
          !allowed.has(`${serverId}:${tool.name}`)
        )
          continue;
        output.push({ ...tool, name: externalName(serverId, tool.name) });
      }
    }
    return output.sort((left, right) => left.name.localeCompare(right.name));
  }

  describe(policy: PolicyConfig, name: string) {
    const separator = name.indexOf(".");
    if (separator < 1) {
      throw new GatewayError("Invalid MCP tool name", 400, "mcp_error", "invalid_tool_name");
    }
    const serverId = name.slice(0, separator);
    const toolName = name.slice(separator + 1);
    const server = this.#connected.get(serverId);
    if (
      !server?.config.tools.allow.includes(toolName) ||
      !this.#allowed(policy).has(`${serverId}:${toolName}`)
    ) {
      throw new GatewayError(
        "MCP tool is not allowed",
        403,
        "authorization_error",
        "mcp_tool_denied",
      );
    }
    return {
      server,
      serverId,
      toolName,
      policy: server.config.tools.policies[toolName],
    };
  }

  async call(policy: PolicyConfig, name: string, args: Record<string, unknown> | undefined) {
    const { server, serverId, toolName, policy: toolPolicy } = this.describe(policy, name);
    let result: Awaited<ReturnType<Client["callTool"]>>;
    try {
      result = await server.client.callTool({ name: toolName, arguments: args });
    } catch (error) {
      if (server.config.transport !== "streamable-http" || !(error instanceof TypeError))
        throw error;
      await this.#reconnect(server.config);
      // A transport error can occur after the upstream has executed the request. Reconnect
      // for subsequent calls, but never replay a potentially side-effecting tool call.
      throw error;
    }
    return {
      server: serverId,
      tool: toolName,
      policy: toolPolicy,
      result,
    };
  }

  async close(): Promise<void> {
    await Promise.all([...this.#connected.values()].map((server) => server.client.close()));
    this.#connected.clear();
  }
}
