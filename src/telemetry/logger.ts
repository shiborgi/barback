const REDACTED_KEYS = /authorization|api[-_]?key|token|cookie|secret|password/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      REDACTED_KEYS.test(key) ? "[REDACTED]" : redact(entry),
    ]),
  );
}

export class Logger {
  constructor(private readonly level: "debug" | "info" | "warn" | "error" = "info") {}

  #write(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ) {
    const ranks = { debug: 0, info: 1, warn: 2, error: 3 };
    if (ranks[level] < ranks[this.level]) return;
    const line = JSON.stringify(
      redact({ timestamp: new Date().toISOString(), level, event, ...fields }),
    );
    if (level === "error") console.error(line);
    else console.log(line);
  }

  debug(event: string, fields?: Record<string, unknown>) {
    this.#write("debug", event, fields);
  }
  info(event: string, fields?: Record<string, unknown>) {
    this.#write("info", event, fields);
  }
  warn(event: string, fields?: Record<string, unknown>) {
    this.#write("warn", event, fields);
  }
  error(event: string, fields?: Record<string, unknown>) {
    this.#write("error", event, fields);
  }
}
