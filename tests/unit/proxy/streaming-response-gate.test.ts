import { describe, expect, it, vi } from "vitest";
import {
  consumeStreamingResponseCommitMarker,
  inspectStreamingResponsePrefix,
} from "@/app/v1/_lib/proxy/streaming-response-gate";

const encoder = new TextEncoder();

function responseFromChunks(
  chunks: string[],
  onCancel?: (reason: unknown) => void,
  extraHeaders: Record<string, string> = {}
): Response {
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
    {
      status: 200,
      headers: { "content-type": "text/event-stream", ...extraHeaders },
    }
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
      `overloaded","type":"service_unavailable_error","message":"${overloadMessage}"},"instructions":"private prompt","output":[{"text":"partial output"}]}}\n\n`,
    ];

    const result = await inspectStreamingResponsePrefix(responseFromChunks(chunks, onCancel), {
      enableResponsesLifecycleGate: true,
      onFirstUpstreamByte,
    });

    expect(result).toMatchObject({
      kind: "fake_200",
      code: "FAKE_200_JSON_ERROR_NON_EMPTY",
      rawBodyTruncated: true,
      diagnostic: {
        phase: "responses_semantic_gate",
        observedEventTypes: ["response.created", "response.in_progress", "response.failed"],
        eventCountObserved: 3,
        upstreamErrorCode: "server_is_overloaded",
        upstreamErrorType: "service_unavailable_error",
        upstreamErrorMessageLength: overloadMessage.length,
      },
    });
    expect(onFirstUpstreamByte).toHaveBeenCalledTimes(1);
    if (result.kind !== "fake_200") return;
    expect(JSON.parse(result.rawText)).toMatchObject({
      error: { code: "server_is_overloaded", type: "service_unavailable_error" },
    });
    expect(result.detail).toBeUndefined();
    expect(result.rawText).not.toContain("private prompt");
    expect(result.rawText).not.toContain("partial output");
    expect(result.rawText).not.toContain(overloadMessage);
    // The source may already be closed by Web Streams pull-ahead; the Forwarder integration
    // test covers cancellation while the failed upstream remains open.
  });

  it("preserves overload classification for a large error frame through a bounded envelope", async () => {
    const body = `data: ${JSON.stringify({
      type: "response.failed",
      response: {
        error: {
          code: "server_is_overloaded",
          type: "service_unavailable_error",
          message: "Our servers are currently overloaded. Please try again later.",
        },
      },
      padding: "x".repeat(70 * 1024),
    })}\n\n`;

    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
    });

    expect(result).toMatchObject({
      kind: "fake_200",
      rawBodyTruncated: true,
      diagnostic: {
        phase: "responses_semantic_gate",
        upstreamErrorCode: "server_is_overloaded",
        upstreamErrorType: "service_unavailable_error",
      },
    });
    if (result.kind !== "fake_200") return;
    expect(JSON.parse(result.rawText)).toMatchObject({
      error: { code: "server_is_overloaded", type: "service_unavailable_error" },
    });
    expect(result.detail).toBeUndefined();
    expect(result.rawText.length).toBeLessThan(64 * 1024);
    expect(result.rawText).not.toContain("x".repeat(1024));
    expect(result.rawText).not.toContain("Our servers are currently overloaded");
  });

  it("normalizes an event-header-only structured error into the bounded detector envelope", async () => {
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks([
        'event: response.failed\ndata: {"code":"server_is_overloaded","message":"overloaded"}\n\n',
      ]),
      { enableResponsesLifecycleGate: true }
    );

    expect(result).toMatchObject({
      kind: "fake_200",
      rawBodyTruncated: true,
      diagnostic: { upstreamErrorCode: "server_is_overloaded" },
    });
    if (result.kind !== "fake_200") return;
    expect(JSON.parse(result.rawText)).toMatchObject({
      error: { code: "server_is_overloaded" },
    });
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

  it("fails closed when Responses terminates before semantic content", async () => {
    const body = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.completed","response":{"output":[{"type":"message"}]}}\n\n',
    ].join("");

    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
    });

    expect(result).toMatchObject({
      kind: "upstream_failure",
      reason: "empty_stream",
      diagnostic: { phase: "responses_semantic_gate" },
    });
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

  it("fails closed with a diagnostic when the Responses gate reaches its byte cap", async () => {
    const body = `data: {"type":"response.created","padding":"${"x".repeat(96)}"}\n\n`;
    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
      responsesGateCaps: {
        prebufferEventCap: 64,
        prebufferByteCap: 32,
        requestEchoByteCap: 32,
      },
    });

    expect(result).toMatchObject({
      kind: "upstream_failure",
      reason: "byte_overflow",
      diagnostic: {
        phase: "responses_semantic_gate",
        prefixCapBytes: 64,
      },
    });
  });

  it("keeps the old release behavior in off mode", async () => {
    const body = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"f"}}\n\n',
      'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}\n\n',
    ].join("");
    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
      responsesGateMode: "off",
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    expect(await result.response.text()).toBe(body);
    expect(result.commitMarker).toBeUndefined();
  });

  it("reports the old/new divergence without failover in shadow mode", async () => {
    const onCancel = vi.fn();
    const onShadowDiagnostic = vi.fn();
    const body = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"f"}}\n\n',
      'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}\n\n',
    ].join("");
    const result = await inspectStreamingResponsePrefix(responseFromChunks([body], onCancel), {
      enableResponsesLifecycleGate: true,
      responsesGateMode: "shadow",
      onResponsesShadowDiagnostic: onShadowDiagnostic,
    });

    expect(result).toMatchObject({
      kind: "pass",
      commitMarker: {
        verdict: "shadow_pass",
        eventType: "response.output_item.added",
        frameIndex: 2,
      },
    });
    if (result.kind !== "pass") return;
    expect(await result.response.text()).toBe(body);
    expect(onShadowDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "shadow",
        outcome: "gate_error",
        divergentFromLegacy: true,
        marker: expect.objectContaining({
          verdict: "shadow_pass",
          eventType: "response.output_item.added",
          frameIndex: 2,
        }),
      })
    );
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("bounds an unknown legacy event type in the shadow commit marker", async () => {
    const eventType = `response.future.${"x".repeat(256)}`;
    const body = `data: ${JSON.stringify({ type: eventType, metadata: { trace: "x" } })}\n\n`;
    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
      responsesGateMode: "shadow",
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    expect(result.commitMarker?.eventType).toHaveLength(128);
    expect(result.commitMarker?.eventType).toBe(eventType.slice(0, 128));
    await result.response.body?.cancel("test_complete");
  });

  it("keeps a fragmented large request echo exempt in the shadow observer", async () => {
    const onShadowDiagnostic = vi.fn();
    const echo = `data: ${JSON.stringify({
      type: "response.created",
      response: { instructions: "x".repeat(4096), error: null },
    })}\n\n`;
    const chunks = [
      echo.slice(0, 900),
      echo.slice(900),
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"f"}}\n\n',
      'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}\n\n',
    ];
    const result = await inspectStreamingResponsePrefix(responseFromChunks(chunks), {
      enableResponsesLifecycleGate: true,
      responsesGateMode: "shadow",
      responsesGateCaps: {
        prebufferEventCap: 16,
        prebufferByteCap: 1024,
        requestEchoByteCap: 8192,
      },
      onResponsesShadowDiagnostic: onShadowDiagnostic,
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    expect(await result.response.text()).toBe(chunks.join(""));
    expect(onShadowDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "gate_error",
        echoExcludedBytes: expect.any(Number),
      })
    );
    expect(onShadowDiagnostic.mock.calls[0]?.[0].echoExcludedBytes).toBeGreaterThan(1024);
  });

  it("makes the shadow observer report the same combined transport-chunk overflow", async () => {
    const onShadowDiagnostic = vi.fn();
    const body = [
      'data: {"type":"response.created"}\n\n',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"f"}}\n\n',
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "x".repeat(256),
      })}\n\n`,
    ].join("");
    const result = await inspectStreamingResponsePrefix(responseFromChunks([body]), {
      enableResponsesLifecycleGate: true,
      responsesGateMode: "shadow",
      responsesGateCaps: {
        prebufferEventCap: 16,
        prebufferByteCap: 64,
        requestEchoByteCap: 64,
      },
      onResponsesShadowDiagnostic: onShadowDiagnostic,
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    expect(await result.response.text()).toBe(body);
    expect(onShadowDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "byte_overflow" })
    );
  });

  it("releases the legacy prefix in shadow mode without waiting for a later semantic decision", async () => {
    const onShadowDiagnostic = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          streamController.enqueue(
            encoder.encode(
              [
                'data: {"type":"response.created"}\n\n',
                'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"f"}}\n\n',
              ].join("")
            )
          );
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

    const result = await inspectStreamingResponsePrefix(response, {
      enableResponsesLifecycleGate: true,
      responsesGateMode: "shadow",
      onResponsesShadowDiagnostic: onShadowDiagnostic,
    });

    expect(result).toMatchObject({
      kind: "pass",
      commitMarker: { eventType: "response.output_item.added", frameIndex: 2 },
    });
    expect(onShadowDiagnostic).not.toHaveBeenCalled();
    if (result.kind !== "pass" || !result.response.body) return;
    await result.response.body.cancel("test_complete");
  });

  it("associates a fixed-shape marker only with the committed response", async () => {
    const secretPayload = "must-not-appear-in-marker";
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks([
        'data: {"type":"response.created"}\n\n',
        `data: {"type":"response.output_text.delta","delta":"${secretPayload}"}\n\n`,
      ]),
      { enableResponsesLifecycleGate: true }
    );
    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;

    const marker = consumeStreamingResponseCommitMarker(result.response);
    expect(marker).toEqual({
      verdict: "content",
      eventType: "response.output_text.delta",
      frameIndex: 2,
      chunkIndex: 2,
      bufferedBytes: expect.any(Number),
      echoExcludedBytes: expect.any(Number),
    });
    expect(JSON.stringify(marker)).not.toContain(secretPayload);
    expect(consumeStreamingResponseCommitMarker(result.response)).toBeNull();
  });

  it("applies identical precommit semantics to WebSocket-adapter SSE responses", async () => {
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks(
        [
          'data: {"type":"response.created"}\n\n',
          'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"f"}}\n\n',
          'data: {"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}\n\n',
        ],
        undefined,
        { "x-cch-upstream-transport": "websocket" }
      ),
      { enableResponsesLifecycleGate: true }
    );

    expect(result).toMatchObject({
      kind: "fake_200",
      diagnostic: {
        phase: "responses_semantic_gate",
        observedEventTypes: ["response.created", "response.output_item.added", "response.failed"],
      },
    });
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
