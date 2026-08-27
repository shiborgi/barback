import { GatewayError } from "../../core/errors.ts";
import type { GatewayChatRequest, GatewayMessage } from "../provider.ts";

function mapContent(message: GatewayMessage) {
  if (typeof message.content === "string" || message.content === null) {
    return { content: message.content ?? "" };
  }
  const text: string[] = [];
  const images: string[] = [];
  for (const part of message.content) {
    if (part.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part.type === "image_url" && part.image_url && typeof part.image_url === "object") {
      const url = (part.image_url as { url?: unknown }).url;
      if (typeof url !== "string" || !url.startsWith("data:") || !url.includes(";base64,")) {
        throw new GatewayError(
          "Only base64 image URLs are supported",
          400,
          "validation_error",
          "unsupported_image_url",
          "messages",
        );
      }
      images.push(url.slice(url.indexOf(",") + 1));
    } else {
      throw new GatewayError(
        "Unsupported message content part",
        400,
        "validation_error",
        "unsupported_content",
        "messages",
      );
    }
  }
  return { content: text.join("\n"), ...(images.length ? { images } : {}) };
}

function mapResponseFormat(format: GatewayChatRequest["response_format"]): unknown {
  if (!format) return undefined;
  if (format.type === "json_object") return "json";
  if (format.type === "json_schema") {
    const jsonSchema = format.json_schema;
    if (jsonSchema && typeof jsonSchema === "object" && "schema" in jsonSchema) {
      return (jsonSchema as { schema: unknown }).schema;
    }
  }
  throw new GatewayError(
    "Unsupported response_format",
    400,
    "validation_error",
    "unsupported_response_format",
    "response_format",
  );
}

export function toOllamaRequest(request: GatewayChatRequest, upstreamModel: string) {
  if (request.n !== undefined && request.n !== 1) {
    throw new GatewayError(
      "Only n=1 is supported",
      400,
      "validation_error",
      "unsupported_parameter",
      "n",
    );
  }
  if (request.logit_bias !== undefined) {
    throw new GatewayError(
      "logit_bias is not supported",
      400,
      "validation_error",
      "unsupported_parameter",
      "logit_bias",
    );
  }
  if (request.tool_choice !== undefined && request.tool_choice !== "auto") {
    throw new GatewayError(
      "Explicit tool_choice is not supported",
      400,
      "validation_error",
      "unsupported_parameter",
      "tool_choice",
    );
  }

  const options: Record<string, unknown> = {};
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (request.top_p !== undefined) options.top_p = request.top_p;
  if (request.seed !== undefined) options.seed = request.seed;
  if (request.stop !== undefined) options.stop = request.stop;
  const max = request.max_completion_tokens ?? request.max_tokens;
  if (max !== undefined) options.num_predict = max;
  if (request.frequency_penalty !== undefined)
    options.frequency_penalty = request.frequency_penalty;
  if (request.presence_penalty !== undefined) options.presence_penalty = request.presence_penalty;

  return {
    model: upstreamModel,
    messages: request.messages.map((message) => ({
      role: message.role,
      ...mapContent(message),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    })),
    stream: request.stream,
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.response_format ? { format: mapResponseFormat(request.response_format) } : {}),
    ...(request.reasoning_effort && request.reasoning_effort !== "none"
      ? { think: request.reasoning_effort }
      : request.reasoning_effort === "none"
        ? { think: false }
        : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}
