import { getEnvConfig } from "@/lib/config/env.schema";
import { detectUpstreamErrorFromSseOrJsonText } from "@/lib/utils/upstream-error-detection";
import {
  type ResponsesStreamCommitMarker,
  type ResponsesStreamGateCaps,
  type ResponsesStreamGateFailureReason,
  type ResponsesStreamGateMode,
  type ResponsesStreamGateResult,
  resolveResponsesStreamGateCaps,
  resolveResponsesStreamGateMode,
  runResponsesStreamContentGate,
} from "./stream-gate/responses-content-gate";
import {
  createResponsesStreamShadowObserver,
  type ResponsesStreamShadowDiagnostic,
} from "./stream-gate/responses-shadow-observer";

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
  phase:
    | "responses_pre_output_gate"
    | "responses_semantic_gate"
    | "streaming_prefix_gate"
    | "prefix_cap_fail_open";
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

export type StreamingResponseSemanticDiagnostic = {
  mode: "shadow" | "enforce";
  outcome: "content" | ResponsesStreamGateFailureReason;
  divergentFromLegacy: boolean;
  framesSeen: number;
  bufferedBytes: number;
  echoExcludedBytes: number;
  observedEventTypes: readonly string[];
  eventTypesTruncated: boolean;
  marker?: ResponsesStreamCommitMarker;
};

export type StreamingResponsePrefixInspection =
  | {
      kind: "pass";
      response: Response;
      diagnostic?: StreamingResponsePrefixDiagnostic;
      commitMarker?: ResponsesStreamCommitMarker;
      semanticDiagnostic?: StreamingResponseSemanticDiagnostic;
      /** 仅当预提交心跳已启动(response 已对下游提交 200)时存在。 */
      precommitHeartbeat?: PrecommitHeartbeatDiagnostic;
    }
  | {
      kind: "fake_200";
      code: string;
      detail?: string;
      rawText: string;
      /** Bounded full prefix text for downstream signal detection (never persisted). */
      prefixText: string;
      rawBodyTruncated: boolean;
      diagnostic: StreamingResponsePrefixDiagnostic;
    }
  | {
      kind: "upstream_failure";
      code: string;
      reason: Exclude<ResponsesStreamGateFailureReason, "read_error">;
      /** Bounded full prefix text for downstream signal detection (never persisted). */
      prefixText: string;
      diagnostic: StreamingResponsePrefixDiagnostic;
      semanticDiagnostic: StreamingResponseSemanticDiagnostic;
    };

export type PrecommitHeartbeatConfig = {
  /** 首拍延迟;0 = 完全关闭(与历史行为逐字节等价)。 */
  delayMs: number;
  intervalMs: number;
  /** 心跳总时长上限,超限以 response.failed 收尾,防无限挂起。 */
  maxMs: number;
};

export type PrecommitHeartbeatOutcome = "pending" | "pass" | "failed" | "expired" | "cancelled";

export type PrecommitHeartbeatDiagnostic = {
  beats: number;
  outcome: PrecommitHeartbeatOutcome;
};

export type PrecommitHeartbeatEvent =
  | { type: "started"; delayMs: number; intervalMs: number; maxMs: number }
  | {
      type: "outcome";
      outcome: Exclude<PrecommitHeartbeatOutcome, "pending">;
      beats: number;
      /** 内部遥测用原始码(如 fake_200 检测码);客户端 payload 恒为 server_error。 */
      code?: string;
    };

export const PRECOMMIT_HEARTBEAT_FRAME = ": ping\n\n";

export function resolvePrecommitHeartbeatConfig(): PrecommitHeartbeatConfig {
  try {
    const env = getEnvConfig();
    return {
      delayMs: env.STREAM_GATE_HEARTBEAT_DELAY_MS,
      intervalMs: env.STREAM_GATE_HEARTBEAT_INTERVAL_MS,
      maxMs: env.STREAM_GATE_HEARTBEAT_MAX_MS,
    };
  } catch {
    return { delayMs: 0, intervalMs: 15_000, maxMs: 300_000 };
  }
}

/**
 * 心跳期迟到失败的流内终止事件。
 *
 * Codex CLI 的 SSE 匹配臂只认 `response.failed`(不认 `error`/`response.error`
 * 事件名);错误码必须避开其致命闭集(server_is_overloaded / slow_down /
 * context window / quota / usage / capacity / policy 关键词),否则客户端会
 * 终止会话而不重试。文案同理保持中性。内部日志与决策链保留原始分类。
 */
