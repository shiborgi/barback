import type { RequestContext } from "../core/request-context.ts";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated";
}

export interface GatewayMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<Record<string, unknown>> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<Record<string, unknown>>;
}

export interface GatewayChatRequest {
  model: string;
  messages: GatewayMessage[];
  stream: boolean;
  stream_options?: { include_usage?: boolean };
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  response_format?: Record<string, unknown>;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  seed?: number;
  stop?: string | string[];
  reasoning_effort?: "none" | "low" | "medium" | "high" | "max";
  frequency_penalty?: number;
  presence_penalty?: number;
  n?: number;
  logit_bias?: unknown;
  user?: string;
  [key: string]: unknown;
}

export interface GatewayChatResponse {
  id: string;
  model: string;
  created: number;
  content: string;
  reasoning?: string;
  toolCalls?: Array<Record<string, unknown>>;
  finishReason: string;
  usage: TokenUsage;
}

export interface GatewayStreamEvent {
  id: string;
  model: string;
  created: number;
  content?: string;
  reasoning?: string;
  toolCalls?: Array<Record<string, unknown>>;
  finishReason?: string;
  usage?: TokenUsage;
}

export interface GatewayEmbeddingResponse {
  embeddings: number[][];
  usage: TokenUsage;
}

export interface LlmProvider {
  readonly id: string;
  ready(signal: AbortSignal): Promise<boolean>;
  chat(
    request: GatewayChatRequest,
    upstreamModel: string,
    ctx: RequestContext,
  ): Promise<GatewayChatResponse | AsyncIterable<GatewayStreamEvent>>;
  embed(
    input: string | string[],
    upstreamModel: string,
    ctx: RequestContext,
  ): Promise<GatewayEmbeddingResponse>;
}
