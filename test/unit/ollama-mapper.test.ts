import { describe, expect, test } from "bun:test";
import { toOllamaRequest } from "../../src/providers/ollama-cloud/mapper.ts";
import type { GatewayChatRequest } from "../../src/providers/provider.ts";

const base: GatewayChatRequest = {
  model: "code-default",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

describe("toOllamaRequest tool mapping", () => {
  test("parses OpenAI string arguments into objects", () => {
    const body = toOllamaRequest(
      {
        ...base,
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
              },
            ],
          },
          { role: "tool", content: "11c", tool_call_id: "call_1" },
        ],
      },
      "glm-flash",
    );
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "get_weather", arguments: { city: "Tokyo" } } }],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      content: "11c",
      tool_name: "get_weather",
    });
  });

  test("strips extra OpenAI tool fields", () => {
    const body = toOllamaRequest(
      {
        ...base,
        tools: [
          {
            type: "function",
            strict: true,
            function: {
              name: "skill",
              description: "run a skill",
              parameters: { type: "object", properties: { name: { type: "string" } } },
              strict: true,
            },
          },
        ],
      },
      "glm-flash",
    );
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "skill",
          description: "run a skill",
          parameters: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    ]);
  });
});
