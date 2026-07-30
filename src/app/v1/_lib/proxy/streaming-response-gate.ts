import { detectUpstreamErrorFromSseOrJsonText } from "@/lib/utils/upstream-error-detection";

export const DEFAULT_STREAMING_RESPONSE_PREFIX_LIMIT_BYTES = 32 * 1024;

const MAX_DIAGNOSTIC_EVENT_TYPES = 8;
const MAX_DIAGNOSTIC_STRING_LENGTH = 128;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 65_536;
const RESPONSES_PRE_OUTPUT_EVENT_TYPES = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
]);

export type StreamingResponsePrefixDiagnostic = {
  phase: "responses_pre_output_gate" | "streaming_prefix_gate" | "prefix_cap_fail_open";
  observedBytes: number;
  prefixCapBytes: number;
  rawBodyTruncated: boolean;
  streamEndedDuringInspection: boolean;
  observedEventTypes: readonly string[];
  eventCountObserved: number;
  eventTypesTruncated: boolean;
  detectorCode: string;
  upstreamErrorCode?: string;
  upstreamErrorType?: string;
  upstreamErrorMessageLength?: number;
};

export type StreamingResponsePrefixInspection =
  | {
      kind: "pass";
      response: Response;
      diagnostic?: StreamingResponsePrefixDiagnostic;
    }
  | {
      kind: "fake_200";
      code: string;
      detail?: string;
      rawText: string;
      rawBodyTruncated: boolean;
      diagnostic: StreamingResponsePrefixDiagnostic;
    };

type InspectStreamingResponsePrefixOptions = {
  maxBytes?: number;
  /** Enable the multi-event hold only for the canonical OpenAI Responses SSE protocol. */
  enableResponsesLifecycleGate?: boolean;
  /** Called exactly once when a nonempty upstream body chunk first reaches this gate. */
  onFirstUpstreamByte?: () => void;
  /** The gate owns this watchdog only while it holds pre-output lifecycle events. */
  streamingIdleTimeoutMs?: number;
  onStreamingIdleTimeout?: () => void;
};

type PrefixDecision =
  | { kind: "need_more" }
  | { kind: "pass" }
  | ({
      kind: "fake_200";
      code: string;
      detail?: string;
    } & UpstreamErrorDiagnostic);

type UpstreamErrorDiagnostic = {
  upstreamErrorCode?: string;
  upstreamErrorType?: string;
  upstreamErrorMessageLength?: number;
};

type ParsedSseEvent = {
  eventName?: string;
  eventType?: string;
  data: unknown;
};

type DiagnosticState = {
  observedEventTypes: string[];
  eventCountObserved: number;
  eventTypesTruncated: boolean;
};

