import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticate, hasScope } from "../auth/client-key.ts";
import type { ClientConfig } from "../config/schema.ts";
import { GatewayError, normalizeError } from "../core/errors.ts";
import { executeChat } from "../core/pipeline.ts";
import type { AppVariables, RequestContext } from "../core/request-context.ts";
import type { Runtime } from "../core/runtime.ts";
import { parseChatRequest } from "./chat-completions.ts";

type AppEnv = { Variables: AppVariables };

function bearerClient(request: Request, runtime: Runtime): ClientConfig {
  const client = authenticate(
    request.headers.get("authorization") ?? undefined,
    runtime.configStore.get(),
  );
  if (!client)
    throw new GatewayError(
      "Invalid client credential",
      401,
      "authentication_error",
      "invalid_api_key",
    );
  return client;
}

function requireScope(client: ClientConfig, scope: ClientConfig["scopes"][number]) {
  if (!hasScope(client, scope)) {
    throw new GatewayError(
      "Insufficient client scope",
      403,
      "authorization_error",
      "insufficient_scope",
    );
  }
}

function context(
  request: Request,
  runtime: Runtime,
  client: ClientConfig,
  requestId: string,
): RequestContext {
  const policy = runtime.configStore.get().policies[client.policy];
  if (!policy)
    throw new GatewayError(
      "Client policy not found",
      500,
      "internal_error",
      "client_policy_missing",
    );
  return { requestId, client, policy, startedAt: performance.now(), signal: request.signal };
}

function requestId(request: Request) {
  const supplied = request.headers.get("x-request-id");
  return supplied && /^[A-Za-z0-9_.:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export function createApp(runtime: Runtime) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", requestId(c.req.raw));
    await next();
    c.header("x-gatepatrol-request-id", c.get("requestId"));
  });
  app.onError((caught, c) => {
    const error = normalizeError(caught);
    runtime.logger.error("request.failed", {
      requestId: c.get("requestId"),
      code: error.code,
      status: error.status,
    });
    return c.json(error.body(c.get("requestId")), error.status as 400);
  });
  app.get("/health/live", (c) => c.json({ status: "live" }));
  app.get("/health/ready", async (c) => {
    const store = await runtime.store.ping();
    const mcp = runtime.mcpRegistry.ready();
    const providerChecks = await Promise.all(
      [...runtime.providers.values()].map((provider) => provider.ready(c.req.raw.signal)),
    );
    const provider = providerChecks.every(Boolean);
    const ready = store && mcp && provider;
    return c.json(
      { status: ready ? "ready" : "not_ready", dependencies: { store, mcp, provider } },
      ready ? 200 : 503,
    );
  });
  app.get("/health", async (c) => {
    const store = await runtime.store.ping();
    const ready = store && runtime.mcpRegistry.ready();
    return c.json({ status: ready ? "ready" : "not_ready" }, ready ? 200 : 503);
  });
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: runtime.configStore.get().server.requestBodyLimit,
      onError: (c) =>
        c.json(
          new GatewayError(
            "Request body too large",
            413,
            "validation_error",
            "body_too_large",
          ).body(c.get("requestId")),
          413,
        ),
    }),
  );
  app.use("/mcp", bodyLimit({ maxSize: runtime.configStore.get().server.requestBodyLimit }));

  app.get("/v1/models", (c) => {
    const client = bearerClient(c.req.raw, runtime);
    requireScope(client, "llm:models");
    const policy = runtime.configStore.get().policies[client.policy];
    const models = Object.entries(runtime.configStore.get().models)
      .filter(
        ([id, model]) =>
          model.capability === "chat" && (!policy?.models.length || policy.models.includes(id)),
      )
      .map(([id]) => ({ id, object: "model", created: 0, owned_by: "gatepatrol" }));
    return c.json({ object: "list", data: models });
  });

  app.post("/v1/chat/completions", async (c) => {
    const client = bearerClient(c.req.raw, runtime);
    requireScope(client, "llm:invoke");
    const ctx = context(c.req.raw, runtime, client, c.get("requestId"));
    c.set("requestContext", ctx);
    const request = parseChatRequest(await c.req.json());
    const response = await executeChat(request, ctx, runtime, {
      cacheMode: c.req.header("x-gatepatrol-cache-mode"),
      namespace: c.req.header("x-gatepatrol-cache-namespace"),
      cacheTtl: c.req.header("x-gatepatrol-cache-ttl"),
      noStore: c.req.header("x-gatepatrol-cache-no-store") === "true",
      refresh: c.req.header("x-gatepatrol-cache-refresh") === "true",
    });
    return response;
  });

  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST")
      return c.json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    const origin = c.req.header("origin");
    const allowed = runtime.configStore.get().server.allowedOrigins;
    if (origin && !allowed.includes(origin)) {
      throw new GatewayError("Origin is not allowed", 403, "authorization_error", "origin_denied");
    }
    const client = bearerClient(c.req.raw, runtime);
    const cloned = c.req.raw.clone();
    const rpc = (await cloned.json()) as { method?: string };
    requireScope(client, rpc.method === "tools/call" ? "mcp:call" : "mcp:list");
    const ctx = context(c.req.raw, runtime, client, c.get("requestId"));
    return runtime.mcpGateway.handle(c.req.raw, ctx);
  });
  app.notFound((c) =>
    c.json(
      {
        error: {
          message: "Not found",
          type: "validation_error",
          code: "not_found",
          request_id: c.get("requestId"),
        },
      },
      404,
    ),
  );
  return app;
}

export function createAdminApp(runtime: Runtime) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", requestId(c.req.raw));
    const client = bearerClient(c.req.raw, runtime);
    requireScope(client, "admin");
    await next();
  });
  app.onError((caught, c) => {
    const error = normalizeError(caught);
    return c.json(error.body(c.get("requestId")), error.status as 400);
  });
  app.get(runtime.configStore.get().telemetry.prometheus.path, async (c) => {
    c.header("content-type", runtime.metrics.contentType());
    return c.body(await runtime.metrics.render());
  });
  app.get("/admin/usage/windows", async (c) => {
    const client = c.req.query("client") ?? runtime.configStore.get().auth.clients[0]?.id ?? "";
    const provider =
      c.req.query("provider") ?? Object.keys(runtime.configStore.get().providers)[0] ?? "";
    const model = c.req.query("model") ?? Object.keys(runtime.configStore.get().models)[0] ?? "";
    return c.json({
      provider,
      windows: await runtime.windowTracker.inspect(client, provider, model),
    });
  });
  app.get("/admin/cache/stats", async (c) => {
    const semanticServing = await runtime.semanticCache?.servingAllowed();
    return c.json({
      exact: { enabled: runtime.configStore.get().cache.exact.enabled },
      semantic: { enabled: !!runtime.semanticCache, serving: semanticServing ?? false },
    });
  });
  app.delete("/admin/cache/entries/:id", async (c) =>
    c.json({ deleted: await runtime.exactCache.invalidateId(c.req.param("id")) }),
  );
  app.delete("/admin/cache/namespaces/:namespace", async (c) =>
    c.json({ deleted: await runtime.exactCache.invalidateNamespace(c.req.param("namespace")) }),
  );
  app.post("/admin/config/reload", async (c) => {
    await runtime.reload();
    return c.json({ reloaded: true });
  });
  return app;
}
