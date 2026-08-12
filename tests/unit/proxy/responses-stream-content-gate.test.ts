import { describe, expect, it, vi } from "vitest";
import {
  runResponsesStreamContentGate,
  type ResponsesStreamGateCaps,
} from "@/app/v1/_lib/proxy/stream-gate/responses-content-gate";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CAPS: ResponsesStreamGateCaps = {
  prebufferEventCap: 16,
  prebufferByteCap: 1024,
  requestEchoByteCap: 8192,
};

function frame(eventType: string, payload: Record<string, unknown> = {}): string {
  return `event: ${eventType}\ndata: ${JSON.stringify({ type: eventType, ...payload })}\n\n`;
}

function readerFromChunks(
  chunks: (string | Uint8Array)[],
  options?: { failAfter?: number; failWith?: Error }
): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options?.failAfter !== undefined && index >= options.failAfter) {
        controller.error(options.failWith ?? new Error("stream failed"));
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++];
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
  }).getReader();
}

function prefixText(chunks: Uint8Array[]): string {
  return chunks.map((chunk) => decoder.decode(chunk)).join("");
}

describe("runResponsesStreamContentGate", () => {
  it.each([
    [
      "metadata-only output item",
      frame("response.output_item.added", {
        item: { type: "function_call", id: "call_1", name: "read_file" },
      }),
    ],
    ["metadata event", frame("response.metadata", { metadata: { trace: "x" } })],
    [
      "empty content part",
      frame("response.content_part.added", { part: { type: "output_text", text: "" } }),
    ],
  ])("holds %s until a later failure", async (_name, structuralFrame) => {
    const result = await runResponsesStreamContentGate(
      readerFromChunks([
        frame("response.created", { response: { id: "r1", error: null } }),
        structuralFrame,
        frame("response.failed", {
          response: { error: { code: "server_is_overloaded", message: "overloaded" } },
        }),
      ]),
      CAPS
    );

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("gate_error");
    expect(result.frameData).toContain("server_is_overloaded");
    expect(result.diagnostic.framesSeen).toBe(3);
  });

  it("allows a separately bounded large request echo before failure", async () => {
    const echo = frame("response.created", {
      response: { id: "r1", instructions: "x".repeat(4096), error: null },
    });
    const result = await runResponsesStreamContentGate(
      readerFromChunks([
        echo,
        frame("response.failed", {
          response: { error: { code: "server_is_overloaded", message: "overloaded" } },
        }),
      ]),
      CAPS
    );

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("gate_error");
    expect(result.diagnostic.echoExcludedBytes).toBeGreaterThan(4096);
    expect(result.diagnostic.bufferedBytes).toBeGreaterThan(CAPS.prebufferByteCap);
  });

  it("preserves the request-echo exemption across arbitrary transport fragmentation", async () => {
    const echo = frame("response.created", {
      response: { id: "r1", instructions: "中文".repeat(1000), error: null },
    });
    const failed = frame("response.failed", {
      response: { error: { code: "server_is_overloaded", message: "overloaded" } },
    });
    const bytes = encoder.encode(echo + failed);
    const splitPoints = [127, 900, 2300, 5700, bytes.length - 64];
    const chunks: Uint8Array[] = [];
    let start = 0;
    for (const end of splitPoints) {
      chunks.push(bytes.slice(start, end));
      start = end;
    }
    chunks.push(bytes.slice(start));

    const result = await runResponsesStreamContentGate(readerFromChunks(chunks), CAPS);

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("gate_error");
    expect(result.frameData).toContain("server_is_overloaded");
    expect(result.diagnostic.echoExcludedBytes).toBeGreaterThan(CAPS.prebufferByteCap);
  });

  it("commits on real content with a fixed marker and byte-exact prefix", async () => {
    const chunks = [
      frame("response.created", { response: { id: "r1", error: null } }),
      frame("response.output_item.added", {
        item: { type: "message", id: "m1", status: "in_progress" },
      }),
      frame("response.output_text.delta", { delta: "hello" }),
      frame("response.completed", { response: { status: "completed", output: [] } }),
    ];
    const onFirstByte = vi.fn();
    const reader = readerFromChunks(chunks);
    const result = await runResponsesStreamContentGate(reader, { ...CAPS, onFirstByte });

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(prefixText(result.prefixChunks)).toBe(chunks.slice(0, 3).join(""));
    expect(result.commitMarker).toEqual({
      verdict: "content",
      eventType: "response.output_text.delta",
      frameIndex: 3,
      chunkIndex: 3,
      bufferedBytes: chunks
        .slice(0, 3)
        .reduce((sum, value) => sum + encoder.encode(value).length, 0),
      echoExcludedBytes: expect.any(Number),
    });
    expect(onFirstByte).toHaveBeenCalledTimes(1);
    const rest = await reader.read();
    expect(decoder.decode(rest.value)).toBe(chunks[3]);
  });

  it("does not let a later error in the same chunk undo a content commitment", async () => {
    const content = frame("response.output_text.delta", { delta: "visible" });
    const failed = frame("response.failed", {
      response: { error: { code: "server_is_overloaded" } },
    });
    const result = await runResponsesStreamContentGate(readerFromChunks([content + failed]), CAPS);

    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(prefixText(result.prefixChunks)).toBe(content + failed);
    expect(result.commitMarker.eventType).toBe("response.output_text.delta");
  });

  it.each([
    [
      "terminal before content",
      [frame("response.completed", { response: { output: [] } })],
      "empty_stream",
    ],
    [
      "EOF before content",
      [frame("response.created", { response: { error: null } })],
      "empty_stream",
    ],
    ["malformed JSON", ["data: {broken\n\n"], "decode_error"],
  ])("fails closed on %s", async (_name, chunks, reason) => {
    const result = await runResponsesStreamContentGate(readerFromChunks(chunks), CAPS);
    expect(result.committed).toBe(false);
    if (!result.committed) expect(result.reason).toBe(reason);
  });

  it("fails closed on event and byte overflow", async () => {
    const neutral = frame("response.metadata", { metadata: { trace: "x" } });
    const eventResult = await runResponsesStreamContentGate(readerFromChunks([neutral.repeat(3)]), {
      ...CAPS,
      prebufferEventCap: 2,
    });
    expect(eventResult.committed).toBe(false);
    if (!eventResult.committed) expect(eventResult.reason).toBe("event_overflow");

    const byteResult = await runResponsesStreamContentGate(
      readerFromChunks([frame("response.metadata", { pad: "x".repeat(2048) })]),
      { ...CAPS, prebufferByteCap: 256 }
    );
    expect(byteResult.committed).toBe(false);
    if (!byteResult.committed) expect(byteResult.reason).toBe("byte_overflow");
  });

  it("rejects a transport chunk before decoding when it exceeds the combined byte cap", async () => {
    const oversizedChunk =
      frame("response.created", {
        response: { instructions: "x".repeat(CAPS.requestEchoByteCap + CAPS.prebufferByteCap) },
      }) + frame("response.output_text.delta", { delta: "must-not-commit" });
    const result = await runResponsesStreamContentGate(readerFromChunks([oversizedChunk]), CAPS);

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("byte_overflow");
    expect(result.prefixChunks).toHaveLength(0);
    expect(result.diagnostic.bufferedBytes).toBeGreaterThan(
      CAPS.prebufferByteCap + CAPS.requestEchoByteCap
    );
  });

  it("does not let a later content frame bypass the combined cap", async () => {
    const echo = frame("response.created", {
      response: { instructions: "x".repeat(CAPS.requestEchoByteCap - 256) },
    });
    const content = frame("response.output_text.delta", {
      delta: "y".repeat(CAPS.prebufferByteCap + 256),
    });
    const result = await runResponsesStreamContentGate(readerFromChunks([echo, content]), CAPS);

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("byte_overflow");
    expect(prefixText(result.prefixChunks)).toBe(echo);
  });

  it("does not let same-chunk neutral frames bypass the ordinary cap before content", async () => {
    const neutralA = frame("response.metadata", { pad: "a".repeat(560) });
    const neutralB = frame("response.metadata", { pad: "b".repeat(560) });
    const content = frame("response.output_text.delta", { delta: "must-not-commit" });
    const result = await runResponsesStreamContentGate(
      readerFromChunks([neutralA + neutralB + content]),
      CAPS
    );

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("byte_overflow");
  });

  it("does not let a content frame beyond the event cap commit", async () => {
    const neutral = frame("response.metadata", { metadata: { trace: "x" } });
    const content = frame("response.output_text.delta", { delta: "must-not-commit" });
    const result = await runResponsesStreamContentGate(
      readerFromChunks([neutral + neutral + content]),
      { ...CAPS, prebufferEventCap: 2 }
    );

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("event_overflow");
  });

  it("keeps read errors distinguishable for timeout and client-abort ownership", async () => {
    const readError = new Error("streaming_idle");
    const result = await runResponsesStreamContentGate(
      readerFromChunks([frame("response.created")], { failAfter: 1, failWith: readError }),
      CAPS
    );
    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("read_error");
    expect(result.cause).toBe(readError);
  });

  it("normalizes a non-Error read rejection", async () => {
    const result = await runResponsesStreamContentGate(
      readerFromChunks([], { failAfter: 0, failWith: "transport failed" as unknown as Error }),
      CAPS
    );

    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.reason).toBe("read_error");
    expect(result.cause).toEqual(new Error("transport failed"));
  });

  it.each([
    ["invalid UTF-8 chunk", new Uint8Array([0xff, 0xfe])],
    ["incomplete UTF-8 tail", new Uint8Array([0xe2])],
  ])("fails closed on %s", async (_name, bytes) => {
    const result = await runResponsesStreamContentGate(readerFromChunks([bytes]), CAPS);

    expect(result.committed).toBe(false);
    if (!result.committed) expect(result.reason).toBe("decode_error");
  });

  it("rejects invalid direct cap options", async () => {
    const reader = readerFromChunks([]);
    await expect(
      runResponsesStreamContentGate(reader, { ...CAPS, prebufferEventCap: 0 })
    ).rejects.toThrow("prebufferEventCap must be a positive safe integer");

    const overflowReader = readerFromChunks([]);
    await expect(
      runResponsesStreamContentGate(overflowReader, {
        prebufferEventCap: 1,
        prebufferByteCap: Number.MAX_SAFE_INTEGER,
        requestEchoByteCap: 1,
      })
    ).rejects.toThrow("combined stream gate byte cap must be a safe integer");
  });

  it("is invariant to arbitrary byte fragmentation", async () => {
    const body =
      frame("response.created", { response: { error: null } }) +
      frame("response.output_text.delta", { delta: "中文" });
    const bytes = encoder.encode(body);
    for (const split of [1, 7, 31, 79, bytes.length - 1]) {
      const result = await runResponsesStreamContentGate(
        readerFromChunks([bytes.slice(0, split), bytes.slice(split)]),
        CAPS
      );
      expect(result.committed).toBe(true);
      if (result.committed) expect(prefixText(result.prefixChunks)).toBe(body);
    }
  });
});
