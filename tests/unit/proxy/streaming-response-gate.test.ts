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
