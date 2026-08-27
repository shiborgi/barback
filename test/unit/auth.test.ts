import { expect, test } from "bun:test";
import { authenticate, hasScope } from "../../src/auth/client-key.ts";
import { testConfig } from "../fixtures/config.ts";

test("authenticates bearer keys and enforces scopes", () => {
  const config = testConfig();
  expect(authenticate("Bearer wrong", config)).toBeUndefined();
  const client = authenticate("Bearer test-key", config);
  expect(client?.id).toBe("test");
  expect(client && hasScope(client, "llm:invoke")).toBe(true);
});
