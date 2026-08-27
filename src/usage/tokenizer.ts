import type { GatewayChatRequest } from "../providers/provider.ts";

function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + textLength(item), 0);
  if (value && typeof value === "object") return JSON.stringify(value).length;
  return 0;
}

export function estimateInputTokens(request: GatewayChatRequest): number {
  const messageChars = request.messages.reduce(
    (total, message) => total + textLength(message.content) + 12,
    0,
  );
  const toolChars = textLength(request.tools);
  return Math.max(1, Math.ceil((messageChars + toolChars) / 4));
}
