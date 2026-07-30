import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.warn,
  },
}));

import {
  getFake200SseDiagnosticLogRateLimitBucketCountForTests,
  logFake200SseDiagnostic,
  resetFake200SseDiagnosticLogRateLimitForTests,
} from "@/app/v1/_lib/proxy/fake-200-observability";

function logDiagnostic(
  overrides: Partial<Parameters<typeof logFake200SseDiagnostic>[0]> = {}
): void {
  logFake200SseDiagnostic({
    phase: "responses_pre_output_gate",
    highConcurrencyMode: true,
    providerId: 1,
    providerName: "capacity-a",
    endpointId: null,
    attemptNumber: 1,
    upstreamStatusCode: 200,
    contentTypeClass: "sse",
    downstreamCommitted: false,
    observedBytes: 256,
    prefixCapBytes: 32 * 1024,
    rawBodyTruncated: true,
    protocol: {
      observedEventTypes: ["response.created", "response.in_progress", "response.failed"],
      eventCountObserved: 3,
      eventTypesTruncated: false,
      detectorCode: "FAKE_200_JSON_ERROR_MESSAGE_NON_EMPTY",
      overloadMatcherId: "error_code_server_is_overloaded",
      inferredStatusCode: 503,
      upstreamErrorCode: "server_is_overloaded",
      upstreamErrorType: "service_unavailable_error",
      upstreamErrorMessageLength: 55,
    },
    ...overrides,
  });
}

describe("fake-200 SSE observability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T08:00:00.000Z"));
    vi.clearAllMocks();
    resetFake200SseDiagnosticLogRateLimitForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFake200SseDiagnosticLogRateLimitForTests();
  });

  it("logs a bounded redacted record and suppresses a capacity storm per provider/detector", () => {
    logDiagnostic();
    logDiagnostic();
    logDiagnostic();
    logDiagnostic();

    expect(mocks.warn).toHaveBeenCalledTimes(3);
    const firstRecord = mocks.warn.mock.calls[0]?.[1];
    expect(firstRecord).toMatchObject({
      event: "proxy.upstream_fake_200",
      phase: "responses_pre_output_gate",
      highConcurrencyMode: true,
      downstreamCommitted: false,
      providerId: 1,
      protocol: {
        observedEventTypes: ["response.created", "response.in_progress", "response.failed"],
        upstreamErrorCode: "server_is_overloaded",
        upstreamErrorType: "service_unavailable_error",
        upstreamErrorMessageLength: 55,
      },
    });
    expect(firstRecord).not.toHaveProperty("rawText");
    expect(firstRecord).not.toHaveProperty("rawBody");

    vi.advanceTimersByTime(60_000);
    logDiagnostic();

    expect(mocks.warn).toHaveBeenCalledTimes(4);
    expect(mocks.warn.mock.calls[3]?.[1]).toMatchObject({ suppressedSinceLastEmission: 1 });
  });

  it("keeps separate rate limits for different providers", () => {
    for (let index = 0; index < 4; index += 1) logDiagnostic();
    logDiagnostic({ providerId: 2, providerName: "capacity-b" });

    expect(mocks.warn).toHaveBeenCalledTimes(4);
    expect(mocks.warn.mock.calls[3]?.[1]).toMatchObject({ providerId: 2 });
  });

  it("caps process-local rate-limit state when provider identifiers churn", () => {
    for (let providerId = 0; providerId < 300; providerId += 1) {
      logDiagnostic({ providerId, providerName: `provider-${providerId}` });
    }

    expect(getFake200SseDiagnosticLogRateLimitBucketCountForTests()).toBe(256);
  });
});
