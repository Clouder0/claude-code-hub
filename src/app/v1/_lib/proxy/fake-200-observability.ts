import { logger } from "@/lib/logger";

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
  phase: "responses_pre_output_gate" | "streaming_prefix_gate" | "prefix_cap_fail_open";
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

const buckets = new Map<string, Fake200LogBucket>();

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

export function resetFake200SseDiagnosticLogRateLimitForTests(): void {
  buckets.clear();
}

export function getFake200SseDiagnosticLogRateLimitBucketCountForTests(): number {
  return buckets.size;
}