function buildPrecommitHeartbeatFailedFrame(reason: string): Uint8Array {
  const payload = {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: "resp_precommit_heartbeat",
      error: { code: "server_error", message: reason },
    },
  };
  return new TextEncoder().encode(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`);
}

type InspectStreamingResponsePrefixOptions = {
  maxBytes?: number;
  /** Enable the multi-event hold only for the canonical OpenAI Responses SSE protocol. */
  enableResponsesLifecycleGate?: boolean;
  responsesGateMode?: ResponsesStreamGateMode;
  responsesGateCaps?: ResponsesStreamGateCaps;
  /** Called exactly once when a nonempty upstream body chunk first reaches this gate. */
  onFirstUpstreamByte?: () => void;
  /** The gate owns this watchdog only while it holds pre-output lifecycle events. */
  streamingIdleTimeoutMs?: number;
  onStreamingIdleTimeout?: () => void;
  /** Receives bounded shadow-mode divergences after legacy bytes have already been released. */
  onResponsesShadowDiagnostic?: (diagnostic: ResponsesStreamShadowDiagnostic) => void;
  /** 覆盖 env 解析的心跳配置(测试注入用);缺省读 STREAM_GATE_HEARTBEAT_*。 */
  precommitHeartbeat?: PrecommitHeartbeatConfig;
  /** 预提交心跳生命周期遥测(启动/结局),由 forwarder 侧接线记日志。 */
  onPrecommitHeartbeat?: (event: PrecommitHeartbeatEvent) => void;
};

type PrefixDecision =
  | { kind: "need_more" }
  | { kind: "pass"; eventType: string | null }
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
  dataText: string;
  data: unknown;
};

type DiagnosticState = {
  observedEventTypes: string[];
  eventCountObserved: number;
  eventTypesTruncated: boolean;
  lastEventType: string | null;
  echoExcludedBytes: number;
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
    dataText,
    data,
  };
}

function extractDiagnosticError(data: unknown, eventName?: string): UpstreamErrorDiagnostic {
  if (!isPlainRecord(data)) return {};

  const response = isPlainRecord(data.response) ? data.response : null;
  const topLevelErrorCandidate =
    typeof data.code === "string" || typeof data.message === "string" ? data : undefined;
  const isResponseFailure = data.type === "response.failed" || eventName === "response.failed";
  const errorValue =
    data.error ??
    (isResponseFailure ? (response?.error ?? topLevelErrorCandidate) : undefined) ??
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
  diagnostics.lastEventType = eventType || null;
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return eof ? { kind: "pass", eventType: null } : { kind: "need_more" };
  }

  const detected = detectUpstreamErrorFromSseOrJsonText(trimmed);
  if (!detected.isError) {
    const eventType =
      isPlainRecord(parsed) && typeof parsed.type === "string" ? parsed.type.trim() || null : null;
    return { kind: "pass", eventType };
  }
  return {
    kind: "fake_200",
    code: detected.code,
    detail: detected.detail,
    ...extractDiagnosticError(parsed),
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
  if (RESPONSES_PRE_OUTPUT_EVENT_TYPES.has(event.eventType ?? "")) {
    diagnostics.echoExcludedBytes += Buffer.byteLength(event.dataText, "utf8");
  }
  const detected = detectUpstreamErrorFromSseOrJsonText(eventText);
  if (detected.isError) {
    return {
      kind: "fake_200",
      code: detected.code,
      detail: detected.detail,
      ...extractDiagnosticError(event.data, event.eventName),
    };
  }

  if (!enableResponsesLifecycleGate) {
    return { kind: "pass", eventType: event.eventType ?? null };
  }
  return RESPONSES_PRE_OUTPUT_EVENT_TYPES.has(event.eventType ?? "")
    ? { kind: "need_more" }
    : { kind: "pass", eventType: event.eventType ?? null };
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

function observeResponseWithoutHolding(
  response: Response,
  observer: ReturnType<typeof createResponsesStreamShadowObserver>
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          observer.finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
        observer.observe(next.value);
      } catch (error) {
        observer.fail();
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

const responseCommitMarkers = new WeakMap<Response, ResponsesStreamCommitMarker>();

function attachResponseCommitMarker(
  response: Response,
  marker: ResponsesStreamCommitMarker
): Response {
  responseCommitMarkers.set(response, marker);
  return response;
}

export function consumeStreamingResponseCommitMarker(
  response: Response
): ResponsesStreamCommitMarker | null {
  const marker = responseCommitMarkers.get(response) ?? null;
  if (marker) responseCommitMarkers.delete(response);
  return marker;
}

function semanticDiagnostic(
  gate: ResponsesStreamGateResult,
  mode: "shadow" | "enforce",
  outcome: StreamingResponseSemanticDiagnostic["outcome"],
  marker?: ResponsesStreamCommitMarker
): StreamingResponseSemanticDiagnostic {
  return {
    mode,
    outcome,
    divergentFromLegacy: gate.committed
      ? gate.legacyGateAlreadyCommitted
      : gate.reason !== "read_error" &&
        (gate.legacyGateAlreadyCommitted || gate.reason !== "gate_error"),
    framesSeen: gate.diagnostic.framesSeen,
    bufferedBytes: gate.diagnostic.bufferedBytes,
    echoExcludedBytes: gate.diagnostic.echoExcludedBytes,
    observedEventTypes: gate.diagnostic.observedEventTypes,
    eventTypesTruncated: gate.diagnostic.eventTypesTruncated,
    ...(marker ? { marker } : {}),
  };
}

function semanticPrefixDiagnostic(
  gate: Exclude<ResponsesStreamGateResult, { committed: true }>,
  caps: ResponsesStreamGateCaps,
  detectorCode: string,
  rawBodyTruncated: boolean,
  error?: UpstreamErrorDiagnostic
): StreamingResponsePrefixDiagnostic {
  return {
    phase: "responses_semantic_gate",
    observedBytes: gate.diagnostic.bufferedBytes,
    prefixCapBytes: caps.prebufferByteCap + caps.requestEchoByteCap,
    rawBodyTruncated,
    streamEndedDuringInspection: gate.readerDone,
    observedEventTypes: gate.diagnostic.observedEventTypes,
    eventCountObserved: gate.diagnostic.framesSeen,
    eventTypesTruncated: gate.diagnostic.eventTypesTruncated,
    detectorCode: truncateDiagnosticString(detectorCode),
    ...error,
  };
}

function extractSemanticErrorDiagnostic(text: string, eventType: string | null) {
  if (!text) return {};
  try {
    return extractDiagnosticError(JSON.parse(text) as unknown, eventType ?? undefined);
  } catch {
    return {};
  }
}

function buildBoundedSemanticErrorEnvelope(diagnostic: UpstreamErrorDiagnostic): string {
  const error: Record<string, string | boolean> = {};
  if (diagnostic.upstreamErrorCode) error.code = diagnostic.upstreamErrorCode;
  if (diagnostic.upstreamErrorType) error.type = diagnostic.upstreamErrorType;
  if (Object.keys(error).length === 0) error.present = true;
  return JSON.stringify({ error });
}

// Bounded prefix text for downstream signal detection (e.g. cyber safety signals) on
// precommit-failure streams. The gate deliberately keeps the free-form failure frame out of
// ProxyError bodies; this bounded text is a transient detection input, never persisted.
const MAX_PREFIX_TEXT_FOR_SIGNAL_DETECTION = 32 * 1024;

function buildBoundedPrefixText(chunks: Uint8Array[]): { text: string; truncated: boolean } {
  const decoder = new TextDecoder();
  let remaining = MAX_PREFIX_TEXT_FOR_SIGNAL_DETECTION;
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    parts.push(decoder.decode(slice));
    remaining -= slice.length;
  }
  return { text: parts.join(""), truncated: remaining <= 0 };
}

async function inspectResponsesSemanticPrefix(
  response: Response,
  options: InspectStreamingResponsePrefixOptions
): Promise<StreamingResponsePrefixInspection> {
  if (!response.body) return { kind: "pass", response };

  const reader = response.body.getReader();
  const gateCaps = options.responsesGateCaps ?? resolveResponsesStreamGateCaps();
  const idleTimeoutMs = options.streamingIdleTimeoutMs ?? 0;
  let idleTimeoutId: NodeJS.Timeout | null = null;
  const clearIdleTimeout = () => {
    if (!idleTimeoutId) return;
    clearTimeout(idleTimeoutId);
    idleTimeoutId = null;
  };
  const refreshIdleTimeout = () => {
    if (idleTimeoutMs <= 0 || !options.onStreamingIdleTimeout) return;
    clearIdleTimeout();
    idleTimeoutId = setTimeout(options.onStreamingIdleTimeout, idleTimeoutMs);
  };

  let gate: ResponsesStreamGateResult;
  try {
    gate = await runResponsesStreamContentGate(reader, {
      ...gateCaps,
      onFirstByte: options.onFirstUpstreamByte,
      onChunk: refreshIdleTimeout,
    });
  } finally {
    clearIdleTimeout();
  }

  if (!gate.committed && gate.reason === "read_error") {
    throw gate.cause ?? new Error("upstream stream read failed during Responses precommit gate");
  }

  if (gate.committed) {
    const committedResponse = attachResponseCommitMarker(
      replayResponse(response, reader, gate.prefixChunks),
      gate.commitMarker
    );
    return {
      kind: "pass",
      response: committedResponse,
      commitMarker: gate.commitMarker,
    };
  }

  const frameData = gate.frameData ?? "";
  const errorDiagnostic = extractSemanticErrorDiagnostic(frameData, gate.eventType);
  const boundedErrorEnvelope =
    gate.reason === "gate_error" ? buildBoundedSemanticErrorEnvelope(errorDiagnostic) : "";
  const envelopeDetection =
    gate.reason === "gate_error"
      ? detectUpstreamErrorFromSseOrJsonText(boundedErrorEnvelope)
      : ({ isError: false } as const);
  const detected = envelopeDetection;
  // Never let a structured Responses failure frame cross into the generic
  // ProxyError path. Even a small frame may echo instructions or partial
  // output. The bounded envelope deliberately excludes the free-form error
  // message because ProxyError.body is persisted in the provider decision
  // chain; protocol code/type are sufficient for overload classification.
  const boundedPrefix = buildBoundedPrefixText(gate.prefixChunks);
  const inspectionText = gate.reason === "gate_error" ? boundedErrorEnvelope : boundedPrefix.text;
  const rawBodyTruncated = gate.reason === "gate_error" || boundedPrefix.truncated;
  const detectorCode = detected.isError
    ? detected.code
    : `STREAM_GATE_${gate.reason.toUpperCase()}`;
  const diagnostic = semanticPrefixDiagnostic(
    gate,
    gateCaps,
    detectorCode,
    rawBodyTruncated,
    errorDiagnostic
  );

  if (gate.reason === "gate_error" && detected.isError) {
    await reader.cancel("fake_200").catch(() => undefined);
    return {
      kind: "fake_200",
      code: detected.code,
      detail: detected.detail,
      rawText: inspectionText,
      prefixText: boundedPrefix.text,
      rawBodyTruncated,
      diagnostic,
    };
  }
  await reader.cancel("stream_gate_precommit").catch(() => undefined);
  return {
    kind: "upstream_failure",
    code: detectorCode,
    reason: gate.reason === "read_error" ? "decode_error" : gate.reason,
    prefixText: boundedPrefix.text,
    diagnostic,
    semanticDiagnostic: semanticDiagnostic(gate, "enforce", gate.reason),
  };
}

async function inspectResponsesShadowPrefix(
  response: Response,
  options: InspectStreamingResponsePrefixOptions
): Promise<StreamingResponsePrefixInspection> {
  const legacy = await inspectLegacyStreamingResponsePrefix(response, {
    ...options,
    responsesGateMode: "shadow",
  });
  if (legacy.kind !== "pass" || !legacy.commitMarker || !legacy.response.body) return legacy;

  const observer = createResponsesStreamShadowObserver({
    caps: options.responsesGateCaps ?? resolveResponsesStreamGateCaps(),
    legacyCommitMarker: legacy.commitMarker,
    onDiagnostic: options.onResponsesShadowDiagnostic,
  });
  const observedResponse = attachResponseCommitMarker(
    observeResponseWithoutHolding(legacy.response, observer),
    legacy.commitMarker
  );
  return {
    ...legacy,
    response: observedResponse,
  };
}

type PrecommitHeartbeatQueueItem =
  | { kind: "frame"; chunk: Uint8Array }
  | { kind: "pipe"; reader: ReadableStreamDefaultReader<Uint8Array> }
  | { kind: "fail"; reason: string };

/**
 * 心跳已提交后,上游检查仍在等待首帧:此 Response 对下游先发注释心跳,
 * 内层检查决出后回放其 pass 响应体,或以 response.failed 流内收尾。
 *
 * 记账契约(与 sub2api #3887 加固审计对齐):心跳帧不是语义输出——
 * response-handler 侧凭 sseChunkIsCommentOnly 不将其记为 TTFB 首块;
 * usage/finalization 的 SSE 解析天然忽略注释行。
 */
function buildPrecommitHeartbeatResponse(
  upstream: Response,
  inner: Promise<StreamingResponsePrefixInspection>,
  config: PrecommitHeartbeatConfig,
  diagnostic: PrecommitHeartbeatDiagnostic,
  onEvent?: (event: PrecommitHeartbeatEvent) => void
): Response {
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  let timerId: ReturnType<typeof setInterval> | null = null;
  const queue: PrecommitHeartbeatQueueItem[] = [];
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const settle = (outcome: Exclude<PrecommitHeartbeatOutcome, "pending">, code?: string) => {
    if (diagnostic.outcome !== "pending") return;
    diagnostic.outcome = outcome;
    onEvent?.({ type: "outcome", outcome, beats: diagnostic.beats, ...(code ? { code } : {}) });
  };
  const stopTimers = () => {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  };

  const heartbeatChunk = new TextEncoder().encode(PRECOMMIT_HEARTBEAT_FRAME);
  const deadline = Date.now() + config.maxMs;
  timerId = setInterval(() => {
    if (cancelled || diagnostic.outcome !== "pending") return;
    if (Date.now() >= deadline) {
      queue.push({ kind: "fail", reason: "gateway stopped waiting for upstream output" });
      settle("expired");
      stopTimers();
      notify();
      return;
    }
    diagnostic.beats += 1;
    queue.push({ kind: "frame", chunk: heartbeatChunk });
    notify();
  }, config.intervalMs);

  inner.then(
    (result) => {
      stopTimers();
      // 客户端已断开,或心跳期已超限收尾:pass 结果只需释放底层资源。
      if (cancelled || diagnostic.outcome !== "pending") {
        if (result.kind === "pass") {
          void result.response.body?.cancel("precommit_heartbeat_settled").catch(() => undefined);
        }
        return;
      }
      if (result.kind === "pass") {
        if (result.response.body) {
          queue.push({ kind: "pipe", reader: result.response.body.getReader() });
          settle("pass");
        } else {
          queue.push({ kind: "fail", reason: "upstream stream ended before first output" });
          settle("failed");
        }
        notify();
        return;
      }
      queue.push({ kind: "fail", reason: "upstream stream ended before first output" });
      settle("failed", result.code);
      notify();
    },
    () => {
      stopTimers();
      if (cancelled || diagnostic.outcome !== "pending") return;
      queue.push({ kind: "fail", reason: "upstream stream failed before first output" });
      settle("failed");
      notify();
    }
  );

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (activeReader) {
          try {
            const next = await activeReader.read();
            if (next.done) {
              activeReader = null;
              controller.close();
              return;
            }
            controller.enqueue(next.value);
            return;
          } catch (error) {
            activeReader = null;
            controller.error(error);
            return;
          }
        }
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const item = queue.shift();
        if (!item) continue;
        if (item.kind === "frame") {
          controller.enqueue(item.chunk);
          return;
        }
        if (item.kind === "pipe") {
          activeReader = item.reader;
          continue;
        }
        stopTimers();
        controller.enqueue(buildPrecommitHeartbeatFailedFrame(item.reason));
        controller.close();
      }
    },
    async cancel(reason) {
      cancelled = true;
      stopTimers();
      settle("cancelled");
      if (activeReader) {
        const reader = activeReader;
        activeReader = null;
        await reader.cancel(reason).catch(() => undefined);
      }
      // inner 未决出时,其结果在 inner.then 的清理分支里释放(cancelled 标志)。
    },
  });

  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.set("x-accel-buffering", "no");
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function runInnerInspection(
  response: Response,
  options: InspectStreamingResponsePrefixOptions
): Promise<StreamingResponsePrefixInspection> {
  if (!options.enableResponsesLifecycleGate) {
    return inspectLegacyStreamingResponsePrefix(response, options);
  }

  const mode = options.responsesGateMode ?? resolveResponsesStreamGateMode();
  if (mode === "off") {
    return inspectLegacyStreamingResponsePrefix(response, options);
  }
  if (mode === "shadow") {
    return inspectResponsesShadowPrefix(response, options);
  }
  return inspectResponsesSemanticPrefix(response, options);
}

export async function inspectStreamingResponsePrefix(
  response: Response,
  options: InspectStreamingResponsePrefixOptions = {}
): Promise<StreamingResponsePrefixInspection> {
  const heartbeatConfig = options.precommitHeartbeat ?? resolvePrecommitHeartbeatConfig();
  if (!response.body || heartbeatConfig.delayMs <= 0) {
    return runInnerInspection(response, options);
  }

  // 这不是任何"对冲/双发":只有一条上游请求在飞。Promise.race 在此仅实现
  // "给内层检查至多 delayMs 毫秒"的超时等待——先完成走原路径,超时才启动
  // 心跳并继续等同一个内层结果。
  const inner = runInnerInspection(response, options);
  let delayTimerId: ReturnType<typeof setTimeout> | undefined;
  const delayExpired = new Promise<{ kind: "timeout" }>((resolve) => {
    delayTimerId = setTimeout(() => resolve({ kind: "timeout" }), heartbeatConfig.delayMs);
  });
  const innerSettled = inner.then(
    (result): { kind: "inner"; result: StreamingResponsePrefixInspection } => ({
      kind: "inner",
      result,
    }),
    (error): { kind: "inner_error"; error: unknown } => ({ kind: "inner_error", error })
  );
  const firstSettled = await Promise.race([innerSettled, delayExpired]);
  clearTimeout(delayTimerId);

  if (firstSettled.kind === "inner") return firstSettled.result;
  if (firstSettled.kind === "inner_error") throw firstSettled.error;

  const diagnostic: PrecommitHeartbeatDiagnostic = { beats: 0, outcome: "pending" };
  options.onPrecommitHeartbeat?.({
    type: "started",
    delayMs: heartbeatConfig.delayMs,
    intervalMs: heartbeatConfig.intervalMs,
    maxMs: heartbeatConfig.maxMs,
  });
  const heartbeatResponse = buildPrecommitHeartbeatResponse(
    response,
    inner,
    heartbeatConfig,
    diagnostic,
    options.onPrecommitHeartbeat
  );
  return {
    kind: "pass",
    response: heartbeatResponse,
    precommitHeartbeat: diagnostic,
  };
}

async function inspectLegacyStreamingResponsePrefix(
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
    lastEventType: null,
    echoExcludedBytes: 0,
  };
  let bufferedBytes = 0;
  let chunkIndex = 0;
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

  const makePass = (
    diagnostic?: StreamingResponsePrefixDiagnostic,
    eventType: string | null = diagnostics.lastEventType
  ): Extract<StreamingResponsePrefixInspection, { kind: "pass" }> => {
    const marker: ResponsesStreamCommitMarker | undefined =
      options.enableResponsesLifecycleGate && options.responsesGateMode === "shadow"
        ? {
            verdict: "shadow_pass",
            eventType: eventType ? truncateDiagnosticString(eventType) : null,
            frameIndex: diagnostics.eventCountObserved,
            chunkIndex,
            bufferedBytes,
            echoExcludedBytes: diagnostics.echoExcludedBytes,
          }
        : undefined;
    return {
      kind: "pass",
      response: replayResponse(response, reader, prefixChunks),
      ...(diagnostic ? { diagnostic } : {}),
      ...(marker ? { commitMarker: marker } : {}),
    };
  };

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
            prefixText: rawText,
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
        if (jsonDecision?.kind === "pass") return makePass(undefined, jsonDecision.eventType);

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
            prefixText: rawText,
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
      chunkIndex += 1;

      const inspectedBytes = concatChunks(prefixChunks, Math.min(bufferedBytes, maxBytes));
      const rawText = new TextDecoder().decode(inspectedBytes);
      const jsonDecision = inspectCompleteJsonPayload(rawText, false);
      if (jsonDecision?.kind === "fake_200") {
        await reader.cancel("fake_200").catch(() => undefined);
        return {
          ...jsonDecision,
          rawText,
          prefixText: rawText,
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
      if (jsonDecision?.kind === "pass") return makePass(undefined, jsonDecision.eventType);

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
          prefixText: rawText,
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
      if (decision.kind === "pass") return makePass(undefined, decision.eventType);
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
