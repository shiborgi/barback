import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { BarbackConfig } from "../config/schema.ts";

export async function startTelemetry(config: BarbackConfig["telemetry"]) {
  if (!config.otel.enabled || !config.otel.endpoint) return undefined;
  const sdk = new NodeSDK({
    serviceName: config.serviceName,
    traceExporter: new OTLPTraceExporter({ url: config.otel.endpoint }),
  });
  await sdk.start();
  return sdk;
}
