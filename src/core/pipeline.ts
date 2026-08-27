import { cachedEvents, openAiResponse, streamChunk } from "../api/openai.ts";
import { exactCacheId, semanticPartition, sha256 } from "../cache/cache-key.ts";
import { stableJson } from "../cache/canonicalize.ts";
import { parseDuration } from "../config/duration.ts";
import type { GatepatrolConfig } from "../config/schema.ts";
import type {
  GatewayChatRequest,
  GatewayChatResponse,
  GatewayStreamEvent,
  TokenUsage,
} from "../providers/provider.ts";
import { type ContextPressure, checkContextWindow } from "../usage/context-window.ts";
import { actualUtilization } from "../usage/meter.ts";
import { costEquivalentMicros } from "../usage/pricing.ts";
import { usageValues } from "../usage/window-tracker.ts";
import { GatewayError } from "./errors.ts";
import type { RequestContext } from "./request-context.ts";
import type { Runtime } from "./runtime.ts";

export interface ChatOptions {
  cacheMode?: string;
  namespace?: string;
  cacheTtl?: string;
  noStore: boolean;
  refresh: boolean;
}

type CacheStatus = "bypass" | "miss" | "hit" | "shadow-hit";

function selectedCacheMode(
  policy: GatepatrolConfig["policies"][string],
  requested: string | undefined,
): "none" | "exact" | "semantic" | "shadow" {
  const allowed = policy.cache;
  if (!requested) return allowed;
  if (!(["none", "exact", "semantic", "shadow"] as string[]).includes(requested)) {
    throw new GatewayError("Invalid cache mode", 400, "validation_error", "invalid_cache_mode");
  }
  if (requested === "none") return "none";
  if (allowed === "none") return "none";
  if (requested === "exact") return "exact";
  if (allowed === "semantic" || allowed === "shadow") return requested as "semantic" | "shadow";
  return "exact";
}

function semanticProjection(request: GatewayChatRequest): string | undefined {
  if (request.tools?.length) return undefined;
  if (request.messages.some((message) => !["system", "user"].includes(message.role)))
    return undefined;
  if (request.messages.some((message) => typeof message.content !== "string")) return undefined;
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const user = request.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n");
  return `[SYSTEM]\n${system}\n\n[USER]\n${user}`;
}

function semanticHardFilters(
  request: GatewayChatRequest,
  client: string,
  namespace: string,
  provider: string,
) {
  const system = request.messages.filter((message) => message.role === "system");
  return {
    version: 1,
    client,
    namespace,
    provider,
    model: request.model,
    system: sha256(stableJson(system)),
    responseFormat: sha256(stableJson(request.response_format ?? null)),
    parameters: sha256(
      stableJson({
        temperature: request.temperature ?? null,
        topP: request.top_p ?? null,
        seed: request.seed ?? null,
        stop: request.stop ?? null,
        reasoning: request.reasoning_effort ?? null,
      }),
    ),
  };
}

function responseHeaders(
  ctx: RequestContext,
  status: CacheStatus,
  type: "none" | "exact" | "semantic",
  pressure: ContextPressure,
  cacheId?: string,
) {
  return {
    "x-gatepatrol-request-id": ctx.requestId,
    "x-gatepatrol-cache-status": status,
    "x-gatepatrol-cache-type": type,
    ...(cacheId ? { "x-gatepatrol-cache-id": cacheId } : {}),
    "x-gatepatrol-context-utilization": pressure.predictedUtilization.toFixed(4),
    "x-gatepatrol-window-status": pressure.status === "ok" ? "ok" : "warning",
  };
}

function completeResponse(
  request: GatewayChatRequest,
  response: GatewayChatResponse,
  headers: Record<string, string>,
) {
  if (!request.stream) return Response.json(openAiResponse(response), { headers });
  return streamResponse(
    cachedEvents(response),
    request.stream_options?.include_usage === true,
    headers,
  );
}

