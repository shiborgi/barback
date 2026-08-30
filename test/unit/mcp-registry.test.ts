import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { configSchema } from "../../src/config/schema.ts";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { testConfigInput } from "../fixtures/config.ts";

async function mcpServer(value: string) {
  const server = new Server({ name: "google", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "lookup", description: "test lookup", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: value }],
  }));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  const instance = createServer((request, response) => transport.handleRequest(request, response));
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  return { server, instance };
}

test("reconnects a new Google MCP tool call through its FQDN after restart", async () => {
  let upstream = await mcpServer("first");
  const originalFetch = globalThis.fetch;
  let stalePort: number | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== "google.mcp.barback.internal") return originalFetch(request);
    url.hostname = "127.0.0.1";
    const port = stalePort ?? (upstream.instance.address() as { port: number }).port;
    stalePort = undefined;
    url.port = String(port);
    return originalFetch(new Request(url, request));
  }) as typeof fetch;
  try {
    const config = configSchema.parse({
      ...testConfigInput(),
      policies: {
        standard: { ...testConfigInput().policies.standard, mcpToolsets: ["google"] },
      },
      mcp: {
        ...testConfigInput().mcp,
        servers: [
          {
            id: "google",
            transport: "streamable-http",
            url: "http://google.mcp.barback.internal/mcp",
            required: true,
            tools: { allow: ["lookup"], policies: {} },
          },
        ],
        toolsets: { google: ["google:lookup"] },
      },
    });
    const logger = { warn() {} } as never;
    const registry = new McpRegistry(config.mcp, logger);
    const policy = config.policies.standard;
    if (!policy) throw new Error("standard policy is missing");
    await registry.connect();
    const first = await registry.call(policy, "google.lookup", {});
    expect(first.result.content).toContainEqual({ type: "text", text: "first" });

    await upstream.server.close();
    stalePort = (upstream.instance.address() as { port: number }).port;
    await new Promise<void>((resolve) => upstream.instance.close(() => resolve()));
    upstream = await mcpServer("second");
    await expect(registry.call(policy, "google.lookup", {})).rejects.toBeInstanceOf(TypeError);
    const second = await registry.call(policy, "google.lookup", {});
    expect(second.result.content).toContainEqual({ type: "text", text: "second" });
    await registry.close();
  } finally {
    globalThis.fetch = originalFetch;
    await upstream.server.close();
    await new Promise<void>((resolve) => upstream.instance.close(() => resolve()));
  }
});