function truncateDiagnosticString(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_STRING_LENGTH
    ? value
    : value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function findSseEventBoundary(text: string, start: number): { end: number; next: number } | null {
  const match = /\r\n\r\n|\n\r\n|\r\n\n|\n\n|\r\r/gu.exec(text.slice(start));
  if (!match || match.index === undefined) return null;
  const end = start + match.index;
  return { end, next: end + match[0].length };
}

function parseCompleteSseEvent(eventText: string): ParsedSseEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of eventText.split(/\r\n|\n|\r/u)) {
    if (line.startsWith("event:")) {
      const candidate = line.slice("event:".length).trim();
      eventName = candidate || undefined;
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice("data:".length);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  if (dataLines.length === 0) return null;

  const dataText = dataLines.join("\n");
  let data: unknown = dataText;
  try {
    data = JSON.parse(dataText) as unknown;
  } catch {
    // An unreadable event must fail open; it may be a future protocol extension or non-JSON SSE.
  }

  const dataType = isPlainRecord(data) && typeof data.type === "string" ? data.type.trim() : "";
  return {
    eventName,
    eventType: dataType || eventName,
    data,
  };
}

function extractDiagnosticError(data: unknown, eventName?: string): UpstreamErrorDiagnostic {
  if (!isPlainRecord(data)) return {};

  const response = isPlainRecord(data.response) ? data.response : null;
  const errorValue =
    data.error ??
    (data.type === "response.failed" || eventName === "response.failed"
      ? response?.error
      : undefined) ??
    (data.type === "error" || eventName === "error" ? data : undefined);

  if (typeof errorValue === "string") {
    return {
      upstreamErrorMessageLength: Math.min(errorValue.length, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    };
  }
  if (!isPlainRecord(errorValue)) return {};

  const code = typeof errorValue.code === "string" ? errorValue.code.trim() : "";
  const type = typeof errorValue.type === "string" ? errorValue.type.trim() : "";
  const message = typeof errorValue.message === "string" ? errorValue.message : null;
  return {
    ...(code ? { upstreamErrorCode: truncateDiagnosticString(code) } : {}),
    ...(type ? { upstreamErrorType: truncateDiagnosticString(type) } : {}),
    ...(message
      ? { upstreamErrorMessageLength: Math.min(message.length, MAX_DIAGNOSTIC_MESSAGE_LENGTH) }
      : {}),
  };
}

function addObservedEventType(diagnostics: DiagnosticState, eventType?: string): void {
  diagnostics.eventCountObserved += 1;
  if (diagnostics.observedEventTypes.length >= MAX_DIAGNOSTIC_EVENT_TYPES) {
    diagnostics.eventTypesTruncated = true;
    return;
  }
  diagnostics.observedEventTypes.push(eventType ? truncateDiagnosticString(eventType) : "unknown");
}

function inspectCompleteJsonPayload(text: string, eof: boolean): PrefixDecision | null {
  let trimmed = text.trimStart();
  if (trimmed.charCodeAt(0) === 0xfeff) {
    trimmed = trimmed.slice(1).trimStart();
  }
  if (!trimmed.startsWith("{")) return null;

  try {
    JSON.parse(trimmed);
  } catch {
    return eof ? { kind: "pass" } : { kind: "need_more" };
  }

  const detected = detectUpstreamErrorFromSseOrJsonText(trimmed);
  if (!detected.isError) return { kind: "pass" };
  return {
    kind: "fake_200",
    code: detected.code,
    detail: detected.detail,
    ...extractDiagnosticError(JSON.parse(trimmed) as unknown),
  };
}

function inspectCompleteSseEvent(
  eventText: string,
  enableResponsesLifecycleGate: boolean,
  diagnostics: DiagnosticState
): PrefixDecision | null {
  const event = parseCompleteSseEvent(eventText);
  if (!event) return null;

  addObservedEventType(diagnostics, event.eventType);
  const detected = detectUpstreamErrorFromSseOrJsonText(eventText);
  if (detected.isError) {
    return {
      kind: "fake_200",
      code: detected.code,
      detail: detected.detail,
      ...extractDiagnosticError(event.data, event.eventName),
    };
  }

  if (!enableResponsesLifecycleGate) return { kind: "pass" };
  return RESPONSES_PRE_OUTPUT_EVENT_TYPES.has(event.eventType ?? "")
    ? { kind: "need_more" }
    : { kind: "pass" };
}

function buildDiagnostic(
  diagnostics: DiagnosticState,
  options: {
    phase: StreamingResponsePrefixDiagnostic["phase"];
    observedBytes: number;
    prefixCapBytes: number;
    rawBodyTruncated: boolean;
    streamEndedDuringInspection: boolean;
    detectorCode: string;
    error?: UpstreamErrorDiagnostic;
  }
): StreamingResponsePrefixDiagnostic {
  return {
    phase: options.phase,
    observedBytes: options.observedBytes,
    prefixCapBytes: options.prefixCapBytes,
    rawBodyTruncated: options.rawBodyTruncated,
    streamEndedDuringInspection: options.streamEndedDuringInspection,
    observedEventTypes: diagnostics.observedEventTypes,
    eventCountObserved: diagnostics.eventCountObserved,
    eventTypesTruncated: diagnostics.eventTypesTruncated,
    detectorCode: truncateDiagnosticString(options.detectorCode),
    ...options.error,
  };
}

function replayResponse(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefixChunks: Uint8Array[]
): Response {
  let prefixIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefixChunks.length) {
        controller.enqueue(prefixChunks[prefixIndex]);
        prefixIndex += 1;
        return;
      }

      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function inspectStreamingResponsePrefix(
  response: Response,
  options: InspectStreamingResponsePrefixOptions = {}
): Promise<StreamingResponsePrefixInspection> {
  if (!response.body) {
    return { kind: "pass", response };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_STREAMING_RESPONSE_PREFIX_LIMIT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const reader = response.body.getReader();
  const prefixChunks: Uint8Array[] = [];
  const diagnostics: DiagnosticState = {
    observedEventTypes: [],
    eventCountObserved: 0,
    eventTypesTruncated: false,
  };
  let bufferedBytes = 0;
  let sseEventStart = 0;
  let firstUpstreamByteObserved = false;
  let idleTimeoutId: NodeJS.Timeout | null = null;
  const idleTimeoutMs = options.streamingIdleTimeoutMs ?? 0;

  const clearIdleTimeout = () => {
    if (idleTimeoutId) {
      clearTimeout(idleTimeoutId);
      idleTimeoutId = null;
    }
  };
  const refreshIdleTimeout = () => {
    if (idleTimeoutMs <= 0 || !options.onStreamingIdleTimeout) return;
    clearIdleTimeout();
    idleTimeoutId = setTimeout(options.onStreamingIdleTimeout, idleTimeoutMs);
  };
  const onNonemptyChunk = () => {
    if (!firstUpstreamByteObserved) {
      firstUpstreamByteObserved = true;
      options.onFirstUpstreamByte?.();
    }
    refreshIdleTimeout();
  };
  const phase = options.enableResponsesLifecycleGate
    ? "responses_pre_output_gate"
    : "streaming_prefix_gate";

  const makePass = (diagnostic?: StreamingResponsePrefixDiagnostic) => ({
    kind: "pass" as const,
    response: replayResponse(response, reader, prefixChunks),
    ...(diagnostic ? { diagnostic } : {}),
  });

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        const rawText = new TextDecoder().decode(concatChunks(prefixChunks, bufferedBytes));
        const jsonDecision = inspectCompleteJsonPayload(rawText, true);
        if (jsonDecision?.kind === "fake_200") {
          return {
            ...jsonDecision,
            rawText,
            rawBodyTruncated: false,
            diagnostic: buildDiagnostic(diagnostics, {
              phase,
              observedBytes: bufferedBytes,
              prefixCapBytes: maxBytes,
              rawBodyTruncated: false,
              streamEndedDuringInspection: true,
              detectorCode: jsonDecision.code,
              error: jsonDecision,
            }),
          };
        }
        if (jsonDecision?.kind === "pass") return makePass();

        const remaining = rawText.slice(sseEventStart);
        const finalSseDecision = inspectCompleteSseEvent(
          remaining,
          options.enableResponsesLifecycleGate === true,
          diagnostics
        );
        if (finalSseDecision?.kind === "fake_200") {
          return {
            ...finalSseDecision,
            rawText,
            rawBodyTruncated: false,
            diagnostic: buildDiagnostic(diagnostics, {
              phase,
              observedBytes: bufferedBytes,
              prefixCapBytes: maxBytes,
              rawBodyTruncated: false,
              streamEndedDuringInspection: true,
              detectorCode: finalSseDecision.code,
              error: finalSseDecision,
            }),
          };
        }
        return makePass();
      }

      if (!next.value || next.value.byteLength === 0) continue;
      onNonemptyChunk();
      const chunk = next.value.slice();
      prefixChunks.push(chunk);
      bufferedBytes += chunk.byteLength;

      const inspectedBytes = concatChunks(prefixChunks, Math.min(bufferedBytes, maxBytes));
      const rawText = new TextDecoder().decode(inspectedBytes);
      const jsonDecision = inspectCompleteJsonPayload(rawText, false);
      if (jsonDecision?.kind === "fake_200") {
        await reader.cancel("fake_200").catch(() => undefined);
        return {
          ...jsonDecision,
          rawText,
          rawBodyTruncated: true,
          diagnostic: buildDiagnostic(diagnostics, {
            phase,
            observedBytes: bufferedBytes,
            prefixCapBytes: maxBytes,
            rawBodyTruncated: true,
            streamEndedDuringInspection: false,
            detectorCode: jsonDecision.code,
            error: jsonDecision,
          }),
        };
      }
      if (jsonDecision?.kind === "pass") return makePass();

      let decision: PrefixDecision = { kind: "need_more" };
      while (true) {
        const boundary = findSseEventBoundary(rawText, sseEventStart);
        if (!boundary) break;
        const eventText = rawText.slice(sseEventStart, boundary.end);
        sseEventStart = boundary.next;
        const eventDecision = inspectCompleteSseEvent(
          eventText,
          options.enableResponsesLifecycleGate === true,
          diagnostics
        );
        if (!eventDecision || eventDecision.kind === "need_more") continue;
        decision = eventDecision;
        break;
      }

      if (decision.kind === "fake_200") {
        await reader.cancel("fake_200").catch(() => undefined);
        return {
          ...decision,
          rawText,
          rawBodyTruncated: true,
          diagnostic: buildDiagnostic(diagnostics, {
            phase,
            observedBytes: bufferedBytes,
            prefixCapBytes: maxBytes,
            rawBodyTruncated: true,
            streamEndedDuringInspection: false,
            detectorCode: decision.code,
            error: decision,
          }),
        };
      }
      if (decision.kind === "pass") return makePass();
      if (bufferedBytes >= maxBytes) {
        return makePass(
          buildDiagnostic(diagnostics, {
            phase: "prefix_cap_fail_open",
            observedBytes: bufferedBytes,
            prefixCapBytes: maxBytes,
            rawBodyTruncated: true,
            streamEndedDuringInspection: false,
            detectorCode: "STREAMING_RESPONSE_PREFIX_LIMIT_REACHED",
          })
        );
      }
    }
  } finally {
    clearIdleTimeout();
  }
}

function concatChunks(chunks: Uint8Array[], maxBytes: number): Uint8Array {
  const output = new Uint8Array(maxBytes);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= maxBytes) break;
    const remaining = maxBytes - offset;
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    output.set(slice, offset);
    offset += slice.byteLength;
  }
  return offset === output.byteLength ? output : output.slice(0, offset);
}
