import type { GatepatrolConfig } from "../config/schema.ts";
import { GatewayError } from "../core/errors.ts";
import type { RequestContext } from "../core/request-context.ts";
import type { Metrics } from "../telemetry/metrics.ts";
import type { McpRegistry } from "./registry.ts";
import type { McpToolCache } from "./tool-cache.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

export class McpGateway {
  constructor(
    private readonly registry: McpRegistry,
    private readonly cache: McpToolCache,
    private readonly metrics: Metrics,
    private readonly argumentLimit: number,
    private readonly protocol: GatepatrolConfig["mcp"]["protocol"],
  ) {}

  async handle(request: Request, ctx: RequestContext): Promise<Response> {
    let body: JsonRpcRequest;
    try {
      body = (await request.json()) as JsonRpcRequest;
    } catch {
      return Response.json(error(undefined, -32700, "Parse error"), { status: 400 });
    }
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return Response.json(error(body.id, -32600, "Invalid Request"), { status: 400 });
    }
    const version = request.headers.get("mcp-protocol-version");
    if (version === "2026-07-28") {
      const method = request.headers.get("mcp-method");
      const mirroredName = request.headers.get("mcp-name");
      const bodyName = body.params?.name;
      if (method !== body.method || (mirroredName !== null && mirroredName !== bodyName)) {
        return Response.json(error(body.id, -32600, "MCP headers and body do not match"), {
          status: 400,
        });
      }
    } else if (
      version &&
      !(this.protocol.compatibility as readonly string[])
        .concat(this.protocol.primary)
        .includes(version)
    ) {
      return Response.json(
        error(body.id, -32600, "Unsupported MCP protocol version", {
          supported: [this.protocol.primary, ...this.protocol.compatibility],
        }),
        { status: 400 },
      );
    }

    try {
      if (body.method === "initialize") {
        const requested = String(body.params?.protocolVersion);
        const supported: readonly string[] = [
          this.protocol.primary,
          ...this.protocol.compatibility,
        ];
        return Response.json(
          result(body.id, {
            protocolVersion: supported.includes(requested) ? requested : this.protocol.primary,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "gatepatrol", version: "0.1.0" },
          }),
        );
      }
      if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
      if (body.method === "ping") return Response.json(result(body.id, {}));
      if (body.method === "tools/list") {
        return Response.json(result(body.id, { tools: this.registry.list(ctx.policy) }));
      }
      if (body.method === "tools/call") {
        const name = body.params?.name;
        const args = body.params?.arguments as Record<string, unknown> | undefined;
        if (typeof name !== "string")
          return Response.json(error(body.id, -32602, "Tool name is required"), { status: 400 });
        if (JSON.stringify(args ?? {}).length > this.argumentLimit) {
          return Response.json(error(body.id, -32602, "Tool arguments exceed configured limit"), {
            status: 413,
          });
        }
        const described = this.registry.describe(ctx.policy, name);
        const cachePolicy = described.policy;
        const cacheId = this.cache.id(ctx.client.id, described.serverId, described.toolName, args);
        if (cachePolicy?.effect === "read" && cachePolicy.cache.mode === "exact") {
          const hit = await this.cache.get(cacheId);
          if (hit !== undefined) {
            this.metrics.mcpCalls.inc({
              server: described.serverId,
              tool: described.toolName,
              status: "cache_hit",
            });
            return Response.json(result(body.id, hit));
          }
        }
        const called = await this.registry.call(ctx.policy, name, args);
        if (
          cachePolicy?.effect === "read" &&
          cachePolicy.cache.mode === "exact" &&
          cachePolicy.cache.ttl
        ) {
          void this.cache.put(cacheId, called.result, cachePolicy.cache.ttl);
        }
        this.metrics.mcpCalls.inc({
          server: described.serverId,
          tool: described.toolName,
          status: "success",
        });
        return Response.json(result(body.id, called.result));
      }
      return Response.json(error(body.id, -32601, "Method not found"), { status: 404 });
    } catch (caught) {
      if (caught instanceof GatewayError) {
        return Response.json(error(body.id, -32000, caught.message, { code: caught.code }), {
          status: caught.status,
        });
      }
      return Response.json(error(body.id, -32603, "Internal MCP error"), { status: 500 });
    }
  }
}
