import { getEnvConfig } from "@/lib/config/env.schema";
import {
  classifyResponsesFrame,
  isLegacyResponsesLifecycleEvent,
  isResponsesRequestEchoFrame,
  type ResponsesFrameClassification,
} from "./responses-frame-classifier";
import { type SseFrame, SseFrameBufferLimitError, SseFrameParser } from "./sse-frames";

export type ResponsesStreamGateMode = "off" | "shadow" | "enforce";

export type ResponsesStreamGateCaps = {
  prebufferEventCap: number;
  prebufferByteCap: number;
  requestEchoByteCap: number;
};

export type ResponsesStreamGateFailureReason =
  | "gate_error"
  | "decode_error"
  | "read_error"
  | "empty_stream"
  | "event_overflow"
  | "byte_overflow";

export type ResponsesStreamCommitMarker = {
  verdict: "content" | "shadow_pass";
  eventType: string | null;
  frameIndex: number;
  chunkIndex: number;
  bufferedBytes: number;
  echoExcludedBytes: number;
};

export type ResponsesStreamGateDiagnostic = {
  framesSeen: number;
  bufferedBytes: number;
  echoExcludedBytes: number;
  observedEventTypes: readonly string[];
  eventTypesTruncated: boolean;
};

export type ResponsesStreamGateResult =
  | {
      committed: true;
      prefixChunks: Uint8Array[];
      readerDone: boolean;
      commitMarker: ResponsesStreamCommitMarker;
      legacyGateAlreadyCommitted: boolean;
      diagnostic: ResponsesStreamGateDiagnostic;
    }
  | {
      committed: false;
      reason: ResponsesStreamGateFailureReason;
      prefixChunks: Uint8Array[];
      readerDone: boolean;
      frameData?: string;
      eventType: string | null;
      failureFrameIndex: number;
      failureChunkIndex: number;
      legacyGateAlreadyCommitted: boolean;
      diagnostic: ResponsesStreamGateDiagnostic;
      cause?: Error;
    };

export const DEFAULT_RESPONSES_STREAM_GATE_CAPS: ResponsesStreamGateCaps = {
  prebufferEventCap: 64,
  prebufferByteCap: 512 * 1024,
  requestEchoByteCap: 4 * 1024 * 1024,
};

const MAX_DIAGNOSTIC_EVENT_TYPES = 8;
const MAX_DIAGNOSTIC_EVENT_TYPE_LENGTH = 128;

export function resolveResponsesStreamGateMode(): ResponsesStreamGateMode {
  try {
    const mode = getEnvConfig().STREAM_GATE_MODE;
    return mode === "off" || mode === "shadow" || mode === "enforce" ? mode : "enforce";
  } catch {
    return "enforce";
  }
}

function resolveIntegerCap(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? (value as number)
    : fallback;
}

