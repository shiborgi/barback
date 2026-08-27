import type { GatepatrolConfig } from "../config/schema.ts";
import type { GatewayChatResponse } from "../providers/provider.ts";
import type { OperationalStore } from "../storage/valkey.ts";

export interface SemanticCandidate {
  id: string;
  score: number;
  response: GatewayChatResponse;
}

function vectorBuffer(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export class SemanticCache {
  readonly index: string;

  constructor(
    private readonly store: OperationalStore,
    private readonly prefix: string,
    private readonly dimensions: number,
    private readonly config: GatepatrolConfig["cache"]["semantic"],
  ) {
    this.index = `${prefix}-semantic-v1`;
  }

  async initialize(): Promise<void> {
    try {
      await this.store.command([
        "FT.CREATE",
        this.index,
        "ON",
        "HASH",
        "PREFIX",
        1,
        `${this.prefix}:cache:semantic:`,
        "SCHEMA",
        "partition",
        "TAG",
        "expires",
        "NUMERIC",
        "response",
        "STORED",
        "vector",
        "VECTOR",
        "HNSW",
        6,
        "TYPE",
        "FLOAT32",
        "DIM",
        this.dimensions,
        "DISTANCE_METRIC",
        "COSINE",
      ]);
    } catch (error) {
      if (!String(error).includes("Index already exists")) throw error;
    }
  }

  async lookup(partition: string, vector: number[]): Promise<SemanticCandidate | undefined> {
    try {
      const result = (await this.store.command([
        "FT.SEARCH",
        this.index,
        `(@partition:{${partition}} @expires:[${Date.now()} +inf])=>[KNN 1 @vector $query AS score]`,
        "PARAMS",
        2,
        "query",
        vectorBuffer(vector),
        "SORTBY",
        "score",
        "RETURN",
        2,
        "response",
        "score",
        "DIALECT",
        2,
      ])) as unknown[];
      if (!Array.isArray(result) || Number(result[0]) === 0) return undefined;
      const id = String(result[1]);
      const fields = result[2] as unknown[];
      const responseIndex = fields.indexOf("response");
      const scoreIndex = fields.indexOf("score");
      const score = Number(fields[scoreIndex + 1]);
      if (1 - score < this.config.threshold) return undefined;
      return {
        id,
        score: 1 - score,
        response: JSON.parse(String(fields[responseIndex + 1])) as GatewayChatResponse,
      };
    } catch {
      return undefined;
    }
  }

  async put(
    id: string,
    partition: string,
    vector: number[],
    response: GatewayChatResponse,
    ttlMs: number,
  ): Promise<void> {
    try {
      const key = `${this.prefix}:cache:semantic:${id}`;
      await this.store.command([
        "HSET",
        key,
        "partition",
        partition,
        "expires",
        Date.now() + ttlMs,
        "response",
        JSON.stringify(response),
        "vector",
        vectorBuffer(vector),
      ]);
      await this.store.command(["PEXPIRE", key, ttlMs]);
    } catch {
      // Semantic cache is always fail-open.
    }
  }

  async recordShadow(candidate: SemanticCandidate): Promise<void> {
    try {
      await this.store.command(["HINCRBY", `${this.prefix}:cache:semantic:stats`, "candidates", 1]);
      await this.store.command([
        "HSET",
        `${this.prefix}:cache:semantic:shadow:${crypto.randomUUID()}`,
        "candidate",
        candidate.id,
        "similarity",
        candidate.score,
        "classification",
        "not_evaluated",
      ]);
    } catch {
      // Metrics still record the candidate when Valkey metadata fails.
    }
  }

  async servingAllowed(): Promise<boolean> {
    if (this.config.mode !== "serving" || !this.config.servingApproved) return false;
    try {
      const raw = await this.store.command(["HGETALL", `${this.prefix}:cache:semantic:stats`]);
      const entries = raw as string[];
      const stats = Object.fromEntries(
        Array.from({ length: Math.ceil(entries.length / 2) }, (_, index) => [
          entries[index * 2],
          Number(entries[index * 2 + 1]),
        ]),
      );
      const evaluated = stats.evaluated ?? 0;
      const trueHits = stats.true_hits ?? 0;
      const falseHits = stats.false_hits ?? 0;
      const critical = stats.critical_false_hits ?? 0;
      return (
        evaluated >= this.config.servingCriteria.minimumCandidates &&
        trueHits / evaluated >= this.config.servingCriteria.minimumPrecision &&
        falseHits / evaluated <= this.config.servingCriteria.maximumFalseHitRate &&
        critical === 0
      );
    } catch {
      return false;
    }
  }
}
