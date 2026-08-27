import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { type BarbackConfig, configSchema, isEnvReference } from "./schema.ts";

export class ConfigError extends Error {
  override name = "ConfigError";
}

function resolveEnvironment(value: unknown, env: Record<string, string | undefined>): unknown {
  if (isEnvReference(value)) {
    const name = value.slice(4);
    const resolved = env[name];
    if (resolved === undefined || resolved === "") {
      throw new ConfigError(`Missing environment variable at env:${name}`);
    }
    if (/^-?\d+(?:\.\d+)?$/.test(resolved)) return Number(resolved);
    if (resolved === "true" || resolved === "false") return resolved === "true";
    return resolved;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveEnvironment(entry, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveEnvironment(entry, env)]),
    );
  }
  return value;
}

export async function loadConfig(
  path = process.env.BARBACK_CONFIG ?? "barback.yaml",
  env: Record<string, string | undefined> = process.env,
): Promise<BarbackConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(
      `Cannot read configuration ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const raw = parse(source, { maxAliasCount: 0 });
    return configSchema.parse(resolveEnvironment(raw, env));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (error && typeof error === "object" && "issues" in error) {
      const issues = (error as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
      throw new ConfigError(
        issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; "),
      );
    }
    throw new ConfigError(
      `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export class ConfigStore {
  #current: BarbackConfig;
  readonly path: string;

  constructor(config: BarbackConfig, path = process.env.BARBACK_CONFIG ?? "barback.yaml") {
    this.#current = config;
    this.path = path;
  }

  get(): BarbackConfig {
    return this.#current;
  }

  replace(next: BarbackConfig): void {
    this.#current = next;
  }

  async reload(): Promise<BarbackConfig> {
    const next = await loadConfig(this.path);
    this.#current = next;
    return next;
  }
}
