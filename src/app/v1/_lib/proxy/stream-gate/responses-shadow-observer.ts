import type {
  ResponsesStreamCommitMarker,
  ResponsesStreamGateCaps,
  ResponsesStreamGateFailureReason,
} from "./responses-content-gate";
import { classifyResponsesFrame, isResponsesRequestEchoFrame } from "./responses-frame-classifier";
import { type SseFrame, SseFrameBufferLimitError, SseFrameParser } from "./sse-frames";

export type ResponsesStreamShadowDiagnostic = {
  mode: "shadow";
  outcome: "content" | ResponsesStreamGateFailureReason;
  divergentFromLegacy: true;
  framesSeen: number;
  bufferedBytes: number;
  echoExcludedBytes: number;
  observedEventTypes: readonly string[];
  eventTypesTruncated: boolean;
  marker: ResponsesStreamCommitMarker;
};

export type ResponsesStreamShadowObserver = {
  observe(chunk: Uint8Array): void;
  finish(): void;
  fail(): void;
};

const MAX_DIAGNOSTIC_EVENT_TYPES = 8;
const MAX_DIAGNOSTIC_EVENT_TYPE_LENGTH = 128;

function truncateEventType(value: string | null): string {
  if (!value) return "unknown";
  return value.length <= MAX_DIAGNOSTIC_EVENT_TYPE_LENGTH
    ? value
    : value.slice(0, MAX_DIAGNOSTIC_EVENT_TYPE_LENGTH);
}

/**
 * Observe the semantic gate decision after the legacy gate has already committed.
 * This observer never buffers raw chunks, never changes downstream bytes, and never
 * throws into the response path. Its parser state remains subject to the same caps
 * as enforce mode.
 */
export function createResponsesStreamShadowObserver(options: {
  caps: ResponsesStreamGateCaps;
  legacyCommitMarker: ResponsesStreamCommitMarker;
  onDiagnostic?: (diagnostic: ResponsesStreamShadowDiagnostic) => void;
}): ResponsesStreamShadowObserver {
  const totalByteCap = options.caps.prebufferByteCap + options.caps.requestEchoByteCap;
  const parser = new SseFrameParser({
    maxBufferedCharacters: options.caps.prebufferByteCap,
    bufferLimitExemption: {
      maxBufferedCharacters: totalByteCap,
      matches: isResponsesRequestEchoFrame,
    },
  });
  const observedEventTypes: string[] = [];
  let eventTypesTruncated = false;
  let framesSeen = 0;
  let bufferedBytes = 0;
  let echoExcludedBytes = 0;
  let stopped = false;

  const observeEventType = (eventType: string | null): void => {
    if (observedEventTypes.length >= MAX_DIAGNOSTIC_EVENT_TYPES) {
      eventTypesTruncated = true;
      return;
    }
    observedEventTypes.push(truncateEventType(eventType));
  };

  const decide = (outcome: "content" | ResponsesStreamGateFailureReason): void => {
    if (stopped) return;
    stopped = true;

    const semanticContentReachedAtLegacyCommit =
      outcome === "content" && framesSeen === options.legacyCommitMarker.frameIndex;
    if (semanticContentReachedAtLegacyCommit) return;

    try {
      options.onDiagnostic?.({
        mode: "shadow",
        outcome,
        divergentFromLegacy: true,
        framesSeen,
        bufferedBytes,
        echoExcludedBytes,
        observedEventTypes: [...observedEventTypes],
        eventTypesTruncated,
        marker: options.legacyCommitMarker,
      });
    } catch {
      // Shadow diagnostics must never affect response delivery.
    }
  };

  const checkByteCaps = (allowCurrentBufferExemption = true): boolean => {
    if (stopped) return true;
    if (allowCurrentBufferExemption && parser.isCurrentBufferExempt()) {
      if (bufferedBytes > totalByteCap) decide("byte_overflow");
      return stopped;
    }
    const boundedEchoExclusion = Math.min(echoExcludedBytes, options.caps.requestEchoByteCap);
    if (
      bufferedBytes > totalByteCap ||
      bufferedBytes - boundedEchoExclusion > options.caps.prebufferByteCap
    ) {
      decide("byte_overflow");
    }
    return stopped;
  };

  const processFrame = (frame: SseFrame): void => {
    if (stopped) return;
    framesSeen += 1;
    const classification = classifyResponsesFrame(frame.eventName, frame.data);
    observeEventType(classification.eventType);

    if (classification.verdict === "error") {
      decide("gate_error");
      return;
    }
    if (classification.verdict === "malformed") {
      decide("decode_error");
      return;
    }
    if (classification.verdict === "terminal") {
      decide("empty_stream");
      return;
    }
    if (framesSeen > options.caps.prebufferEventCap) {
      decide("event_overflow");
      return;
    }
    if (classification.verdict === "content") {
      if (checkByteCaps(false)) return;
      decide("content");
      return;
    }

    if (isResponsesRequestEchoFrame(frame.eventName, frame.data.slice(0, 128))) {
      echoExcludedBytes += Buffer.byteLength(frame.data, "utf8");
    }
  };

  const processFrames = (frames: readonly SseFrame[]): void => {
    for (const frame of frames) {
      processFrame(frame);
      if (stopped) return;
    }
  };

  const handleParserError = (error: unknown): void => {
    if (error instanceof SseFrameBufferLimitError) {
      processFrames(error.completedFrames);
      if (!stopped) decide("byte_overflow");
      return;
    }
    decide("decode_error");
  };

  return {
    observe(chunk: Uint8Array): void {
      if (stopped || chunk.byteLength === 0) return;
      bufferedBytes += chunk.byteLength;
      if (!Number.isSafeInteger(bufferedBytes) || bufferedBytes > totalByteCap) {
        decide("byte_overflow");
        return;
      }
      try {
        processFrames(parser.push(chunk));
      } catch (error) {
        handleParserError(error);
      }
      checkByteCaps();
    },
    finish(): void {
      if (stopped) return;
      try {
        processFrames(parser.finish());
      } catch (error) {
        handleParserError(error);
      }
      if (!stopped) decide("empty_stream");
    },
    fail(): void {
      decide("read_error");
    },
  };
}
