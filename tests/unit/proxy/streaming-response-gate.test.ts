import { describe, expect, it, vi } from "vitest";
import { inspectStreamingResponsePrefix } from "@/app/v1/_lib/proxy/streaming-response-gate";

const encoder = new TextEncoder();

function responseFromChunks(chunks: string[], onCancel?: (reason: unknown) => void): Response {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

describe("inspectStreamingResponsePrefix", () => {
  it("detects a fragmented JSON fake 200 and cancels upstream", async () => {
    const onCancel = vi.fn();
    const response = responseFromChunks(
      ['{"error":{"message":"Our servers are currently ', 'overloaded. Please try again later."}}'],
      onCancel
    );

    const result = await inspectStreamingResponsePrefix(response);

    expect(result).toMatchObject({
      kind: "fake_200",
      code: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
      rawBodyTruncated: true,
    });
    expect(onCancel).toHaveBeenCalledWith("fake_200");
  });

  it("detects an SSE error event split across chunks", async () => {
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks([
        'event: error\ndata: {"error":{"code":"server_is_',
        'overloaded","message":"model overloaded"}}\n\n',
      ])
    );

    expect(result).toMatchObject({
      kind: "fake_200",
      code: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
    });
  });

  it("detects an SSE error event with a top-level message", async () => {
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks([
        "event: error\n",
        'data: {"message":"Our servers are currently overloaded. Please try again later."}\n\n',
      ])
    );

    expect(result).toMatchObject({
      kind: "fake_200",
      code: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
    });
  });

  it("holds Responses lifecycle events until a fragmented response.failed is classified", async () => {
    const onCancel = vi.fn();
    const onFirstUpstreamByte = vi.fn();
    const overloadMessage = "Our servers are currently overloaded. Please try again later.";
    const chunks = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.in_progress"}\n\n',
      'data: {"type":"response.failed","response":{"error":{"code":"server_is_',
      `overloaded","type":"service_unavailable_error","message":"${overloadMessage}"}}}\n\n`,
    ];

    const result = await inspectStreamingResponsePrefix(responseFromChunks(chunks, onCancel), {
      enableResponsesLifecycleGate: true,
      onFirstUpstreamByte,
    });

    expect(result).toMatchObject({
      kind: "fake_200",
      code: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
      rawBodyTruncated: true,
      diagnostic: {
        phase: "responses_pre_output_gate",
        observedEventTypes: ["response.created", "response.in_progress", "response.failed"],
        eventCountObserved: 3,
        upstreamErrorCode: "server_is_overloaded",
        upstreamErrorType: "service_unavailable_error",
        upstreamErrorMessageLength: overloadMessage.length,
      },
    });
    expect(onFirstUpstreamByte).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("fake_200");
  });

  it("replays a normal response byte-for-byte", async () => {
    const chunks = [
      ": keepalive\n\n",
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
    ];

    const result = await inspectStreamingResponsePrefix(responseFromChunks(chunks));
    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") throw new Error("expected pass");

    expect(await result.response.text()).toBe(chunks.join(""));
  });

  it("passes a Responses output event after held lifecycle events byte-for-byte", async () => {
    const onFirstUpstreamByte = vi.fn();
    const chunks = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
    ];

    const result = await inspectStreamingResponsePrefix(responseFromChunks(chunks), {
      enableResponsesLifecycleGate: true,
      onFirstUpstreamByte,
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") throw new Error("expected pass");
    expect(await result.response.text()).toBe(chunks.join(""));
    expect(onFirstUpstreamByte).toHaveBeenCalledTimes(1);
  });

  it("prefers data.type over a conflicting event header and passes output", async () => {
    const body = [
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.created\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
    ].join("");

    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") throw new Error("expected pass");
    expect(await result.response.text()).toBe(body);
  });

  it("passes terminal Responses events without retrying", async () => {
    const body = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"message"}]}}\n\n',
    ].join("");

    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") throw new Error("expected pass");
    expect(await result.response.text()).toBe(body);
  });

  it("waits past comment-only events for the first data event", async () => {
    const chunks = [
      ": keepalive\n\n",
      'data: {"error":{"message":"Our servers are currently overloaded"}}\n\n',
    ];

    await expect(inspectStreamingResponsePrefix(responseFromChunks(chunks))).resolves.toMatchObject(
      {
        kind: "fake_200",
      }
    );
  });

  it("checks an unterminated final SSE event at EOF", async () => {
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks(['data: {"error":{"code":"slow_down"}}'])
    );

    expect(result).toMatchObject({ kind: "fake_200" });
  });

  it("passes through after the inspection cap", async () => {
    const body = `data: ${"x".repeat(64)}`;
    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      maxBytes: 16,
    });
    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") throw new Error("expected pass");

    expect(await result.response.text()).toBe(body);
  });

  it("fails open with a diagnostic when held Responses lifecycle events reach the cap", async () => {
    const body = `data: {"type":"response.created","padding":"${"x".repeat(96)}"}\n\n`;
    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
      maxBytes: 32,
    });

    expect(result).toMatchObject({
      kind: "pass",
      diagnostic: {
        phase: "prefix_cap_fail_open",
        prefixCapBytes: 32,
        observedEventTypes: [],
        eventCountObserved: 0,
      },
    });
    if (result.kind !== "pass") throw new Error("expected pass");
    expect(await result.response.text()).toBe(body);
  });

  it("owns the idle timeout only while holding Responses lifecycle events", async () => {
    vi.useFakeTimers();
    try {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      const onIdle = vi.fn(() => controller?.error(new Error("streaming_idle")));
      const onFirstUpstreamByte = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
            streamController.enqueue(encoder.encode('data: {"type":"response.created"}\n\n'));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );

      const inspection = inspectStreamingResponsePrefix(response, {
        enableResponsesLifecycleGate: true,
        onFirstUpstreamByte,
        streamingIdleTimeoutMs: 50,
        onStreamingIdleTimeout: onIdle,
      });

      const expectedIdleFailure = expect(inspection).rejects.toThrow("streaming_idle");
      await vi.advanceTimersByTimeAsync(50);
      await expectedIdleFailure;
      expect(onFirstUpstreamByte).toHaveBeenCalledTimes(1);
      expect(onIdle).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates downstream cancellation after replay", async () => {
    const onCancel = vi.fn();
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks(['data: {"type":"response.created"}\n\n', "tail"], onCancel)
    );
    expect(result.kind).toBe("pass");
    if (result.kind !== "pass" || !result.response.body) throw new Error("expected body");

    await result.response.body.cancel("client_abort");
    expect(onCancel).toHaveBeenCalledWith("client_abort");
  });

  it("propagates an upstream abort while waiting for the first complete payload", async () => {
    const abortController = new AbortController();
    const abortReason = new Error("client_cancelled");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          abortController.signal.addEventListener(
            "abort",
            () => controller.error(abortController.signal.reason),
            { once: true }
          );
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

    const inspection = inspectStreamingResponsePrefix(response);
    abortController.abort(abortReason);

    await expect(inspection).rejects.toBe(abortReason);
  });
});
