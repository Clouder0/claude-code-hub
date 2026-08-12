import { describe, expect, it } from "vitest";
import {
  classifyResponsesFrame,
  isResponsesRequestEchoFrame,
} from "@/app/v1/_lib/proxy/stream-gate/responses-frame-classifier";

describe("classifyResponsesFrame", () => {
  it.each([
    ["response.created", { type: "response.created", response: { error: null } }],
    ["response.metadata", { type: "response.metadata", metadata: { trace: "x" } }],
    [
      "response.output_item.added",
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "call_1", name: "read_file", status: "in_progress" },
      },
    ],
    [
      "response.content_part.added",
      { type: "response.content_part.added", part: { type: "output_text", text: "" } },
    ],
    ["response.future.lifecycle", { type: "response.future.lifecycle", sequence_number: 4 }],
  ])("keeps structural event %s neutral", (eventName, payload) => {
    expect(classifyResponsesFrame(eventName, JSON.stringify(payload))).toEqual({
      verdict: "neutral",
      eventType: eventName,
    });
  });

  it.each([
    ["response.output_text.delta", { delta: "hello" }],
    ["response.reasoning_text.delta", { delta: "thinking" }],
    ["response.refusal.done", { refusal: "cannot comply" }],
    ["response.function_call_arguments.done", { arguments: "{}" }],
    ["response.custom_tool_call_input.done", { input: '{"path":"README.md"}' }],
    ["response.image_generation_call.partial_image", { partial_image_b64: "aGVsbG8=" }],
    ["response.content_part.added", { part: { type: "output_text", text: "hello" } }],
    [
      "response.output_item.done",
      { item: { type: "function_call", name: "read_file", arguments: "{}" } },
    ],
    [
      "response.output_item.done",
      {
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "refusal", refusal: "cannot comply" }],
        },
      },
    ],
    [
      "response.output_item.done",
      { item: { type: "image_generation_call", status: "completed", result: "aGVsbG8=" } },
    ],
  ])("commits non-empty content for %s", (eventName, payload) => {
    expect(
      classifyResponsesFrame(eventName, JSON.stringify({ type: eventName, ...payload }))
    ).toEqual({ verdict: "content", eventType: eventName });
  });

  it("commits compaction payloads in item and terminal response forms", () => {
    expect(
      classifyResponsesFrame(
        "response.output_item.done",
        JSON.stringify({
          type: "response.output_item.done",
          item: { type: "compaction", encrypted_content: "opaque-state" },
        })
      ).verdict
    ).toBe("content");
    expect(
      classifyResponsesFrame(
        "response.completed",
        JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{ type: "compaction", encrypted_content: "opaque-state" }],
          },
        })
      ).verdict
    ).toBe("content");
  });

  it("requires a non-empty string on an actual compaction item", () => {
    for (const encryptedContent of ["", true, 42, { opaque: true }]) {
      expect(
        classifyResponsesFrame(
          "response.completed",
          JSON.stringify({
            type: "response.completed",
            response: {
              output: [{ type: "compaction", encrypted_content: encryptedContent }],
            },
          })
        ).verdict
      ).toBe("terminal");
    }
    expect(
      classifyResponsesFrame(
        "response.completed",
        JSON.stringify({
          type: "response.completed",
          response: {
            output: [{ type: "reasoning", encrypted_content: "opaque-state" }],
          },
        })
      ).verdict
    ).toBe("terminal");
  });

  it("gives error precedence over content-like fields", () => {
    expect(
      classifyResponsesFrame(
        "response.output_text.delta",
        JSON.stringify({
          type: "response.output_text.delta",
          delta: "must not commit",
          error: { code: "server_is_overloaded", message: "overloaded" },
        })
      ).verdict
    ).toBe("error");
    expect(
      classifyResponsesFrame(
        "response.failed",
        JSON.stringify({
          type: "response.failed",
          response: { error: { code: "server_is_overloaded" } },
        })
      ).verdict
    ).toBe("error");
  });

  it("uses data.type over a conflicting event header", () => {
    expect(
      classifyResponsesFrame(
        "response.created",
        JSON.stringify({ type: "response.output_text.delta", delta: "hello" })
      )
    ).toEqual({ verdict: "content", eventType: "response.output_text.delta" });
  });

  it("distinguishes malformed, terminal, and unknown well-formed payloads", () => {
    expect(classifyResponsesFrame(null, "{broken").verdict).toBe("malformed");
    expect(classifyResponsesFrame(null, "[DONE]").verdict).toBe("terminal");
    expect(
      classifyResponsesFrame(
        "response.completed",
        JSON.stringify({ type: "response.completed", response: { output: [] } })
      ).verdict
    ).toBe("terminal");
    expect(classifyResponsesFrame(null, "[]").verdict).toBe("neutral");
  });
});

describe("isResponsesRequestEchoFrame", () => {
  it("recognizes lifecycle echoes by payload type or event fallback", () => {
    expect(isResponsesRequestEchoFrame(null, '{"type":"response.created","response":{}}')).toBe(
      true
    );
    expect(isResponsesRequestEchoFrame("response.in_progress", "{")).toBe(true);
    expect(
      isResponsesRequestEchoFrame(
        "response.created",
        '{"type":"response.output_text.delta","delta":"x"}'
      )
    ).toBe(false);
  });
});
