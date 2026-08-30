import { describe, expect, test } from "bun:test";
import { loadStack, validateStackAgainstBarback } from "../../src/dns/stack-loader.ts";
import { stackSchema } from "../../src/dns/stack-schema.ts";
import { testConfig } from "../fixtures/config.ts";

type RawService = {
  role: string;
  container: string;
  dns: string;
  port: number;
  path?: string;
  required?: boolean;
  runtime: Record<string, unknown>;
  health: Record<string, unknown>;
};

function stackInput() {
  return {
    version: 1,
    stackId: "barback-local",
    network: "barback",
    dns: {
      zone: "barback.internal",
      container: "barback-dns",
      image: "barback-dns:build-sha256-0123456789abcdef",
      ttl: "5s",
      lease: "30s",
    },
    services: {
      barback: {
        role: "gateway",
        container: "barback-gateway",
        dns: "barback.internal",
        port: 8080,
        runtime: { mode: "managed", image: "barback:build-sha256-0123456789abcdef" },
        health: { type: "http", path: "/health/ready" },
      },
      valkey: {
        role: "storage",
        container: "barback-valkey",
        dns: "valkey.barback.internal",
        port: 6379,
        runtime: {
          mode: "managed",
          image:
            "valkey/valkey@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        health: { type: "exec", command: ["valkey-cli", "ping"] },
      },
      google: {
        role: "mcp",
        container: "google-mcp",
        dns: "google.mcp.barback.internal",
        port: 8090,
        path: "/mcp",
        required: true,
        runtime: { mode: "managed", image: "google-mcp:build-sha256-0123456789abcdef" },
        health: { type: "http", path: "/health" },
      },
    } as Record<string, RawService>,
  };
}

describe("DNS stack contract", () => {
  test("loads the committed non-secret stack example", async () => {
    const stack = await loadStack("config/stack.example.yaml");
    expect(stack.networkMode).toBe("nat");
    expect(stack.services.google?.dns).toBe("google.mcp.barback.internal");
  });

  test("parses a complete managed stack and supports declarative MCP additions", () => {
    const input = stackInput();
    input.services.weather = {
      role: "mcp",
      container: "weather-mcp",
      dns: "weather.mcp.barback.internal",
      port: 8091,
      path: "/mcp",
      required: false,
      runtime: { mode: "managed", image: "weather-mcp:build-sha256-0123456789abcdef" },
      health: { type: "http", path: "/health" },
    };
    expect(stackSchema.parse(input).services.weather?.dns).toBe("weather.mcp.barback.internal");
  });

  test("rejects identity collisions and invalid runtime descriptors", () => {
    const input = stackInput();
    const google = input.services.google;
    if (!google) throw new Error("google fixture missing");
    google.container = "barback-valkey";
    expect(() => stackSchema.parse(input)).toThrow(/Duplicate container/);

    google.container = "google-mcp";
    google.runtime = { mode: "adopted" };
    expect(() => stackSchema.parse(input)).toThrow(/labels/);
  });

  test("cross-validates required network MCPs and excludes stdio MCPs", () => {
    const config = testConfig();
    config.mcp.servers = [
      {
        id: "google",
        transport: "streamable-http",
        url: "http://google.mcp.barback.internal:8090/mcp",
        required: true,
        tools: { default: "deny", allow: [], policies: {} },
      },
      {
        id: "local",
        transport: "stdio",
        command: ["local-mcp"],
        required: true,
        tools: { default: "deny", allow: [], policies: {} },
      },
    ];
    expect(() =>
      validateStackAgainstBarback(stackSchema.parse(stackInput()), config),
    ).not.toThrow();

    const missing = stackInput();
    delete missing.services.google;
    expect(() => validateStackAgainstBarback(stackSchema.parse(missing), config)).toThrow(/google/);
  });
});
