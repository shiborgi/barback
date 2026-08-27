import type { ClientConfig, PolicyConfig } from "../config/schema.ts";

export interface RequestContext {
  requestId: string;
  traceId?: string;
  client: ClientConfig;
  policy: PolicyConfig;
  startedAt: number;
  signal: AbortSignal;
}

export type AppVariables = {
  requestId: string;
  requestContext: RequestContext;
};
