import { logger } from "@/lib/logger";
import type {
  ResponsesStreamCommitMarker,
  ResponsesStreamGateFailureReason,
} from "./stream-gate/responses-content-gate";

const WINDOW_MS = 60_000;
const MAX_LOGS_PER_WINDOW = 3;
const MAX_BUCKETS = 256;
const MAX_PROVIDER_NAME_LENGTH = 96;
const MAX_EVENT_TYPES = 8;
const MAX_EVENT_TYPE_LENGTH = 128;
const MAX_DETECTOR_LENGTH = 128;

type Fake200LogBucket = {
  windowStartedAt: number;
  emitted: number;
  suppressed: number;
};

type Fake200ProtocolDiagnostic = {
  observedEventTypes: readonly string[];
  eventCountObserved: number;
  eventTypesTruncated: boolean;
  detectorCode: string;
  overloadMatcherId?: string;
  inferredStatusCode?: number;
  upstreamErrorCode?: string;
  upstreamErrorType?: string;
  upstreamErrorMessageLength?: number;
};

export type Fake200SseDiagnosticLog = {
  phase:
    | "responses_pre_output_gate"
    | "responses_semantic_gate"
    | "streaming_prefix_gate"
    | "prefix_cap_fail_open";
  highConcurrencyMode: boolean;
  providerId: number;
  providerName: string;
  endpointId: number | null;
  attemptNumber: number | null;
  upstreamStatusCode: number;
  contentTypeClass: "sse";
  downstreamCommitted: false;
  observedBytes: number;
  prefixCapBytes: number;
  rawBodyTruncated: boolean;
  protocol: Fake200ProtocolDiagnostic;
};

export type ResponsesStreamGateDiagnosticLog = {
  mode: "shadow" | "enforce";
  outcome: "content" | ResponsesStreamGateFailureReason;
  divergentFromLegacy: boolean;
  providerId: number;
  providerName: string;
  endpointId: number | null;
  attemptNumber: number | null;
  framesSeen: number;
  bufferedBytes: number;
  echoExcludedBytes: number;
  observedEventTypes: readonly string[];
  eventTypesTruncated: boolean;
  marker?: ResponsesStreamCommitMarker;
};

const buckets = new Map<string, Fake200LogBucket>();
const streamGateBuckets = new Map<string, Fake200LogBucket>();
const commitBuckets = new Map<string, Fake200LogBucket>();
const COMMIT_WINDOW_MS = 600_000;
const COMMIT_MAX_LOGS_PER_WINDOW = 8;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function buildBucketKey(diagnostic: Fake200SseDiagnosticLog): string {
  return [
    diagnostic.providerId,
    truncate(diagnostic.protocol.detectorCode, MAX_DETECTOR_LENGTH),
    diagnostic.protocol.overloadMatcherId
      ? truncate(diagnostic.protocol.overloadMatcherId, MAX_DETECTOR_LENGTH)
      : "none",
  ].join(":");
}

function getBucket(key: string, now: number): Fake200LogBucket {
  const existing = buckets.get(key);
  if (existing) {
    // Map insertion order is used as a small LRU. This bounds memory even when a misbehaving
    // upstream fabricates arbitrary error codes.
    buckets.delete(key);
    buckets.set(key, existing);
    if (now - existing.windowStartedAt >= WINDOW_MS) {
      existing.windowStartedAt = now;
      existing.emitted = 0;
    }
    return existing;
  }

  if (buckets.size >= MAX_BUCKETS) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey) buckets.delete(oldestKey);
  }

  const bucket = { windowStartedAt: now, emitted: 0, suppressed: 0 };
  buckets.set(key, bucket);
  return bucket;
}

/**
 * Log only exceptional pre-commit gate decisions. The process-local limiter deliberately has no
 * Redis/DB dependency: a provider capacity incident must not create a second dependency incident.
 */
export function logFake200SseDiagnostic(diagnostic: Fake200SseDiagnosticLog): void {
  const now = Date.now();
  const bucket = getBucket(buildBucketKey(diagnostic), now);
  if (bucket.emitted >= MAX_LOGS_PER_WINDOW) {
    bucket.suppressed += 1;
    return;
  }

  const suppressedSinceLastEmission = bucket.suppressed;
  bucket.emitted += 1;
  bucket.suppressed = 0;

  logger.warn(
    diagnostic.phase === "prefix_cap_fail_open"
      ? "ProxyForwarder: Streaming response prefix cap reached before downstream commitment"
      : "ProxyForwarder: Fake-200 SSE detected before downstream commitment",
    {
      event:
        diagnostic.phase === "prefix_cap_fail_open"
          ? "proxy.streaming_response_prefix_cap"
          : "proxy.upstream_fake_200",
      ...diagnostic,
      providerName: truncate(diagnostic.providerName, MAX_PROVIDER_NAME_LENGTH),
      protocol: {
        ...diagnostic.protocol,
        observedEventTypes: diagnostic.protocol.observedEventTypes
          .slice(0, MAX_EVENT_TYPES)
          .map((eventType) => truncate(eventType, MAX_EVENT_TYPE_LENGTH)),
      },
      ...(suppressedSinceLastEmission > 0 ? { suppressedSinceLastEmission } : {}),
    }
  );
}

