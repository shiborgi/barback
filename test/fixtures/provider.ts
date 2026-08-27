import type { RequestContext } from "../../src/core/request-context.ts";
import type {
  GatewayChatRequest,
  GatewayChatResponse,
  GatewayEmbeddingResponse,
  GatewayStreamEvent,
  LlmProvider,
} from "../../src/providers/provider.ts";

export class FakeProvider implements LlmProvider {
  readonly id = "ollama";
  calls = 0;
  lastRequest?: GatewayChatRequest;

  async ready() {
    return true;
  }

  async chat(
    request: GatewayChatRequest,
    _upstreamModel: string,
    ctx: RequestContext,
  ): Promise<GatewayChatResponse | AsyncIterable<GatewayStreamEvent>> {
    this.calls += 1;
    this.lastRequest = request;
    const base = {
      id: `chatcmpl-${ctx.requestId}`,
      model: request.model,
      created: 1,
    };
    if (request.stream) {
      return (async function* () {
        yield { ...base, content: "hello" };
        yield {
          ...base,
          finishReason: "stop",
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, source: "provider" as const },
        };
      })();
    }
    return {
      ...base,
      content: "hello",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, source: "provider" },
    };
  }

  async embed(): Promise<GatewayEmbeddingResponse> {
    return { embeddings: [[1, 0]], usage: { inputTokens: 1, totalTokens: 1, source: "provider" } };
  }
}
