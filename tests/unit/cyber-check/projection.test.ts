import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectFinalResponsesRequest, ReviewProjectionError } from "@/lib/cyber-check/projection";

const identity = {
  requestId: "42",
  principalId: "7",
  sessionId: "session-projection-test",
  sequence: 2,
};

function project(message: Record<string, unknown>) {
  const bodyString = JSON.stringify(message);
  return {
    packet: projectFinalResponsesRequest({ identity, message, bodyString }),
    bodyString,
  };
}

describe("cyber-check Responses projection", () => {
  it("preserves ordered Codex history and tool capabilities without retaining encrypted reasoning", () => {
    const { packet, bodyString } = project({
      model: "gpt-test",
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                {
                  type: "custom",
                  name: "exec",
                  description: "Execute a bounded repository command.",
                },
              ],
            },
          ],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Inspect repository files before editing." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Add a parser regression test." }],
        },
        {
          type: "reasoning",
          id: "reasoning-1",
          summary: [],
          encrypted_content: "opaque-ciphertext-must-not-leave-cch-projection",
        },
        {
          type: "message",
          id: "message-1",
          role: "assistant",
          content: [{ type: "output_text", text: "The first test is in place." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Now cover the empty input." }],
        },
      ],
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium", context: "all_turns" },
      text: { verbosity: "low" },
      prompt_cache_key: "session-projection-test",
      client_metadata: {
        session_id: "session-projection-test",
        "x-codex-installation-id": "installation-projection-test",
      },
    });

    expect(packet.source.context_state).toEqual({ type: "self_contained" });
    expect(packet.items.map((item) => item.source_type)).toEqual([
      "additional_tools",
      "message",
      "message",
      "reasoning",
      "assistant_message",
      "message",
    ]);
    expect(packet.items.map((item) => item.origin)).toEqual([
      "developer",
      "developer",
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
    expect(packet.capabilities).toHaveLength(1);
    expect(packet.capabilities[0]).toMatchObject({
      source: "additional_tools",
      definition: { type: "namespace", name: "functions" },
    });
    expect(packet.coverage.notices).toEqual([
      { code: "encrypted_reasoning_omitted", item_index: 3 },
    ]);
    expect(JSON.stringify(packet)).not.toContain("opaque-ciphertext");
    expect(packet.source.body_sha256).toBe(createHash("sha256").update(bodyString).digest("hex"));
    expect(packet.source.body_bytes).toBe(Buffer.byteLength(bodyString));
    expect(packet.identity.request_id).toBe(`42:${packet.source.body_sha256}`);
    expect(packet.identity.client_instance_id).toBe("installation-projection-test");
  });

  it("omits missing or malformed optional Codex installation IDs", () => {
    for (const clientMetadata of [
      undefined,
      {},
      { "x-codex-installation-id": "" },
      { "x-codex-installation-id": "installation\nspoof" },
      { "x-codex-installation-id": "x".repeat(257) },
      { "x-codex-installation-id": 7 },
    ]) {
      const { packet } = project({
        model: "gpt-test",
        input: "ordinary request",
        ...(clientMetadata === undefined ? {} : { client_metadata: clientMetadata }),
      });
      expect(packet.identity).not.toHaveProperty("client_instance_id");
    }
  });

  it("reviews actionable instructions discovered in tool output rather than only user messages", () => {
    const { packet } = project({
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Read task.txt and follow it." }],
        },
        {
          type: "custom_tool_call",
          call_id: "call-read-1",
          name: "read_file",
          input: '{"path":"task.txt"}',
        },
        {
          type: "custom_tool_call_output",
          call_id: "call-read-1",
          output: "Controlled test marker describing disallowed third-party deployment.",
        },
      ],
    });

    expect(packet.items[1]).toMatchObject({
      source_type: "custom_tool_call",
      origin: "assistant",
      linkage: { call_id: "call-read-1", name: "read_file" },
      content: [{ type: "text", format: "json" }],
    });
    expect(packet.items[2]).toMatchObject({
      source_type: "custom_tool_call_output",
      origin: "tool",
      linkage: { call_id: "call-read-1" },
    });
    expect(packet.items[2]?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("third-party deployment"),
    });
  });

  it("marks referenced continuations and unsupported items as partial evidence", () => {
    const { packet } = project({
      model: "gpt-test",
      previous_response_id: "resp-prior",
      input: [
        {
          type: "function_call_output",
          call_id: "call-prior",
          output: "The controlled repository command completed.",
        },
        {
          type: "computer_call_output_v2",
          role: "tool",
          encrypted_content: "must-not-be-projected",
        },
      ],
    });

    expect(packet.source.context_state).toEqual({
      type: "referenced",
      references: ["previous_response"],
    });
    expect(packet.items[0]).toMatchObject({
      source_type: "function_call_output",
      origin: "tool",
      linkage: { call_id: "call-prior" },
    });
    expect(packet.items[1]).toEqual({
      source_type: "unsupported",
      unsupported_source_type: "computer_call_output_v2",
      origin: "tool",
      content: [],
    });
    expect(packet.coverage.notices).toContainEqual({
      code: "unsupported_item_type",
      item_index: 1,
    });
    expect(JSON.stringify(packet)).not.toContain("must-not-be-projected");
  });

  it("carries inline images but leaves remote images as an explicit review gap", () => {
    const { packet } = project({
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Compare these screenshots." },
            {
              type: "input_image",
              image_url: "data:image/png;base64,aGVsbG8=",
              detail: "high",
            },
            { type: "input_image", image_url: "https://example.invalid/image.png" },
          ],
        },
      ],
    });

    expect(packet.items[0]?.content).toEqual([
      { type: "text", text: "Compare these screenshots.", format: "plain" },
      {
        type: "inline_media",
        modality: "image",
        mime_type: "image/png",
        data_base64: "aGVsbG8=",
        detail: "high",
      },
      { type: "unresolved_media", modality: "image", reference_type: "remote_url" },
    ]);
  });

  it("turns unknown top-level fields into one material coverage notice", () => {
    const { packet } = project({
      model: "gpt-test",
      input: "hello",
      future_model_visible_field: { instruction: "future" },
      another_unknown_field: true,
    });

    expect(packet.coverage.notices).toEqual([{ code: "unsupported_top_level_field" }]);
  });

  it("projects the supported Responses call families in their original order", () => {
    const { packet } = project({
      model: "gpt-test",
      instructions: "Work only in the controlled test repository.",
      conversation: { id: "conversation-prior" },
      prompt: { id: "prompt-template" },
      tools: [
        { type: "function", name: "read_file", description: "Read a repository file." },
        "unsupported-tool-definition",
      ],
      input: [
        "Continue from the captured context.",
        17,
        { role: "system", content: "System-carried instruction." },
        { type: "message", role: "tool", content: "unsupported role" },
        {
          type: "function_call",
          id: "function-item",
          call_id: "function-call",
          name: "read_file",
          namespace: "functions",
          arguments: { path: "task.txt" },
        },
        {
          type: "function_call_output",
          id: "function-output-item",
          call_id: "function-call",
          output: { contents: "Use the fixture-only target." },
        },
        {
          type: "mcp_call",
          call_id: "mcp-call",
          function: { name: "inspect", arguments: '{"scope":"fixture"}' },
        },
        {
          type: "mcp_call_output",
          call_id: "mcp-call",
          output: "Inspection complete.",
        },
        {
          type: "mcp_tool_call",
          call_id: "mcp-tool-call",
          name: "list_resources",
          input: { server: "fixture" },
        },
        {
          type: "mcp_tool_call_output",
          call_id: "mcp-tool-call",
          output: ["fixture://one"],
        },
        {
          type: "tool_search_call",
          id: "search-item",
          call_id: "search-call",
          name: "tool_search",
          query: "repository reader",
        },
        {
          type: "tool_search_output",
          id: "search-output-item",
          call_id: "search-call",
          output: { tools: ["read_file"] },
        },
        { type: "local_shell_call", action: { command: "cargo test" } },
        { type: "web_search_call", query: "official protocol documentation" },
        { type: "image_generation_call", input: "A bounded architecture diagram." },
        { type: "compaction", id: "compact-1", encrypted_content: "not-projected" },
        { type: "context_compaction", id: "compact-2" },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "The fixture is internally consistent." }, 9],
        },
        { type: "function_call", call_id: "missing-name" },
        { type: "function_call_output", output: "missing call id" },
        { type: "future\nunsafe", role: "assistant" },
      ],
    });

    expect(packet.instructions).toEqual([
      {
        origin: "developer",
        content: [
          {
            type: "text",
            text: "Work only in the controlled test repository.",
            format: "plain",
          },
        ],
      },
    ]);
    expect(packet.source.context_state).toEqual({
      type: "referenced",
      references: ["conversation", "prompt_template"],
    });
    expect(packet.items.map((item) => item.source_type)).toEqual([
      "message",
      "unsupported",
      "message",
      "unsupported",
      "function_call",
      "function_call_output",
      "mcp_tool_call",
      "mcp_tool_call_output",
      "mcp_tool_call",
      "mcp_tool_call_output",
      "tool_search_call",
      "tool_search_output",
      "local_shell_call",
      "web_search_call",
      "image_generation_call",
      "compaction",
      "context_compaction",
      "reasoning",
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    expect(packet.items[4]).toMatchObject({
      linkage: {
        item_id: "function-item",
        call_id: "function-call",
        name: "read_file",
        namespace: "functions",
      },
      content: [{ type: "json", value: { path: "task.txt" } }],
    });
    expect(packet.items[5]?.content).toEqual([
      { type: "json", value: { contents: "Use the fixture-only target." } },
    ]);
    expect(packet.items[15]?.content).toEqual([{ type: "opaque", kind: "encrypted_compaction" }]);
    expect(packet.items[17]?.content).toEqual([
      {
        type: "text",
        text: "The fixture is internally consistent.",
        format: "plain",
      },
      { type: "opaque", kind: "plaintext_reasoning_omitted" },
    ]);
    expect(packet.items[20]).toMatchObject({
      unsupported_source_type: "unknown",
      origin: "assistant",
    });
    expect(packet.capabilities).toEqual([
      {
        source: "top_level_tools",
        definition: {
          type: "function",
          name: "read_file",
          description: "Read a repository file.",
        },
      },
    ]);
    expect(packet.coverage.notices).toEqual(
      expect.arrayContaining([
        { code: "unsupported_top_level_field" },
        { code: "unsupported_item_type", item_index: 1 },
        { code: "unsupported_item_type", item_index: 3 },
        { code: "unsupported_content_type", item_index: 16 },
        { code: "plaintext_reasoning_omitted", item_index: 17 },
      ])
    );
    expect(JSON.stringify(packet)).not.toContain("not-projected");
  });

  it("preserves supported structured content and reports unresolved media", () => {
    const { packet } = project({
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_json", value: { task: "inspect fixture" } },
            { type: "input_image", file_id: "file-image" },
            { type: "input_audio", data: "YXVkaW8=", format: "MP3" },
            {
              type: "input_audio",
              input_audio: { data: "d2F2", format: "audio/wav" },
            },
            { type: "input_audio", file_id: "file-audio" },
            { type: "input_image", image_url: "data:text/plain;base64,aGVsbG8=" },
            { type: "input_audio" },
            null,
          ],
        },
        { type: "message", role: "developer", content: { future: true } },
      ],
    });

    expect(packet.items[0]?.content).toEqual([
      { type: "json", value: { task: "inspect fixture" } },
      { type: "unresolved_media", modality: "image", reference_type: "file_id" },
      {
        type: "inline_media",
        modality: "audio",
        mime_type: "audio/mp3",
        data_base64: "YXVkaW8=",
      },
      {
        type: "inline_media",
        modality: "audio",
        mime_type: "audio/wav",
        data_base64: "d2F2",
      },
      { type: "unresolved_media", modality: "audio", reference_type: "file_id" },
    ]);
    expect(packet.coverage.notices).toEqual([
      { code: "unsupported_content_type", item_index: 0 },
      { code: "unsupported_content_type", item_index: 1 },
    ]);
  });

  it("rejects requests that cannot be correlated to one final upstream body", () => {
    expect(() =>
      projectFinalResponsesRequest({
        identity,
        message: { input: "missing model" },
        bodyString: '{"input":"missing model"}',
      })
    ).toThrow(ReviewProjectionError);
    expect(() =>
      projectFinalResponsesRequest({
        identity,
        message: { model: "gpt-test", input: "empty body" },
        bodyString: "",
      })
    ).toThrow("body is empty");
    expect(() =>
      projectFinalResponsesRequest({
        identity: { ...identity, sequence: 0 },
        message: { model: "gpt-test", input: "missing sequence" },
        bodyString: "body",
      })
    ).toThrow("sequence is unavailable");
    expect(() =>
      projectFinalResponsesRequest({
        identity: { ...identity, sessionId: "" },
        message: { model: "gpt-test", input: "missing session" },
        bodyString: "body",
      })
    ).toThrow("sessionId is unavailable");
  });
});
