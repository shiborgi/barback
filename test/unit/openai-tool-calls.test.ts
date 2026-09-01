import { describe, expect, test } from "bun:test";
import { openAiResponse, streamChunk } from "../../src/api/openai.ts";

const objectCall = {
  id: "call_d1qdgu2a",
  function: { index: 0, name: "skill", arguments: { name: "welcome" } },
};

describe("OpenAI tool_calls", () => {
  test("stringifies object arguments on complete responses", () => {
    const body = openAiResponse({
      id: "chatcmpl-1",
      model: "code-default",
      created: 1,
      content: "",
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, source: "provider" },
      toolCalls: [objectCall],
    });
    expect(body.choices[0]?.message.tool_calls).toEqual([
      {
        id: "call_d1qdgu2a",
        type: "function",
        function: { name: "skill", arguments: '{"name":"welcome"}' },
      },
    ]);
  });

  test("stringifies object arguments and sets index on stream chunks", () => {
    const chunk = streamChunk(
      {
        id: "chatcmpl-1",
        model: "code-default",
        created: 1,
        toolCalls: [objectCall],
      },
      false,
      false,
    );
    expect(chunk.choices[0]?.delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_d1qdgu2a",
        type: "function",
        function: { name: "skill", arguments: '{"name":"welcome"}' },
      },
    ]);
  });
});
