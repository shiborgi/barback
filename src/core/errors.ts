export type GatewayErrorType =
  | "authentication_error"
  | "authorization_error"
  | "validation_error"
  | "model_not_found_error"
  | "context_window_error"
  | "budget_exceeded_error"
  | "rate_limit_error"
  | "provider_error"
  | "provider_timeout_error"
  | "provider_unavailable_error"
  | "mcp_error"
  | "internal_error";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: GatewayErrorType,
    readonly code: string,
    readonly param?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GatewayError";
  }

  body(requestId: string) {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
        ...(this.param ? { param: this.param } : {}),
        request_id: requestId,
      },
    };
  }
}

export function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new GatewayError(
      "Request timed out",
      504,
      "provider_timeout_error",
      "provider_timeout",
      undefined,
      { cause: error },
    );
  }
  return new GatewayError(
    "Internal gateway error",
    500,
    "internal_error",
    "internal_error",
    undefined,
    { cause: error },
  );
}
