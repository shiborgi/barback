import { createHash } from "node:crypto";
import type { GatewayChatRequest } from "../providers/provider.ts";
import { stableJson } from "./canonicalize.ts";

export const CANONICALIZATION_VERSION = 1;

export interface ExactCacheIdentity {
  canonicalizationVersion: number;
  client: string;
  namespace: string;
  provider: string;
  model: string;
  request: GatewayChatRequest;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function exactCacheId(
  identity: Omit<ExactCacheIdentity, "canonicalizationVersion">,
): string {
  return sha256(stableJson({ canonicalizationVersion: CANONICALIZATION_VERSION, ...identity }));
}

export function semanticPartition(value: unknown): string {
  return sha256(stableJson(value));
}
