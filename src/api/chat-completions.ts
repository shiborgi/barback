import { z } from "zod";
import { GatewayError } from "../core/errors.ts";
import type { GatewayChatRequest } from "../providers/provider.ts";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown())), z.null()]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
});

const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    stream: z.boolean().default(false),
    stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.record(z.string(), z.unknown()).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.int().positive().optional(),
    max_completion_tokens: z.int().positive().optional(),
    seed: z.int().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    reasoning_effort: z.enum(["none", "low", "medium", "high", "max"]).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    n: z.int().positive().optional(),
    logit_bias: z.unknown().optional(),
    user: z.string().optional(),
  })
  .loose();

export function parseChatRequest(value: unknown): GatewayChatRequest {
  const parsed = chatSchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      400,
      "validation_error",
      "invalid_request",
    );
  }
  return parsed.data as GatewayChatRequest;
}
