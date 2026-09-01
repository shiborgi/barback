import type { GatewayChatResponse, GatewayStreamEvent, TokenUsage } from "../providers/provider.ts";

function functionArguments(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function toolCalls(calls: Array<Record<string, unknown>> | undefined, streaming = false) {
  return calls?.map((call, index) => {
    const fn =
      call.function && typeof call.function === "object"
        ? (call.function as Record<string, unknown>)
        : {};
    return {
      ...(streaming ? { index: typeof call.index === "number" ? call.index : index } : {}),
      id: typeof call.id === "string" ? call.id : `call_${index}`,
      type: "function",
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: functionArguments(fn.arguments),
      },
    };
  });
}

export function openAiUsage(usage: TokenUsage) {
  return {
    prompt_tokens: usage.inputTokens ?? 0,
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    ...(usage.reasoningTokens !== undefined
      ? { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }
      : {}),
    ...(usage.cachedInputTokens !== undefined
      ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
  };
}

export function openAiResponse(response: GatewayChatResponse) {
  return {
    id: response.id,
    object: "chat.completion",
    created: response.created,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: response.content,
          ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
          ...(response.toolCalls ? { tool_calls: toolCalls(response.toolCalls) } : {}),
        },
        finish_reason: response.toolCalls?.length ? "tool_calls" : response.finishReason,
      },
    ],
    usage: openAiUsage(response.usage),
  };
}

export function streamChunk(event: GatewayStreamEvent, first: boolean, includeUsage: boolean) {
  const delta = {
    ...(first ? { role: "assistant" } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
    ...(event.reasoning !== undefined ? { reasoning_content: event.reasoning } : {}),
    ...(event.toolCalls ? { tool_calls: toolCalls(event.toolCalls, true) } : {}),
  };
  return {
    id: event.id,
    object: "chat.completion.chunk",
    created: event.created,
    model: event.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: event.finishReason
          ? event.toolCalls?.length
            ? "tool_calls"
            : event.finishReason
          : null,
      },
    ],
    ...(includeUsage && event.usage ? { usage: openAiUsage(event.usage) } : {}),
  };
}

export function cachedEvents(response: GatewayChatResponse): GatewayStreamEvent[] {
  return [
    {
      id: response.id,
      model: response.model,
      created: response.created,
      content: response.content,
      ...(response.reasoning ? { reasoning: response.reasoning } : {}),
      ...(response.toolCalls ? { toolCalls: response.toolCalls } : {}),
    },
    {
      id: response.id,
      model: response.model,
      created: response.created,
      finishReason: response.finishReason,
      usage: response.usage,
    },
  ];
}
