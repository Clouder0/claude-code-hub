import { describe, expect, it, vi } from "vitest";
import {
  inspectStreamingResponsePrefix,
  PRECOMMIT_HEARTBEAT_FRAME,
} from "@/app/v1/_lib/proxy/streaming-response-gate";
import { parseSSEDataForFinalization, sseChunkIsCommentOnly } from "@/lib/utils/sse";

const encoder = new TextEncoder();

function sse(frame: unknown, event?: string): string {
  const lines = event ? [`event: ${event}`] : [];
  lines.push(`data: ${JSON.stringify(frame)}`);
  return `${lines.join("\n")}\n\n`;
}

const lifecycleEcho = sse({ type: "response.created", response: {} });
const contentFrame = sse({ type: "response.output_text.delta", delta: "hello" });

function delayedSseResponse(
  frames: string[],
  delayMs: number,
  onCancel?: (reason: unknown) => void,
  keepOpen = false
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          if (!keepOpen) controller.close();
        }, delayMs);
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

function neverEndingResponse(onCancel?: (reason: unknown) => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start() {
        // 永不出帧:模拟 remote compaction 的长静默。
      },
      cancel(reason) {
        onCancel?.(reason);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

const gateOptions = {
  enableResponsesLifecycleGate: true,
  responsesGateMode: "enforce" as const,
};

function heartbeatConfig(
  overrides: Partial<{ delayMs: number; intervalMs: number; maxMs: number }>
) {
  return { delayMs: 20, intervalMs: 15, maxMs: 5_000, ...overrides };
}

function countHeartbeats(text: string): number {
  return text.split(PRECOMMIT_HEARTBEAT_FRAME).length - 1;
}

describe("precommit heartbeat", () => {
  it("delay=0 is byte-for-byte equivalent to the unwrapped gate", async () => {
    const response = delayedSseResponse([lifecycleEcho, contentFrame], 30);
    const result = await inspectStreamingResponsePrefix(response, {
      ...gateOptions,
      precommitHeartbeat: heartbeatConfig({ delayMs: 0 }),
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    expect(result.precommitHeartbeat).toBeUndefined();
    const text = await result.response.text();
    expect(countHeartbeats(text)).toBe(0);
    expect(text).toBe(lifecycleEcho + contentFrame);
  });

  it("inner inspection finishing before the delay returns the unwrapped result", async () => {
    const onHeartbeat = vi.fn();
    const response = delayedSseResponse([lifecycleEcho, contentFrame], 10);
    const result = await inspectStreamingResponsePrefix(response, {
      ...gateOptions,
      precommitHeartbeat: heartbeatConfig({ delayMs: 300 }),
      onPrecommitHeartbeat: onHeartbeat,
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    expect(result.precommitHeartbeat).toBeUndefined();
    expect(result.commitMarker?.eventType).toBe("response.output_text.delta");
    expect(onHeartbeat).not.toHaveBeenCalled();
    const text = await result.response.text();
    expect(countHeartbeats(text)).toBe(0);
    expect(text).toBe(lifecycleEcho + contentFrame);
  });

  it("commits heartbeats and then replays the committed upstream bytes verbatim", async () => {
    const onHeartbeat = vi.fn();
    const response = delayedSseResponse([lifecycleEcho, contentFrame], 70);
    const result = await inspectStreamingResponsePrefix(response, {
      ...gateOptions,
      precommitHeartbeat: heartbeatConfig({ delayMs: 20, intervalMs: 15 }),
      onPrecommitHeartbeat: onHeartbeat,
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    const text = await result.response.text();
    expect(result.precommitHeartbeat?.outcome).toBe("pass");
    const beats = countHeartbeats(text);
    expect(beats).toBeGreaterThanOrEqual(1);
    // 回放部分与上游逐字节一致,且不产生失败事件。
    expect(text.endsWith(lifecycleEcho + contentFrame)).toBe(true);
    expect(text).not.toContain("response.failed");

    expect(onHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ type: "started", delayMs: 20, intervalMs: 15 })
    );
    expect(onHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ type: "outcome", outcome: "pass", beats })
    );
    // 200 与 SSE 头已提交,且禁用了反向代理缓冲。
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("degrades a late fake-200 into a retryable response.failed terminal event", async () => {
    const onHeartbeat = vi.fn();
    const errorFrame = sse({
      type: "error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
    });
    const response = delayedSseResponse([errorFrame], 70);
    const result = await inspectStreamingResponsePrefix(response, {
      ...gateOptions,
      precommitHeartbeat: heartbeatConfig({ delayMs: 20, intervalMs: 15 }),
      onPrecommitHeartbeat: onHeartbeat,
    });

    // 心跳已提交后,迟到失败不再走换梯抛错,而是以 pass + 流内失败收尾。
    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    const text = await result.response.text();
    expect(result.precommitHeartbeat?.outcome).toBe("failed");
    expect(countHeartbeats(text)).toBeGreaterThanOrEqual(1);
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"server_error"');
    // 客户端 payload 不得泄漏 Codex 致命闭集码与上游原始错误文本。
    expect(text).not.toContain("server_is_overloaded");
    expect(text).not.toContain("currently overloaded");

    const outcomeCall = onHeartbeat.mock.calls.find((call) => call[0].type === "outcome")?.[0];
    expect(outcomeCall?.outcome).toBe("failed");
    // 内部遥测保留原始检测码(与客户端改写码不同)。
    if (outcomeCall?.code) {
      expect(outcomeCall.code).not.toBe("server_error");
    }
  });

  it("expires after maxMs into a response.failed terminal event", async () => {
    const onCancel = vi.fn();
    const response = neverEndingResponse(onCancel);
    const result = await inspectStreamingResponsePrefix(response, {
      ...gateOptions,
      precommitHeartbeat: heartbeatConfig({ delayMs: 15, intervalMs: 10, maxMs: 60 }),
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    const text = await result.response.text();
    expect(result.precommitHeartbeat?.outcome).toBe("expired");
    expect(countHeartbeats(text)).toBeGreaterThanOrEqual(1);
    expect(text).toContain("event: response.failed");
    expect(text).toContain('"code":"server_error"');
  });

  it("propagates client cancellation to the upstream stream", async () => {
    const onCancel = vi.fn();
    // keepOpen:真实场景中 gate commit 时上游流仍打开(后续内容待续),
    // 取消传播才有意义;自关闭的流 cancel 是 no-op。
    const response = delayedSseResponse([lifecycleEcho, contentFrame], 150, onCancel, true);
    const onHeartbeat = vi.fn();
    const result = await inspectStreamingResponsePrefix(response, {
      ...gateOptions,
      precommitHeartbeat: heartbeatConfig({ delayMs: 20, intervalMs: 15 }),
      onPrecommitHeartbeat: onHeartbeat,
    });
    if (result.kind !== "pass") throw new Error("expected pass");

    const reader = result.response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value!)).toBe(PRECOMMIT_HEARTBEAT_FRAME);
    await reader.cancel("client_closed");
    // 等 inner 决出并走清理分支:取消其回放体,传播到上游 source。
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onCancel).toHaveBeenCalled();
    expect(result.precommitHeartbeat?.outcome).toBe("cancelled");
    expect(onHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ type: "outcome", outcome: "cancelled" })
    );
  });

  it("keeps shadow and legacy paths covered by the same wrapper", async () => {
    // legacy 路径(enableResponsesLifecycleGate=false):压缩请求实际走的分支。
    const response = delayedSseResponse([lifecycleEcho, contentFrame], 70);
    const result = await inspectStreamingResponsePrefix(response, {
      enableResponsesLifecycleGate: false,
      precommitHeartbeat: heartbeatConfig({ delayMs: 20, intervalMs: 15 }),
    });

    expect(result.kind).toBe("pass");
    if (result.kind !== "pass") return;
    const text = await result.response.text();
    expect(result.precommitHeartbeat?.outcome).toBe("pass");
    expect(countHeartbeats(text)).toBeGreaterThanOrEqual(1);
    expect(text.endsWith(lifecycleEcho + contentFrame)).toBe(true);
  });
});

describe("sseChunkIsCommentOnly", () => {
  it("recognizes heartbeat frames as comment-only", () => {
    expect(sseChunkIsCommentOnly(encoder.encode(": ping\n\n"))).toBe(true);
    expect(sseChunkIsCommentOnly(encoder.encode(": keepalive\n: second\n\n"))).toBe(true);
  });

  it("rejects content, mixed, and empty chunks", () => {
    expect(sseChunkIsCommentOnly(encoder.encode(contentFrame))).toBe(false);
    expect(sseChunkIsCommentOnly(encoder.encode(": ping\n" + contentFrame))).toBe(false);
    expect(sseChunkIsCommentOnly(new Uint8Array(0))).toBe(false);
  });
});

describe("finalization SSE parsing tolerates heartbeat comments", () => {
  it("usage extraction ignores interleaved comment frames", () => {
    const usageEvent = sse({
      type: "response.completed",
      response: { usage: { input_tokens: 5, output_tokens: 7 } },
    });
    const text = PRECOMMIT_HEARTBEAT_FRAME + usageEvent + PRECOMMIT_HEARTBEAT_FRAME;
    const events = parseSSEDataForFinalization(text);
    expect(events).toHaveLength(1);
    const data = events[0].data as {
      response: { usage: { output_tokens: number } };
    };
    expect(data.response.usage.output_tokens).toBe(7);
  });
});
