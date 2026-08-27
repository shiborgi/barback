import { expect, test } from "bun:test";
import { redact } from "../../src/telemetry/logger.ts";

test("redacts secrets recursively", () => {
  expect(
    redact({ Authorization: "Bearer secret", nested: { apiKey: "secret", safe: "ok" } }),
  ).toEqual({
    Authorization: "[REDACTED]",
    nested: { apiKey: "[REDACTED]", safe: "ok" },
  });
});