/** Log only bounded semantic-gate divergences and fail-closed decisions. */
export function logResponsesStreamGateDiagnostic(
  diagnostic: ResponsesStreamGateDiagnosticLog
): void {
  const now = Date.now();
  const key = [diagnostic.providerId, diagnostic.mode, diagnostic.outcome].join(":");
  const existing = streamGateBuckets.get(key);
  let bucket: Fake200LogBucket;
  if (existing) {
    streamGateBuckets.delete(key);
    streamGateBuckets.set(key, existing);
    if (now - existing.windowStartedAt >= WINDOW_MS) {
      existing.windowStartedAt = now;
      existing.emitted = 0;
    }
    bucket = existing;
  } else {
    if (streamGateBuckets.size >= MAX_BUCKETS) {
      const oldestKey = streamGateBuckets.keys().next().value;
      if (oldestKey) streamGateBuckets.delete(oldestKey);
    }
    bucket = { windowStartedAt: now, emitted: 0, suppressed: 0 };
    streamGateBuckets.set(key, bucket);
  }

  if (bucket.emitted >= MAX_LOGS_PER_WINDOW) {
    bucket.suppressed += 1;
    return;
  }
  const suppressedSinceLastEmission = bucket.suppressed;
  bucket.emitted += 1;
  bucket.suppressed = 0;

  const fields = {
    event: "proxy.responses_stream_gate",
    mode: diagnostic.mode,
    outcome: diagnostic.outcome,
    divergentFromLegacy: diagnostic.divergentFromLegacy,
    providerId: diagnostic.providerId,
    providerName: truncate(diagnostic.providerName, MAX_PROVIDER_NAME_LENGTH),
    endpointId: diagnostic.endpointId,
    attemptNumber: diagnostic.attemptNumber,
    framesSeen: diagnostic.framesSeen,
    bufferedBytes: diagnostic.bufferedBytes,
    echoExcludedBytes: diagnostic.echoExcludedBytes,
    observedEventTypes: diagnostic.observedEventTypes
      .slice(0, MAX_EVENT_TYPES)
      .map((eventType) => truncate(eventType, MAX_EVENT_TYPE_LENGTH)),
    eventTypesTruncated: diagnostic.eventTypesTruncated,
    ...(diagnostic.marker
      ? {
          marker: {
            ...diagnostic.marker,
            eventType: diagnostic.marker.eventType
              ? truncate(diagnostic.marker.eventType, MAX_EVENT_TYPE_LENGTH)
              : null,
          },
        }
      : {}),
    ...(suppressedSinceLastEmission > 0 ? { suppressedSinceLastEmission } : {}),
  };

  if (diagnostic.mode === "shadow") {
    logger.info("ProxyForwarder: Responses stream gate shadow divergence", fields);
  } else {
    logger.warn("ProxyForwarder: Responses stream rejected before content commitment", fields);
  }
}

export function resetFake200SseDiagnosticLogRateLimitForTests(): void {
  buckets.clear();
  streamGateBuckets.clear();
  commitBuckets.clear();
}

export function getFake200SseDiagnosticLogRateLimitBucketCountForTests(): number {
  return buckets.size + streamGateBuckets.size + commitBuckets.size;
}

export type ResponsesStreamGateCommitObservationLog = {
  providerId: number;
  providerName: string;
  endpointId: number | null;
  framesSeen: number;
  bufferedBytes: number;
  echoExcludedBytes: number;
  observedEventTypes: readonly string[];
  eventTypesTruncated: boolean;
};

/**
 * enforce 模式成功 commit 的抽样观测。
 *
 * 现有 gate 诊断只覆盖失败/divergence 路径，成功流完全静默——既无法回答
 * "供应商是否在生命周期帧里回显大体积请求"（echoExcludedBytes 分布），也拿
 * 不到供应商健康的分母。这里按 provider 分桶限流输出成功 commit 的字节构成，
 * 补上两个盲区；info 级别，10 分钟窗口内每供应商至多 8 条。
 */
export function logResponsesStreamGateCommitObservation(
  observation: ResponsesStreamGateCommitObservationLog
): void {
  const now = Date.now();
  const key = String(observation.providerId);
  const existing = commitBuckets.get(key);
  let bucket: Fake200LogBucket;
  if (existing) {
    commitBuckets.delete(key);
    commitBuckets.set(key, existing);
    if (now - existing.windowStartedAt >= COMMIT_WINDOW_MS) {
      existing.windowStartedAt = now;
      existing.emitted = 0;
    }
    bucket = existing;
  } else {
    if (commitBuckets.size >= MAX_BUCKETS) {
      const oldestKey = commitBuckets.keys().next().value;
      if (oldestKey) commitBuckets.delete(oldestKey);
    }
    bucket = { windowStartedAt: now, emitted: 0, suppressed: 0 };
    commitBuckets.set(key, bucket);
  }

  if (bucket.emitted >= COMMIT_MAX_LOGS_PER_WINDOW) {
    bucket.suppressed += 1;
    return;
  }
  const suppressedSinceLastEmission = bucket.suppressed;
  bucket.emitted += 1;
  bucket.suppressed = 0;

  logger.info("ProxyForwarder: Responses stream gate committed", {
    event: "proxy.responses_stream_gate_commit",
    providerId: observation.providerId,
    providerName: truncate(observation.providerName, MAX_PROVIDER_NAME_LENGTH),
    endpointId: observation.endpointId,
    framesSeen: observation.framesSeen,
    bufferedBytes: observation.bufferedBytes,
    echoExcludedBytes: observation.echoExcludedBytes,
    observedEventTypes: observation.observedEventTypes
      .slice(0, MAX_EVENT_TYPES)
      .map((eventType) => truncate(eventType, MAX_EVENT_TYPE_LENGTH)),
    eventTypesTruncated: observation.eventTypesTruncated,
    ...(suppressedSinceLastEmission > 0 ? { suppressedSinceLastEmission } : {}),
  });
}
