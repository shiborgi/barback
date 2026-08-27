import type { BarbackConfig } from "../../config/schema.ts";
import { GatewayError } from "../../core/errors.ts";
import type { RequestContext } from "../../core/request-context.ts";
import { CircuitBreaker } from "../../limits/circuit-breaker.ts";
import type {
  GatewayChatRequest,
  GatewayChatResponse,
  GatewayEmbeddingResponse,
  GatewayStreamEvent,
  LlmProvider,
  TokenUsage,
} from "../provider.ts";
import { toOllamaRequest } from "./mapper.ts";
import { parseNdjson } from "./stream.ts";

type ProviderConfig = BarbackConfig["providers"][string];
type Fetch = typeof fetch;

function usage(value: Record<string, unknown>): TokenUsage {
  const inputTokens =
    typeof value.prompt_eval_count === "number" ? value.prompt_eval_count : undefined;
  const outputTokens = typeof value.eval_count === "number" ? value.eval_count : undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined || outputTokens !== undefined
      ? { totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0) }
      : {}),
    source: "provider",
  };
}

function retryable(error: unknown): boolean {
  if (error instanceof GatewayError)
    return error.status === 429 || [502, 503, 504].includes(error.status);
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")
  );
}

export class OllamaCloudAdapter implements LlmProvider {
  readonly id: string;
  readonly #breaker: CircuitBreaker;

  constructor(
    id: string,
    private readonly config: ProviderConfig,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.id = id;
    this.#breaker = new CircuitBreaker(
      config.circuitBreaker.failureThreshold,
      config.circuitBreaker.openDuration,
    );
  }

  async ready(signal: AbortSignal): Promise<boolean> {
    try {
      const response = await this.fetcher(new URL("/api/tags", this.config.baseUrl), {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.connectTimeout)]),
        redirect: "error",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #request(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    this.#breaker.assertAvailable();
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.retries.attempts; attempt += 1) {
      const timeout = AbortSignal.timeout(this.config.timeout);
      try {
        const response = await this.fetcher(new URL(path, this.config.baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            accept: "application/json, application/x-ndjson",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, timeout]),
          redirect: "error",
        });
        if (!response.ok) {
          const category =
            response.status === 429
              ? "rate_limit_error"
              : response.status >= 500
                ? "provider_unavailable_error"
                : "provider_error";
          throw new GatewayError(
            `Ollama Cloud returned HTTP ${response.status}`,
            response.status,
            category,
            `provider_http_${response.status}`,
          );
        }
        this.#breaker.success();
        return response;
      } catch (error) {
        lastError = error;
        if (error instanceof GatewayError && error.status < 500 && error.status !== 429)
          throw error;
        if (!retryable(error) || attempt >= this.config.retries.attempts) {
          this.#breaker.failure();
          if (error instanceof GatewayError) throw error;
          if (signal.aborted)
            throw new GatewayError("Request cancelled", 499, "provider_error", "client_cancelled");
          throw new GatewayError(
            "Ollama Cloud request failed",
            503,
            "provider_unavailable_error",
            "provider_unavailable",
            undefined,
            { cause: error },
          );
        }
        const delay = Math.min(
          this.config.retries.maxDelay,
          this.config.retries.baseDelay * 2 ** attempt,
        );
        await Bun.sleep(Math.round(Math.random() * delay));
      }
    }
    throw lastError;
  }

  async chat(
    request: GatewayChatRequest,
    upstreamModel: string,
    ctx: RequestContext,
  ): Promise<GatewayChatResponse | AsyncIterable<GatewayStreamEvent>> {
    const response = await this.#request(
      "/api/chat",
      toOllamaRequest(request, upstreamModel),
      ctx.signal,
    );
    if (!response.body)
      throw new GatewayError(
        "Provider returned an empty response",
        502,
        "provider_error",
        "empty_provider_response",
      );
    const id = `chatcmpl-${ctx.requestId}`;
    const created = Math.floor(Date.now() / 1000);
    if (request.stream) {
      const events = parseNdjson(response.body);
      return (async function* () {
        for await (const event of events) {
          const message = event.message as Record<string, unknown> | undefined;
          yield {
            id,
            model: request.model,
            created,
            ...(typeof message?.content === "string" && message.content
              ? { content: message.content }
              : {}),
            ...(typeof message?.thinking === "string" && message.thinking
              ? { reasoning: message.thinking }
              : {}),
            ...(Array.isArray(message?.tool_calls)
              ? { toolCalls: message.tool_calls as Array<Record<string, unknown>> }
              : {}),
            ...(event.done === true
              ? { finishReason: String(event.done_reason ?? "stop"), usage: usage(event) }
              : {}),
          };
        }
      })();
    }
    const value = (await response.json()) as Record<string, unknown>;
    const message = value.message as Record<string, unknown> | undefined;
    return {
      id,
      model: request.model,
      created,
      content: typeof message?.content === "string" ? message.content : "",
      ...(typeof message?.thinking === "string" ? { reasoning: message.thinking } : {}),
      ...(Array.isArray(message?.tool_calls)
        ? { toolCalls: message.tool_calls as Array<Record<string, unknown>> }
        : {}),
      finishReason: String(value.done_reason ?? "stop"),
      usage: usage(value),
    };
  }

  async embed(
    input: string | string[],
    upstreamModel: string,
    ctx: RequestContext,
  ): Promise<GatewayEmbeddingResponse> {
    const response = await this.#request(
      "/api/embed",
      { model: upstreamModel, input, truncate: false },
      ctx.signal,
    );
    const value = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(value.embeddings)) {
      throw new GatewayError(
        "Invalid embedding response",
        502,
        "provider_error",
        "invalid_embedding_response",
      );
    }
    return {
      embeddings: value.embeddings as number[][],
      usage: usage(value),
    };
  }
}