export function resolveResponsesStreamGateCaps(): ResponsesStreamGateCaps {
  try {
    const env = getEnvConfig();
    return {
      prebufferEventCap: resolveIntegerCap(
        env.STREAM_GATE_PREBUFFER_EVENT_CAP,
        1,
        4096,
        DEFAULT_RESPONSES_STREAM_GATE_CAPS.prebufferEventCap
      ),
      prebufferByteCap: resolveIntegerCap(
        env.STREAM_GATE_PREBUFFER_BYTE_CAP,
        32 * 1024,
        16 * 1024 * 1024,
        DEFAULT_RESPONSES_STREAM_GATE_CAPS.prebufferByteCap
      ),
      requestEchoByteCap: resolveIntegerCap(
        env.STREAM_GATE_REQUEST_ECHO_BYTE_CAP,
        64 * 1024,
        64 * 1024 * 1024,
        DEFAULT_RESPONSES_STREAM_GATE_CAPS.requestEchoByteCap
      ),
    };
  } catch {
    return { ...DEFAULT_RESPONSES_STREAM_GATE_CAPS };
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function boundedEventType(value: string | null): string | null {
  if (!value) return null;
  return value.length <= MAX_DIAGNOSTIC_EVENT_TYPE_LENGTH
    ? value
    : value.slice(0, MAX_DIAGNOSTIC_EVENT_TYPE_LENGTH);
}

function truncateEventType(value: string | null): string {
  return boundedEventType(value) ?? "unknown";
}

export async function runResponsesStreamContentGate(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ResponsesStreamGateCaps & { onFirstByte?: () => void; onChunk?: () => void }
): Promise<ResponsesStreamGateResult> {
  assertPositiveSafeInteger("prebufferEventCap", options.prebufferEventCap);
  assertPositiveSafeInteger("prebufferByteCap", options.prebufferByteCap);
  assertPositiveSafeInteger("requestEchoByteCap", options.requestEchoByteCap);
  const totalByteCap = options.prebufferByteCap + options.requestEchoByteCap;
  if (!Number.isSafeInteger(totalByteCap)) {
    throw new RangeError("combined stream gate byte cap must be a safe integer");
  }

  const parser = new SseFrameParser({
    maxBufferedCharacters: options.prebufferByteCap,
    bufferLimitExemption: {
      maxBufferedCharacters: totalByteCap,
      matches: isResponsesRequestEchoFrame,
    },
  });
  const prefixChunks: Uint8Array[] = [];
  const observedEventTypes: string[] = [];
  let eventTypesTruncated = false;
  let bufferedBytes = 0;
  let echoExcludedBytes = 0;
  let framesSeen = 0;
  let chunkIndex = 0;
  let firstByteSeen = false;
  let legacyGateAlreadyCommitted = false;

  const diagnostic = (): ResponsesStreamGateDiagnostic => ({
    framesSeen,
    bufferedBytes,
    echoExcludedBytes,
    observedEventTypes: [...observedEventTypes],
    eventTypesTruncated,
  });

  const observeEventType = (eventType: string | null): void => {
    if (observedEventTypes.length >= MAX_DIAGNOSTIC_EVENT_TYPES) {
      eventTypesTruncated = true;
      return;
    }
    observedEventTypes.push(truncateEventType(eventType));
  };

  const commit = (
    classification: ResponsesFrameClassification,
    readerDone: boolean
  ): ResponsesStreamGateResult => ({
    committed: true,
    prefixChunks,
    readerDone,
    commitMarker: {
      verdict: "content",
      eventType: boundedEventType(classification.eventType),
      frameIndex: framesSeen,
      chunkIndex,
      bufferedBytes,
      echoExcludedBytes,
    },
    legacyGateAlreadyCommitted,
    diagnostic: diagnostic(),
  });

  const failure = (
    reason: ResponsesStreamGateFailureReason,
    readerDone: boolean,
    classification?: ResponsesFrameClassification,
    frameData?: string,
    cause?: Error
  ): ResponsesStreamGateResult => ({
    committed: false,
    reason,
    prefixChunks,
    readerDone,
    ...(frameData !== undefined ? { frameData } : {}),
    eventType: classification?.eventType ?? null,
    failureFrameIndex: framesSeen,
    failureChunkIndex: chunkIndex,
    legacyGateAlreadyCommitted,
    diagnostic: diagnostic(),
    ...(cause ? { cause } : {}),
  });

  const checkByteCaps = (
    readerDone: boolean,
    allowCurrentBufferExemption = true
  ): ResponsesStreamGateResult | null => {
    // A request-echo frame may be split across transport chunks. Its completed
    // data cannot be counted in echoExcludedBytes until the closing SSE frame
    // boundary arrives, so preserve the independent exemption while the
    // parser can already identify the in-progress frame from its bounded head.
    if (allowCurrentBufferExemption && parser.isCurrentBufferExempt()) {
      return bufferedBytes > totalByteCap ? failure("byte_overflow", readerDone) : null;
    }
    const boundedEchoExclusion = Math.min(echoExcludedBytes, options.requestEchoByteCap);
    if (
      bufferedBytes > totalByteCap ||
      bufferedBytes - boundedEchoExclusion > options.prebufferByteCap
    ) {
      return failure("byte_overflow", readerDone);
    }
    return null;
  };

  const processFrame = (frame: SseFrame, readerDone: boolean): ResponsesStreamGateResult | null => {
    framesSeen += 1;
    const classification = classifyResponsesFrame(frame.eventName, frame.data);
    observeEventType(classification.eventType);

    if (classification.verdict === "error") {
      return failure("gate_error", readerDone, classification, frame.data);
    }
    if (classification.verdict === "malformed") {
      return failure("decode_error", readerDone, classification, frame.data);
    }
    if (classification.verdict === "terminal") {
      return failure("empty_stream", readerDone, classification, frame.data);
    }
    if (framesSeen > options.prebufferEventCap) {
      return failure("event_overflow", readerDone, classification);
    }
    if (classification.verdict === "content") {
      // parser.push() may return several complete frames from one transport
      // chunk. Enforce aggregate event and byte budgets before a later content
      // frame can commit a prefix that already exhausted either cap.
      const capFailure = checkByteCaps(readerDone, false);
      if (capFailure) return capFailure;
      return commit(classification, readerDone);
    }

    if (!isLegacyResponsesLifecycleEvent(classification.eventType)) {
      legacyGateAlreadyCommitted = true;
    }

    if (isResponsesRequestEchoFrame(frame.eventName, frame.data.slice(0, 128))) {
      echoExcludedBytes += Buffer.byteLength(frame.data, "utf8");
    }
    return null;
  };

  const processFrames = (
    frames: readonly SseFrame[],
    readerDone: boolean
  ): ResponsesStreamGateResult | null => {
    for (const frame of frames) {
      const decision = processFrame(frame, readerDone);
      if (decision) return decision;
    }
    return null;
  };

  while (true) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch (error) {
      return failure(
        "read_error",
        false,
        undefined,
        undefined,
        error instanceof Error ? error : new Error(String(error))
      );
    }

    if (next.done) {
      try {
        const decision = processFrames(parser.finish(), true);
        if (decision) return decision;
      } catch (error) {
        if (error instanceof SseFrameBufferLimitError) {
          const completedDecision = processFrames(error.completedFrames, true);
          if (completedDecision) return completedDecision;
          return failure("byte_overflow", true, undefined, undefined, error);
        }
        return failure(
          "decode_error",
          true,
          undefined,
          undefined,
          error instanceof Error ? error : new Error(String(error))
        );
      }
      return failure("empty_stream", true);
    }

    const chunk = next.value;
    if (!chunk || chunk.byteLength === 0) continue;
    if (!firstByteSeen) {
      firstByteSeen = true;
      options.onFirstByte?.();
    }
    options.onChunk?.();
    chunkIndex += 1;

    // A stream reader may yield an arbitrarily large transport chunk. Reject it
    // before retaining or decoding when this one read would exceed the combined
    // precommit budget. Without this check, a content frame later in the same
    // chunk could commit before the post-parse cap check and bypass the bound.
    const nextBufferedBytes = bufferedBytes + chunk.byteLength;
    if (!Number.isSafeInteger(nextBufferedBytes) || nextBufferedBytes > totalByteCap) {
      bufferedBytes = nextBufferedBytes;
      return failure("byte_overflow", false);
    }
    prefixChunks.push(chunk);
    bufferedBytes = nextBufferedBytes;

    try {
      const decision = processFrames(parser.push(chunk), false);
      if (decision) return decision;
    } catch (error) {
      if (error instanceof SseFrameBufferLimitError) {
        const completedDecision = processFrames(error.completedFrames, false);
        if (completedDecision) return completedDecision;
        return failure("byte_overflow", false, undefined, undefined, error);
      }
      return failure(
        "decode_error",
        false,
        undefined,
        undefined,
        error instanceof Error ? error : new Error(String(error))
      );
    }

    const capFailure = checkByteCaps(false);
    if (capFailure) return capFailure;
  }
}