function streamResponse(
  events: Iterable<GatewayStreamEvent> | AsyncIterable<GatewayStreamEvent>,
  includeUsage: boolean,
  headers: Record<string, string>,
  onComplete?: (response: GatewayChatResponse | undefined) => Promise<void>,
) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let first = true;
      let final: GatewayChatResponse | undefined;
      let content = "";
      let reasoning = "";
      let toolCalls: Array<Record<string, unknown>> | undefined;
      try {
        for await (const event of events) {
          content += event.content ?? "";
          reasoning += event.reasoning ?? "";
          if (event.toolCalls) toolCalls = [...(toolCalls ?? []), ...event.toolCalls];
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(streamChunk(event, first, includeUsage))}\n\n`),
          );
          first = false;
          if (event.finishReason && event.usage) {
            final = {
              id: event.id,
              model: event.model,
              created: event.created,
              content,
              ...(reasoning ? { reasoning } : {}),
              ...(toolCalls ? { toolCalls } : {}),
              finishReason: event.finishReason,
              usage: event.usage,
            };
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        if (onComplete) void onComplete(final);
      } catch (error) {
        controller.error(error);
        if (onComplete) void onComplete(undefined);
      }
    },
  });
  return new Response(stream, {
    headers: {
      ...headers,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function responseEligible(response: GatewayChatResponse, maxBytes: number) {
  return (
    !response.toolCalls?.length &&
    ["stop", "length"].includes(response.finishReason) &&
    JSON.stringify(response).length <= maxBytes
  );
}

function tokenValue(usage: TokenUsage | undefined, key: "inputTokens" | "outputTokens") {
  return usage?.[key] ?? 0;
}

function replay(response: GatewayChatResponse, requestId: string): GatewayChatResponse {
  return {
    ...response,
    id: `chatcmpl-${requestId}`,
    created: Math.floor(Date.now() / 1000),
  };
}

export async function executeChat(
  request: GatewayChatRequest,
  ctx: RequestContext,
  runtime: Runtime,
  options: ChatOptions,
): Promise<Response> {
  const config = runtime.configStore.get();
  const model = config.models[request.model];
  if (model?.capability !== "chat") {
    throw new GatewayError(
      "Model not found",
      404,
      "model_not_found_error",
      "model_not_found",
      "model",
    );
  }
  if (ctx.policy.models.length && !ctx.policy.models.includes(request.model)) {
    throw new GatewayError(
      "Model is not allowed",
      403,
      "authorization_error",
      "model_denied",
      "model",
    );
  }
  const provider = runtime.providers.get(model.provider);
  if (!provider)
    throw new GatewayError(
      "Provider unavailable",
      503,
      "provider_unavailable_error",
      "provider_unavailable",
    );
  const pressure = checkContextWindow(request, model, ctx.policy, config.contextWindow);
  const effectiveRequest: GatewayChatRequest = {
    ...request,
    max_completion_tokens: pressure.reservedOutputTokens,
  };
  runtime.metrics.contextUtilization.observe(
    { model: request.model },
    pressure.predictedUtilization,
  );
  const mode = selectedCacheMode(ctx.policy, options.cacheMode);
  const namespace = options.namespace?.slice(0, 128) || ctx.client.id;
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(namespace)) {
    throw new GatewayError(
      "Invalid cache namespace",
      400,
      "validation_error",
      "invalid_cache_namespace",
    );
  }
  let requestedTtl: number | undefined;
  try {
    requestedTtl = options.cacheTtl ? parseDuration(options.cacheTtl) : undefined;
  } catch {
    throw new GatewayError("Invalid cache TTL", 400, "validation_error", "invalid_cache_ttl");
  }
  const ttl = requestedTtl
    ? Math.min(
        requestedTtl,
        mode === "exact" ? config.cache.exact.defaultTtl : config.cache.semantic.defaultTtl,
      )
    : mode === "exact"
      ? config.cache.exact.defaultTtl
      : config.cache.semantic.defaultTtl;
  const windowStatus = await runtime.windowTracker.reserve(
    ctx.requestId,
    ctx.client.id,
    model.provider,
    request.model,
    "chat",
    usageValues(pressure.estimatedInputTokens, pressure.reservedOutputTokens),
  );
  const id = exactCacheId({
    client: ctx.client.id,
    namespace,
    provider: model.provider,
    model: request.model,
    request: effectiveRequest,
  });
  let cacheStatus: CacheStatus = mode === "none" ? "bypass" : "miss";
  if (mode !== "none" && !options.refresh && config.cache.exact.enabled) {
    const hit = await runtime.exactCache.get(id);
    runtime.metrics.cacheLookups.inc({ type: "exact", status: hit ? "hit" : "miss" });
    if (hit) {
      cacheStatus = "hit";
      const replayed = replay(hit.response, ctx.requestId);
      const served = usageValues(
        tokenValue(replayed.usage, "inputTokens"),
        tokenValue(replayed.usage, "outputTokens"),
      );
      await runtime.windowTracker.reconcile(
        ctx.requestId,
        ctx.client.id,
        model.provider,
        request.model,
        "chat",
        { provider: usageValues(0, 0), served },
      );
      return completeResponse(
        request,
        replayed,
        responseHeaders(ctx, cacheStatus, "exact", pressure, id),
      );
    }
  }

  let lockToken: string | undefined;
  if (mode !== "none" && config.cache.exact.enabled) {
    lockToken = await runtime.exactCache.lock(id);
    if (!lockToken) {
      await Bun.sleep(50);
      const populated = await runtime.exactCache.get(id);
      if (populated) {
        const replayed = replay(populated.response, ctx.requestId);
        await runtime.windowTracker.reconcile(
          ctx.requestId,
          ctx.client.id,
          model.provider,
          request.model,
          "chat",
          {
            provider: usageValues(0, 0),
            served: usageValues(
              tokenValue(replayed.usage, "inputTokens"),
              tokenValue(replayed.usage, "outputTokens"),
            ),
          },
        );
        return completeResponse(
          request,
          replayed,
          responseHeaders(ctx, "hit", "exact", pressure, id),
        );
      }
    }
  }

  let semanticVector: number[] | undefined;
  let semanticKey: string | undefined;
  const projection = semanticProjection(effectiveRequest);
  if (
    runtime.semanticCache &&
    config.cache.semantic.enabled &&
    ["semantic", "shadow"].includes(mode) &&
    projection &&
    request.messages.length <= config.cache.semantic.maxMessages
  ) {
    const embeddingModel = config.models[config.cache.semantic.embeddingModel];
    const embeddingProvider = embeddingModel
      ? runtime.providers.get(embeddingModel.provider)
      : undefined;
    if (embeddingModel && embeddingProvider) {
      const embedding = await embeddingProvider.embed(
        projection,
        embeddingModel.upstreamModel,
        ctx,
      );
      semanticVector = embedding.embeddings[0];
      semanticKey = semanticPartition(
        semanticHardFilters(effectiveRequest, ctx.client.id, namespace, model.provider),
      );
      if (semanticVector) {
        const candidate = await runtime.semanticCache.lookup(semanticKey, semanticVector);
        runtime.metrics.cacheLookups.inc({ type: "semantic", status: candidate ? "hit" : "miss" });
        if (candidate) {
          runtime.metrics.semanticSimilarity.observe(candidate.score);
          if (await runtime.semanticCache.servingAllowed()) {
            cacheStatus = "hit";
            const replayed = replay(candidate.response, ctx.requestId);
            await runtime.windowTracker.reconcile(
              ctx.requestId,
              ctx.client.id,
              model.provider,
              request.model,
              "chat",
              {
                provider: usageValues(0, 0),
                served: usageValues(
                  tokenValue(replayed.usage, "inputTokens"),
                  tokenValue(replayed.usage, "outputTokens"),
                ),
              },
            );
            if (lockToken) void runtime.exactCache.unlock(id, lockToken);
            return completeResponse(
              request,
              replayed,
              responseHeaders(ctx, cacheStatus, "semantic", pressure, candidate.id),
            );
          }
          cacheStatus = "shadow-hit";
          await runtime.semanticCache.recordShadow(candidate);
        }
      }
    }
  }

  runtime.metrics.active.inc({ operation: "chat" });
  let active = true;
  const releaseActive = () => {
    if (!active) return;
    active = false;
    runtime.metrics.active.dec({ operation: "chat" });
  };
  const started = performance.now();
  try {
    const upstream = await provider.chat(effectiveRequest, model.upstreamModel, ctx);
    const finalize = async (response: GatewayChatResponse | undefined) => {
      releaseActive();
      try {
        if (!response) {
          await runtime.windowTracker.reconcile(
            ctx.requestId,
            ctx.client.id,
            model.provider,
            request.model,
            "chat",
            { provider: usageValues(0, 0), served: usageValues(0, 0) },
          );
          return;
        }
        const input = tokenValue(response.usage, "inputTokens");
        const output = tokenValue(response.usage, "outputTokens");
        const cost = costEquivalentMicros(response.usage, model.pricing) ?? 0;
        const observed = usageValues(input, output, cost);
        await runtime.windowTracker.reconcile(
          ctx.requestId,
          ctx.client.id,
          model.provider,
          request.model,
          "chat",
          { provider: observed, served: observed },
        );
        runtime.metrics.tokens.inc(
          { model: request.model, kind: "input", basis: "provider", operation: "chat" },
          input,
        );
        runtime.metrics.tokens.inc(
          { model: request.model, kind: "output", basis: "provider", operation: "chat" },
          output,
        );
        await runtime.usageMeter.record({
          schemaVersion: 1,
          timestamp: new Date().toISOString(),
          requestId: ctx.requestId,
          clientId: ctx.client.id,
          provider: model.provider,
          model: request.model,
          operation: "chat",
          providerUsage: response.usage,
          servedUsage: response.usage,
          ...(cost ? { costEquivalentMicros: cost, pricingVersion: model.pricing?.version } : {}),
          cache: { status: cacheStatus },
          context: {
            window: model.contextWindow,
            predictedUtilization: pressure.predictedUtilization,
            actualUtilization: actualUtilization(response.usage, model.contextWindow),
          },
          latencyMs: performance.now() - started,
          success: true,
        });
        if (!options.noStore && responseEligible(response, config.cache.maxResponseBytes)) {
          if (mode !== "none" && config.cache.exact.enabled) {
            await runtime.exactCache.put(id, namespace, response, ttl);
          }
          if (
            runtime.semanticCache &&
            semanticVector &&
            semanticKey &&
            ["semantic", "shadow"].includes(mode)
          ) {
            await runtime.semanticCache.put(id, semanticKey, semanticVector, response, ttl);
          }
        }
      } finally {
        if (lockToken) await runtime.exactCache.unlock(id, lockToken);
      }
    };
    const headers = responseHeaders(
      ctx,
      cacheStatus,
      ["semantic", "shadow"].includes(mode) ? "semantic" : mode === "exact" ? "exact" : "none",
      pressure,
      mode === "none" ? undefined : id,
    );
    headers["x-gatepatrol-window-status"] = windowStatus;
    if (request.stream) {
      return streamResponse(
        upstream as AsyncIterable<GatewayStreamEvent>,
        request.stream_options?.include_usage === true,
        headers,
        finalize,
      );
    }
    const response = upstream as GatewayChatResponse;
    await finalize(response);
    return Response.json(openAiResponse(response), { headers });
  } catch (error) {
    releaseActive();
    if (lockToken) void runtime.exactCache.unlock(id, lockToken);
    await runtime.windowTracker.reconcile(
      ctx.requestId,
      ctx.client.id,
      model.provider,
      request.model,
      "chat",
      { provider: usageValues(0, 0), served: usageValues(0, 0) },
    );
    throw error;
  }
}
