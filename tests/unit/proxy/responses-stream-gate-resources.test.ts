import { describe, expect, it } from "vitest";
import {
  runResponsesStreamContentGate,
  type ResponsesStreamGateCaps,
} from "@/app/v1/_lib/proxy/stream-gate/responses-content-gate";

const encoder = new TextEncoder();

const CAPS: ResponsesStreamGateCaps = {
  prebufferEventCap: 64,
  prebufferByteCap: 32 * 1024,
  requestEchoByteCap: 64 * 1024,
};

function frame(type: string, payload: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function retainedBytes(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

describe("Responses stream gate concurrent resource bound", () => {
  it.each([
    1, 2, 3,
  ])("holds a linear raw-prefix budget for %i simultaneous hedge attempts per request", async (attemptsPerRequest) => {
    const concurrentRequests = 4;
    const gateCount = attemptsPerRequest * concurrentRequests;
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    let prefixesConsumed = 0;
    let settledCount = 0;
    let releaseBarrier: (() => void) | null = null;
    const allPrefixesConsumed = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const gates = Array.from({ length: gateCount }, (_, index) => {
      const echo = frame("response.created", {
        response: {
          id: `response_${index}`,
          instructions: "e".repeat(CAPS.requestEchoByteCap - 2048),
          error: null,
        },
      });
      const neutral = frame("response.metadata", {
        metadata: { trace: `gate_${index}`, pad: "n".repeat(CAPS.prebufferByteCap - 2048) },
      });
      let chunksSeen = 0;
      const reader = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
          controller.enqueue(echo);
          controller.enqueue(neutral);
        },
      }).getReader();

      return runResponsesStreamContentGate(reader, {
        ...CAPS,
        onChunk() {
          chunksSeen += 1;
          if (chunksSeen !== 2) return;
          prefixesConsumed += 1;
          if (prefixesConsumed === gateCount) releaseBarrier?.();
        },
      }).finally(() => {
        settledCount += 1;
      });
    });

    await allPrefixesConsumed;
    expect(prefixesConsumed).toBe(gateCount);
    expect(settledCount).toBe(0);

    for (const controller of controllers) {
      controller.enqueue(
        frame("response.failed", {
          response: { error: { code: "server_is_overloaded", message: "overloaded" } },
        })
      );
      controller.close();
    }

    const results = await Promise.all(gates);
    expect(settledCount).toBe(gateCount);
    for (const result of results) {
      expect(result.committed).toBe(false);
      if (result.committed) continue;
      expect(result.reason).toBe("gate_error");
      expect(retainedBytes(result.prefixChunks)).toBeLessThanOrEqual(
        CAPS.prebufferByteCap + CAPS.requestEchoByteCap
      );
    }

    const aggregateRetainedBytes = results.reduce(
      (total, result) => total + retainedBytes(result.prefixChunks),
      0
    );
    expect(aggregateRetainedBytes).toBeLessThanOrEqual(
      concurrentRequests * attemptsPerRequest * (CAPS.prebufferByteCap + CAPS.requestEchoByteCap)
    );
  });
});
