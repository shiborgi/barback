import { expect, test } from "bun:test";
import fc from "fast-check";
import { stableJson } from "../../src/cache/canonicalize.ts";

test("canonical JSON is invariant to object key insertion order", () => {
  fc.assert(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (object) => {
      const reversed = Object.fromEntries(Object.entries(object).reverse());
      expect(stableJson(object)).toBe(stableJson(reversed));
    }),
    { numRuns: 1000 },
  );
});
