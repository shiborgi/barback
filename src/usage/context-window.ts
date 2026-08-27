import type { GatepatrolConfig, ModelConfig, PolicyConfig } from "../config/schema.ts";
import { GatewayError } from "../core/errors.ts";
import type { GatewayChatRequest } from "../providers/provider.ts";
import { estimateInputTokens } from "./tokenizer.ts";

export interface ContextPressure {
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  predictedUtilization: number;
  status: "ok" | "warning" | "compact";
}

export function checkContextWindow(
  request: GatewayChatRequest,
  model: ModelConfig,
  policy: PolicyConfig,
  thresholds: GatepatrolConfig["contextWindow"],
): ContextPressure {
  if (!model.contextWindow || !model.maxOutput) {
    throw new GatewayError(
      "Model has no context contract",
      500,
      "internal_error",
      "invalid_model_contract",
    );
  }
  const estimatedInputTokens = estimateInputTokens(request);
  const requested = request.max_completion_tokens ?? request.max_tokens ?? model.maxOutput;
  const reservedOutputTokens = Math.min(
    requested,
    policy.maxOutput ?? model.maxOutput,
    model.maxOutput,
  );
  const predictedUtilization = (estimatedInputTokens + reservedOutputTokens) / model.contextWindow;
  if (predictedUtilization >= thresholds.rejectThreshold) {
    throw new GatewayError(
      `Context window would be exceeded (${estimatedInputTokens} input + ${reservedOutputTokens} reserved of ${model.contextWindow})`,
      400,
      "context_window_error",
      "context_window_rejected",
      "messages",
    );
  }
  return {
    estimatedInputTokens,
    reservedOutputTokens,
    predictedUtilization,
    status:
      predictedUtilization >= thresholds.compactThreshold
        ? "compact"
        : predictedUtilization >= thresholds.warningThreshold
          ? "warning"
          : "ok",
  };
}
