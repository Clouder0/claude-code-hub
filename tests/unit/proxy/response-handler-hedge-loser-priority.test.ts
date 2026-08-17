import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMessageRequestHedgeLoserCost: vi.fn(
    async (_id: number, costUsd: unknown): Promise<string | null> => String(costUsd)
  ),
  detectUpstreamErrorFromSseOrJsonText: vi.fn(() => ({ isError: false })),
  isNonBillingEndpoint: vi.fn(() => false),
  trackCost: vi.fn(async () => {}),
  trackUserDailyCost: vi.fn(async () => {}),
  decrementLeaseBudget: vi.fn(async () => {}),
  updateSessionCostFromRequest: vi.fn(async () => {}),
  loggerWarn: vi.fn(),
}));

vi.mock("@/repository/message", () => ({
  addMessageRequestHedgeLoserCost: mocks.addMessageRequestHedgeLoserCost,
  updateMessageRequestCostWithBreakdown: vi.fn(),
  updateMessageRequestDetails: vi.fn(),
  updateMessageRequestDuration: vi.fn(),
  updateMessageRequestUnsupportedBillingSettlement: vi.fn(),
  updateMessageRequestWinnerCost: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock("@/lib/async-task-manager", () => ({
  AsyncTaskManager: {
    register: () => new AbortController(),
    touch: vi.fn(() => true),
    cleanup: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock("@/lib/utils/upstream-error-detection", () => ({
  detectUpstreamErrorFromSseOrJsonText: mocks.detectUpstreamErrorFromSseOrJsonText,
  inferUpstreamErrorStatusCodeFromText: vi.fn(() => null),
}));

vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: {
    trackCost: mocks.trackCost,
    trackUserDailyCost: mocks.trackUserDailyCost,
    decrementLeaseBudget: mocks.decrementLeaseBudget,
  },
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    updateSessionCostFromRequest: mocks.updateSessionCostFromRequest,
  },
}));

vi.mock(import("@/lib/utils/performance-formatter"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isNonBillingEndpoint: mocks.isNonBillingEndpoint,
  };
});

import { finalizeHedgeLoserBilling } from "@/app/v1/_lib/proxy/response-handler";
import type { Provider } from "@/types/provider";

function createCodexProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 11,
    name: "initial-codex-loser",
    url: "https://codex.example.com/v1",
    key: "sk-test",
    providerVendorId: null,
    isEnabled: true,
    weight: 1,
    priority: 0,
    groupPriorities: null,
    costMultiplier: 1,
    groupTag: null,
    providerType: "codex",
    preserveClientIp: false,
    modelRedirects: null,
    allowedModels: null,
    mcpPassthroughType: "none",
    mcpPassthroughUrl: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
    maxRetryAttempts: 1,
    circuitBreakerFailureThreshold: 5,
    circuitBreakerOpenDuration: 1_800_000,
    circuitBreakerHalfOpenSuccessThreshold: 2,
    proxyUrl: null,
    proxyFallbackToDirect: false,
    firstByteTimeoutStreamingMs: 0,
    streamingIdleTimeoutMs: 0,
    requestTimeoutNonStreamingMs: 0,
    websiteUrl: null,
    faviconUrl: null,
    cacheTtlPreference: null,
    context1mPreference: null,
    codexReasoningEffortPreference: null,
    codexReasoningSummaryPreference: null,
    codexTextVerbosityPreference: null,
    codexParallelToolCallsPreference: null,
    codexImageGenerationPreference: null,
    codexServiceTierPreference: null,
    anthropicMaxTokensPreference: null,
    anthropicThinkingBudgetPreference: null,
    anthropicAdaptiveThinking: null,
    geminiGoogleSearchPreference: null,
    tpm: 0,
    rpm: 0,
    rpd: 0,
    cc: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function createLoserSession(
  provider: Provider,
  overrides: {
    sessionId?: string | null;
    context1mApplied?: boolean;
    groupCostMultiplier?: number;
    requestSequence?: number;
    trackSessionObservability?: boolean;
  } = {}
) {
  return {
    provider,
    request: {
      model: "gpt-5.5",
      message: {
        model: "gpt-5.5",
        service_tier: "default",
      },
    },
    forwardedRequestBody: null as string | null,
    sessionId: overrides.sessionId ?? "session-1",
    requestSequence: overrides.requestSequence ?? 1,
    messageContext: { id: 123, createdAt: new Date("2026-06-08T00:00:00.000Z") },
    authState: {
      key: {
        id: 10,
        limit5hResetMode: "rolling",
        dailyResetTime: "00:00",
        dailyResetMode: "fixed",
      },
      user: {
        id: 20,
        limit5hResetMode: "rolling",
        dailyResetTime: "00:00",
        dailyResetMode: "fixed",
      },
    },
    getEndpoint: () => "/v1/responses",
    getManagedEndpoint: () => "/v1/responses",
    getOriginalModel() {
      return this.request.model;
    },
    getCurrentModel() {
      return this.request.model;
    },
    getBillingRequestMessage() {
      if (this.forwardedRequestBody) {
        return JSON.parse(this.forwardedRequestBody) as Record<string, unknown>;
      }
      return this.request.message;
    },
    getBillingModel() {
      const model = this.getBillingRequestMessage().model;
      return typeof model === "string" ? model : this.request.model;
    },
    getContext1mApplied: () => overrides.context1mApplied ?? false,
    setContext1mApplied: vi.fn(),
    getGroupCostMultiplier: () => overrides.groupCostMultiplier ?? 1,
    getSpecialSettings: () => [],
    addSpecialSetting: vi.fn(),
    shouldTrackSessionObservability: () => overrides.trackSessionObservability ?? false,
    getCodexPriorityBillingSource: vi.fn(async () => "requested"),
    getResolvedPricingByBillingSource: vi.fn(async () => ({
      resolvedModelName: "gpt-5.5",
      resolvedPricingProviderKey: "openai",
      source: "official_fallback",
      priceData: {
        input_cost_per_token: 1,
        output_cost_per_token: 10,
        input_cost_per_token_priority: 2,
        output_cost_per_token_priority: 20,
      },
    })),
  };
}

describe("finalizeHedgeLoserBilling isolated request accounting", () => {
  beforeEach(() => {
    mocks.addMessageRequestHedgeLoserCost.mockClear();
    mocks.detectUpstreamErrorFromSseOrJsonText.mockReturnValue({ isError: false });
    mocks.isNonBillingEndpoint.mockReturnValue(false);
    mocks.trackCost.mockClear();
    mocks.trackUserDailyCost.mockClear();
    mocks.decrementLeaseBudget.mockClear();
    mocks.updateSessionCostFromRequest.mockClear();
    mocks.loggerWarn.mockClear();
  });

  it("uses the loser's final requested service tier", async () => {
    const provider = createCodexProvider();
    const loserSession = createLoserSession(provider);
    loserSession.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.5",
      service_tier: "priority",
    });
    const responseBody = JSON.stringify({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
    });

    const billed = await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      provider,
      attemptNumber: 1,
      upstreamStatusCode: 200,
      allContent: responseBody,
      drainComplete: true,
    });

    expect(billed).toBe("400");
    expect(mocks.addMessageRequestHedgeLoserCost).toHaveBeenCalledTimes(1);
    expect(mocks.addMessageRequestHedgeLoserCost.mock.calls[0]?.[1].toString()).toBe("400");
  });

  it("tracks Redis loser cost with the loser's provider and multiplier", async () => {
    const loserProvider = createCodexProvider({
      id: 11,
      name: "initial-codex-loser",
      costMultiplier: 2,
    });
    const loserSession = createLoserSession(loserProvider, {
      context1mApplied: false,
      groupCostMultiplier: 3,
    });
    loserSession.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.5",
      service_tier: "priority",
    });
    const responseBody = JSON.stringify({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
    });

    const billed = await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      provider: loserProvider,
      attemptNumber: 1,
      upstreamStatusCode: 200,
      allContent: responseBody,
      drainComplete: true,
    });

    expect(billed).toBe("2400");
    expect(mocks.trackCost).toHaveBeenCalledTimes(1);
    expect(mocks.trackCost).toHaveBeenCalledWith(
      10,
      loserProvider.id,
      "session-1",
      2400,
      expect.objectContaining({
        userId: 20,
        requestId: 123,
        billingEventId: "123:hedge-loser:11:1",
      })
    );
    expect(mocks.trackUserDailyCost).toHaveBeenCalledWith(
      20,
      2400,
      "00:00",
      "fixed",
      expect.objectContaining({
        requestId: 123,
        billingEventId: "123:hedge-loser:11:1",
      })
    );
  });

  it("uses the original request identity when an alternative shadow loser has no session context", async () => {
    const loserProvider = createCodexProvider({ id: 22, name: "alternative-shadow-loser" });
    const shadowLoserSession = createLoserSession(loserProvider, { sessionId: null });
    shadowLoserSession.sessionId = null;
    shadowLoserSession.messageContext = null as never;
    const originalTrackingSession = createLoserSession(
      createCodexProvider({ id: 99, name: "winner" }),
      { sessionId: "original-session" }
    );
    const responseBody = JSON.stringify({
      usage: {
        input_tokens: 100,
        output_tokens: 10,
      },
    });

    const billed = await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: shadowLoserSession as any,
      trackingSession: originalTrackingSession as any,
      provider: loserProvider,
      attemptNumber: 2,
      upstreamStatusCode: 200,
      allContent: responseBody,
      drainComplete: true,
    });

    expect(billed).toBe("200");
    expect(mocks.trackCost).toHaveBeenCalledWith(
      10,
      loserProvider.id,
      "original-session",
      200,
      expect.objectContaining({
        userId: 20,
        requestId: 123,
        billingEventId: "123:hedge-loser:22:2",
      })
    );
    expect(mocks.trackUserDailyCost).toHaveBeenCalledWith(
      20,
      200,
      "00:00",
      "fixed",
      expect.objectContaining({
        requestId: 123,
        billingEventId: "123:hedge-loser:22:2",
      })
    );
  });

  it("publishes the authoritative request total to active-session cost after loser settlement", async () => {
    const provider = createCodexProvider();
    const loserSession = createLoserSession(provider);
    const trackingSession = createLoserSession(provider, {
      requestSequence: 4,
      trackSessionObservability: true,
    });
    mocks.addMessageRequestHedgeLoserCost.mockResolvedValueOnce("600");

    await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      trackingSession: trackingSession as any,
      provider,
      attemptNumber: 2,
      upstreamStatusCode: 200,
      allContent: JSON.stringify({ usage: { input_tokens: 100, output_tokens: 10 } }),
      drainComplete: true,
    });

    expect(mocks.updateSessionCostFromRequest).toHaveBeenCalledWith("session-1", 4, "600");
  });

  it("does not track Redis or lease cost when loser settlement is not durable", async () => {
    const provider = createCodexProvider();
    const loserSession = createLoserSession(provider);
    mocks.addMessageRequestHedgeLoserCost.mockRejectedValueOnce(
      new Error("Message request 123 not found after hedge-loser settlement")
    );

    const billed = await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      provider,
      attemptNumber: 2,
      upstreamStatusCode: 200,
      allContent: JSON.stringify({ usage: { input_tokens: 100, output_tokens: 10 } }),
      drainComplete: true,
    });

    expect(billed).toBeNull();
    expect(mocks.trackCost).not.toHaveBeenCalled();
    expect(mocks.trackUserDailyCost).not.toHaveBeenCalled();
    expect(mocks.decrementLeaseBudget).not.toHaveBeenCalled();
    expect(mocks.updateSessionCostFromRequest).not.toHaveBeenCalled();
  });

  it("persists ordinary GPT-5.6 input provenance for a hedge loser", async () => {
    const provider = createCodexProvider();
    const loserSession = createLoserSession(provider);
    loserSession.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.6-sol",
      service_tier: "default",
    });
    vi.mocked(loserSession.getResolvedPricingByBillingSource).mockResolvedValue({
      resolvedModelName: "gpt-5.6-sol",
      resolvedPricingProviderKey: "openai",
      source: "cloud_official",
      priceData: {
        slug: "gpt-5.6-sol",
        input_cost_per_token: 5 / 1_000_000,
        cache_read_input_token_cost: 0.5 / 1_000_000,
        cache_creation_input_token_cost: 6.25 / 1_000_000,
        output_cost_per_token: 30 / 1_000_000,
        input_cost_per_token_above_272k_tokens: 10 / 1_000_000,
        cache_read_input_token_cost_above_272k_tokens: 1 / 1_000_000,
        cache_creation_input_token_cost_above_272k_tokens: 12.5 / 1_000_000,
        output_cost_per_token_above_272k_tokens: 45 / 1_000_000,
        input_cost_per_token_priority: 10 / 1_000_000,
        cache_read_input_token_cost_priority: 1 / 1_000_000,
        cache_creation_input_token_cost_priority: 12.5 / 1_000_000,
        output_cost_per_token_priority: 60 / 1_000_000,
        openai_official_pricing_supplement: {
          id: "openai-gpt56-2026-06-30",
          source: "https://developers.openai.com/api/docs/pricing",
          applied_fields: ["input_cost_per_token_priority"],
          conflicting_fields: ["cache_creation_input_token_cost"],
        },
      },
    } as any);
    const responseBody = JSON.stringify({
      usage: {
        input_tokens: 9_016,
        input_tokens_details: {
          cached_tokens: 7_936,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      provider,
      attemptNumber: 2,
      upstreamStatusCode: 200,
      allContent: responseBody,
      drainComplete: true,
    });

    expect(mocks.addMessageRequestHedgeLoserCost).toHaveBeenCalledWith(
      123,
      expect.anything(),
      expect.objectContaining({
        inputTokens: 1_080,
        observedInputTokens: 9_016,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 7_936,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
        requestedServiceTier: "default",
        actualServiceTier: null,
        serviceTierResolvedFrom: "requested",
        effectivePriority: false,
        costBreakdown: expect.objectContaining({
          input: "0.0054",
          cache_creation_default: "0",
          total: "0.009518",
          pricing: expect.objectContaining({
            tier: "standard",
            price_book_model: "gpt-5.6-sol",
          }),
        }),
      })
    );
  });

  it("does not infer cache write from the loser's final explicit-cache request", async () => {
    const provider = createCodexProvider();
    const loserSession = createLoserSession(provider);
    loserSession.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.6-sol",
      prompt_cache_options: { mode: "explicit" },
    });
    vi.mocked(loserSession.getResolvedPricingByBillingSource).mockResolvedValue({
      resolvedModelName: "gpt-5.6-sol",
      resolvedPricingProviderKey: "openai",
      source: "cloud_official",
      priceData: {
        slug: "gpt-5.6-sol",
        input_cost_per_token: 5 / 1_000_000,
        cache_read_input_token_cost: 0.5 / 1_000_000,
        cache_creation_input_token_cost: 6.25 / 1_000_000,
        output_cost_per_token: 30 / 1_000_000,
        input_cost_per_token_above_272k_tokens: 10 / 1_000_000,
        cache_read_input_token_cost_above_272k_tokens: 1 / 1_000_000,
        cache_creation_input_token_cost_above_272k_tokens: 12.5 / 1_000_000,
        output_cost_per_token_above_272k_tokens: 45 / 1_000_000,
        input_cost_per_token_priority: 10 / 1_000_000,
        cache_read_input_token_cost_priority: 1 / 1_000_000,
        cache_creation_input_token_cost_priority: 12.5 / 1_000_000,
        output_cost_per_token_priority: 60 / 1_000_000,
      },
    } as any);

    await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      provider,
      attemptNumber: 1,
      upstreamStatusCode: 200,
      allContent: JSON.stringify({
        usage: {
          input_tokens: 9_016,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 5,
        },
      }),
      drainComplete: true,
    });

    expect(mocks.addMessageRequestHedgeLoserCost).toHaveBeenCalledWith(
      123,
      expect.anything(),
      expect.objectContaining({
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      })
    );
  });

  it("does not infer cache write when the final explicit-cache request includes a breakpoint", async () => {
    const provider = createCodexProvider();
    const loserSession = createLoserSession(provider);
    loserSession.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.6-sol",
      service_tier: "default",
      prompt_cache_options: { mode: "explicit" },
      input: [{ prompt_cache_breakpoint: true }],
    });
    vi.mocked(loserSession.getResolvedPricingByBillingSource).mockResolvedValue({
      resolvedModelName: "gpt-5.6-sol",
      resolvedPricingProviderKey: "openai",
      source: "cloud_official",
      priceData: {
        slug: "gpt-5.6-sol",
        input_cost_per_token: 5 / 1_000_000,
        cache_read_input_token_cost: 0.5 / 1_000_000,
        cache_creation_input_token_cost: 6.25 / 1_000_000,
        output_cost_per_token: 30 / 1_000_000,
        input_cost_per_token_above_272k_tokens: 10 / 1_000_000,
        cache_read_input_token_cost_above_272k_tokens: 1 / 1_000_000,
        cache_creation_input_token_cost_above_272k_tokens: 12.5 / 1_000_000,
        output_cost_per_token_above_272k_tokens: 45 / 1_000_000,
        input_cost_per_token_priority: 10 / 1_000_000,
        cache_read_input_token_cost_priority: 1 / 1_000_000,
        cache_creation_input_token_cost_priority: 12.5 / 1_000_000,
        output_cost_per_token_priority: 60 / 1_000_000,
      },
    } as any);

    await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      provider,
      attemptNumber: 2,
      upstreamStatusCode: 200,
      allContent: JSON.stringify({
        usage: {
          input_tokens: 9_016,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 5,
        },
      }),
      drainComplete: true,
    });

    expect(mocks.addMessageRequestHedgeLoserCost).toHaveBeenCalledWith(
      123,
      expect.anything(),
      expect.objectContaining({
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      })
    );
  });

  it("settles a GPT-5.6 Priority loser above 272K with normal Priority rates", async () => {
    const provider = createCodexProvider();
    const loserSession = createLoserSession(provider);
    loserSession.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.6-sol",
      service_tier: "priority",
    });
    vi.mocked(loserSession.getResolvedPricingByBillingSource).mockResolvedValue({
      resolvedModelName: "gpt-5.6-sol",
      resolvedPricingProviderKey: "openai",
      source: "cloud_official",
      priceData: {
        slug: "gpt-5.6-sol",
        input_cost_per_token: 5 / 1_000_000,
        cache_read_input_token_cost: 0.5 / 1_000_000,
        cache_creation_input_token_cost: 6.25 / 1_000_000,
        output_cost_per_token: 30 / 1_000_000,
        input_cost_per_token_above_272k_tokens: 10 / 1_000_000,
        cache_read_input_token_cost_above_272k_tokens: 1 / 1_000_000,
        cache_creation_input_token_cost_above_272k_tokens: 12.5 / 1_000_000,
        output_cost_per_token_above_272k_tokens: 45 / 1_000_000,
        input_cost_per_token_priority: 10 / 1_000_000,
        cache_read_input_token_cost_priority: 1 / 1_000_000,
        cache_creation_input_token_cost_priority: 12.5 / 1_000_000,
        output_cost_per_token_priority: 60 / 1_000_000,
        openai_official_pricing_supplement: {
          id: "openai-gpt56-2026-06-30",
          source: "https://developers.openai.com/api/docs/pricing",
          applied_fields: ["input_cost_per_token_priority"],
          conflicting_fields: ["cache_creation_input_token_cost"],
        },
      },
    } as any);
    const responseBody = JSON.stringify({
      service_tier: "priority",
      usage: {
        input_tokens: 272_001,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    const billed = await finalizeHedgeLoserBilling({
      messageRequestId: 123,
      loserSession: loserSession as any,
      provider,
      attemptNumber: 3,
      upstreamStatusCode: 200,
      allContent: responseBody,
      drainComplete: true,
    });

    expect(billed).toBe("2.72031");
    expect(mocks.addMessageRequestHedgeLoserCost).toHaveBeenCalledWith(
      123,
      expect.anything(),
      expect.objectContaining({
        attemptNumber: 3,
        costUsd: "2.72031",
        observedInputTokens: 272_001,
        inputTokens: 272_001,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
        requestedServiceTier: "priority",
        actualServiceTier: "priority",
        effectivePriority: true,
        billingStatus: "settled",
        pricingContext: {
          source: "cloud_official",
          model: "gpt-5.6-sol",
          provider: "openai",
          supplement: {
            id: "openai-gpt56-2026-06-30",
            source: "https://developers.openai.com/api/docs/pricing",
            applied_fields: ["input_cost_per_token_priority"],
            conflicting_fields: ["cache_creation_input_token_cost"],
          },
        },
      })
    );
    expect(mocks.addMessageRequestHedgeLoserCost.mock.calls[0]?.[1].toString()).toBe("2.72031");
    expect(mocks.trackCost).toHaveBeenCalledWith(
      10,
      provider.id,
      "session-1",
      2.72031,
      expect.objectContaining({
        userId: 20,
        requestId: 123,
        billingEventId: "123:hedge-loser:11:3",
      })
    );
  });
});
