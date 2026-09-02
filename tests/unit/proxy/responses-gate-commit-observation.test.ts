import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  logResponsesStreamGateCommitObservation,
  resetFake200SseDiagnosticLogRateLimitForTests,
} from "@/app/v1/_lib/proxy/fake-200-observability";
import { inspectStreamingResponsePrefix } from "@/app/v1/_lib/proxy/streaming-response-gate";

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: "info",
  },
}));

import { logger } from "@/lib/logger";

const encoder = new TextEncoder();

function responseFromChunks(chunks: string[]): Response {
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
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }
  );
}

function baseObservation(providerId: number) {
  return {
    providerId,
    providerName: `provider-${providerId}`,
    endpointId: null,
    framesSeen: 2,
    bufferedBytes: 128,
    echoExcludedBytes: 4096,
    observedEventTypes: ["response.created", "response.output_text.delta"],
    eventTypesTruncated: false,
  };
}

describe("logResponsesStreamGateCommitObservation rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFake200SseDiagnosticLogRateLimitForTests();
  });

  it("emits at most 8 entries per provider per window and reports suppression", () => {
    for (let i = 0; i < 12; i += 1) {
      logResponsesStreamGateCommitObservation(baseObservation(1));
    }

    expect(logger.info).toHaveBeenCalledTimes(8);
    // 第 9 条起被抑制；下一次成功输出会带上抑制计数
    expect(vi.mocked(logger.info).mock.calls[7][1]).not.toHaveProperty(
      "suppressedSinceLastEmission"
    );
  });

  it("buckets are per provider", () => {
    for (let i = 0; i < 8; i += 1) {
      logResponsesStreamGateCommitObservation(baseObservation(1));
    }
    logResponsesStreamGateCommitObservation(baseObservation(2));

    expect(logger.info).toHaveBeenCalledTimes(9);
    const lastCall = vi.mocked(logger.info).mock.calls[8][1] as Record<string, unknown>;
    expect(lastCall.providerId).toBe(2);
    expect(lastCall.echoExcludedBytes).toBe(4096);
  });

  it("log payload carries the event name and byte composition", () => {
    logResponsesStreamGateCommitObservation(baseObservation(7));

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, fields] = vi.mocked(logger.info).mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toBe("ProxyForwarder: Responses stream gate committed");
    expect(fields.event).toBe("proxy.responses_stream_gate_commit");
    expect(fields.echoExcludedBytes).toBe(4096);
    expect(fields.bufferedBytes).toBe(128);
    expect(fields.framesSeen).toBe(2);
    expect(fields.observedEventTypes).toEqual(["response.created", "response.output_text.delta"]);
  });
});

describe("inspectStreamingResponsePrefix commit diagnostic", () => {
  it("attaches the gate diagnostic (echo bytes) to a successful enforce commit", async () => {
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      ]),
      { enableResponsesLifecycleGate: true, responsesGateMode: "enforce" }
    );

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    expect(result.commitDiagnostic).toBeDefined();
    expect(result.commitDiagnostic?.framesSeen).toBeGreaterThan(0);
    // response.created 属于生命周期（可能回显）帧，其字节计入 echo 排除统计
    expect(result.commitDiagnostic?.echoExcludedBytes).toBeGreaterThan(0);
    expect(result.commitDiagnostic?.observedEventTypes).toContain("response.created");
  });

  it("fake-200 rejection path keeps no commit diagnostic", async () => {
    const result = await inspectStreamingResponsePrefix(
      responseFromChunks(['{"error":{"message":"Our servers are currently overloaded."}}']),
      { enableResponsesLifecycleGate: true, responsesGateMode: "enforce" }
    );

    expect(result.kind).toBe("fake_200");
    if (result.kind === "fake_200") {
      expect((result as { commitDiagnostic?: unknown }).commitDiagnostic).toBeUndefined();
    }
  });
});
