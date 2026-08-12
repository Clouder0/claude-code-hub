import { describe, expect, it, vi } from "vitest";
import type {
  ResponsesStreamCommitMarker,
  ResponsesStreamGateCaps,
} from "@/app/v1/_lib/proxy/stream-gate/responses-content-gate";
import { createResponsesStreamShadowObserver } from "@/app/v1/_lib/proxy/stream-gate/responses-shadow-observer";

const encoder = new TextEncoder();

const CAPS: ResponsesStreamGateCaps = {
  prebufferEventCap: 16,
  prebufferByteCap: 1024,
  requestEchoByteCap: 8192,
};

const MARKER: ResponsesStreamCommitMarker = {
  verdict: "shadow_pass",
  eventType: "response.output_item.added",
  frameIndex: 1,
  chunkIndex: 1,
  bufferedBytes: 0,
  echoExcludedBytes: 0,
};

function frame(type: string, payload: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

describe("createResponsesStreamShadowObserver", () => {
  it("suppresses a diagnostic when semantic content was already the legacy commit frame", () => {
    const onDiagnostic = vi.fn();
    const observer = createResponsesStreamShadowObserver({
      caps: CAPS,
      legacyCommitMarker: MARKER,
      onDiagnostic,
    });

    observer.observe(frame("response.output_text.delta", { delta: "visible" }));
    observer.observe(frame("response.failed", { error: { code: "server_is_overloaded" } }));
    observer.finish();
    observer.fail();

    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it("reports content reached later than the legacy structural commit", () => {
    const onDiagnostic = vi.fn();
    const observer = createResponsesStreamShadowObserver({
      caps: CAPS,
      legacyCommitMarker: MARKER,
      onDiagnostic,
    });

    observer.observe(frame("response.created", { response: { id: "r1" } }));
    observer.observe(frame("response.output_text.delta", { delta: "visible" }));

    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "content", framesSeen: 2 })
    );
  });

  it.each([
    ["malformed JSON", encoder.encode("data: {broken\n\n"), "decode_error"],
    ["terminal before content", frame("response.completed"), "empty_stream"],
    ["invalid UTF-8", new Uint8Array([0xff]), "decode_error"],
  ])("reports %s without changing the response path", (_name, chunk, outcome) => {
    const onDiagnostic = vi.fn();
    const observer = createResponsesStreamShadowObserver({
      caps: CAPS,
      legacyCommitMarker: MARKER,
      onDiagnostic,
    });

    observer.observe(chunk);

    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
  });

  it("distinguishes clean EOF and read failure after neutral frames", () => {
    const onEof = vi.fn();
    const eofObserver = createResponsesStreamShadowObserver({
      caps: CAPS,
      legacyCommitMarker: MARKER,
      onDiagnostic: onEof,
    });
    eofObserver.observe(frame("response.created"));
    eofObserver.finish();
    expect(onEof).toHaveBeenCalledWith(expect.objectContaining({ outcome: "empty_stream" }));

    const onReadFailure = vi.fn();
    const failedObserver = createResponsesStreamShadowObserver({
      caps: CAPS,
      legacyCommitMarker: MARKER,
      onDiagnostic: onReadFailure,
    });
    failedObserver.fail();
    expect(onReadFailure).toHaveBeenCalledWith(expect.objectContaining({ outcome: "read_error" }));
  });

  it("bounds event diagnostics and fails on event overflow", () => {
    const onDiagnostic = vi.fn();
    const observer = createResponsesStreamShadowObserver({
      caps: { ...CAPS, prebufferEventCap: 9, prebufferByteCap: 8192 },
      legacyCommitMarker: MARKER,
      onDiagnostic,
    });

    observer.observe(encoder.encode("data: {}\n\n"));
    for (let index = 0; index < 9; index += 1) {
      observer.observe(
        frame(`response.future.${index}.${"x".repeat(160)}`, { metadata: { index } })
      );
    }

    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "event_overflow",
        framesSeen: 10,
        eventTypesTruncated: true,
        observedEventTypes: expect.arrayContaining(["unknown"]),
      })
    );
    const diagnostic = onDiagnostic.mock.calls[0]?.[0];
    expect(diagnostic.observedEventTypes).toHaveLength(8);
    expect(diagnostic.observedEventTypes[1]).toHaveLength(128);
  });

  it("processes decisive completed frames carried by a later parser overflow", () => {
    const onDiagnostic = vi.fn();
    const observer = createResponsesStreamShadowObserver({
      caps: { ...CAPS, prebufferByteCap: 64, requestEchoByteCap: 512 },
      legacyCommitMarker: MARKER,
      onDiagnostic,
    });
    const error = 'data: {"type":"response.failed","error":{"code":"overloaded"}}\n\n';
    const oversizedPartial = `data: {"type":"response.metadata","pad":"${"x".repeat(100)}`;

    observer.observe(encoder.encode(error + oversizedPartial));

    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: "gate_error" }));
  });

  it("matches enforce mode when same-chunk neutral frames exhaust the ordinary cap", () => {
    const onDiagnostic = vi.fn();
    const observer = createResponsesStreamShadowObserver({
      caps: CAPS,
      legacyCommitMarker: MARKER,
      onDiagnostic,
    });
    const neutralA = frame("response.metadata", { pad: "a".repeat(560) });
    const neutralB = frame("response.metadata", { pad: "b".repeat(560) });
    const content = frame("response.output_text.delta", { delta: "must-not-commit" });
    const combined = new Uint8Array(neutralA.byteLength + neutralB.byteLength + content.byteLength);
    combined.set(neutralA, 0);
    combined.set(neutralB, neutralA.byteLength);
    combined.set(content, neutralA.byteLength + neutralB.byteLength);

    observer.observe(combined);

    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "byte_overflow" })
    );
  });

  it("matches enforce mode when content arrives beyond the event cap", () => {
    const onDiagnostic = vi.fn();
    const observer = createResponsesStreamShadowObserver({
      caps: { ...CAPS, prebufferEventCap: 2 },
      legacyCommitMarker: MARKER,
      onDiagnostic,
    });
    const neutralA = frame("response.metadata", { metadata: { trace: "a" } });
    const neutralB = frame("response.metadata", { metadata: { trace: "b" } });
    const content = frame("response.output_text.delta", { delta: "must-not-commit" });
    const combined = new Uint8Array(neutralA.byteLength + neutralB.byteLength + content.byteLength);
    combined.set(neutralA, 0);
    combined.set(neutralB, neutralA.byteLength);
    combined.set(content, neutralA.byteLength + neutralB.byteLength);

    observer.observe(combined);

    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "event_overflow" })
    );
  });

  it("swallows a diagnostic callback failure", () => {
    const observer = createResponsesStreamShadowObserver({
      caps: CAPS,
      legacyCommitMarker: MARKER,
      onDiagnostic() {
        throw new Error("diagnostic sink failed");
      },
    });

    expect(() => observer.fail()).not.toThrow();
  });
});
