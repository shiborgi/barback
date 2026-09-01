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

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function mapToolCalls(calls: Array<Record<string, unknown>> | undefined) {
  if (!calls) return undefined;
  return calls.map((call) => {
    const fn =
      call.function && typeof call.function === "object"
        ? (call.function as Record<string, unknown>)
        : call;
    const name = typeof fn.name === "string" ? fn.name : typeof call.name === "string" ? call.name : "";
    return {
      function: {
        name,
        arguments: parseToolArguments(fn.arguments ?? call.arguments),
      },
    };
  });
}

function mapTools(tools: GatewayChatRequest["tools"]) {
  if (!tools) return undefined;
  return tools.flatMap((tool) => {
    const fn =
      tool.function && typeof tool.function === "object"
        ? (tool.function as Record<string, unknown>)
        : undefined;
    const name = typeof fn?.name === "string" ? fn.name : typeof tool.name === "string" ? tool.name : "";
    if (!name) return [];
    return [
      {
        type: "function",
        function: {
          name,
          ...(typeof fn?.description === "string" ? { description: fn.description } : {}),
          ...(fn?.parameters && typeof fn.parameters === "object" ? { parameters: fn.parameters } : {}),
        },
      },
    ];
  });
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

  const namesByCallId = new Map<string, string>();
  const messages = request.messages.map((message) => {
    const toolCalls = mapToolCalls(message.tool_calls);
    if (toolCalls) {
      for (const [index, call] of (message.tool_calls ?? []).entries()) {
        const id = typeof call.id === "string" ? call.id : undefined;
        const name = toolCalls[index]?.function.name;
        if (id && name) namesByCallId.set(id, name);
      }
    }
    const mapped: Record<string, unknown> = {
      role: message.role,
      ...mapContent(message),
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    };
    if (message.role === "tool") {
      const toolName =
        message.name ?? (message.tool_call_id ? namesByCallId.get(message.tool_call_id) : undefined);
      if (toolName) mapped.tool_name = toolName;
    }
    return mapped;
  });

  return {
    model: upstreamModel,
    messages,
    stream: request.stream,
    ...(request.tools ? { tools: mapTools(request.tools) } : {}),
    ...(request.response_format ? { format: mapResponseFormat(request.response_format) } : {}),
    ...(request.reasoning_effort && request.reasoning_effort !== "none"
      ? { think: request.reasoning_effort }
      : request.reasoning_effort === "none"
        ? { think: false }
        : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}
