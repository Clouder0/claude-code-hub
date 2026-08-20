import { beforeEach, describe, expect, it, vi } from "vitest";

const asyncTasks: Promise<void>[] = [];

vi.mock("@/app/v1/_lib/proxy/response-fixer", () => ({
  ResponseFixer: {
    process: async (_session: unknown, response: Response) => response,
  },
}));

vi.mock("@/lib/async-task-manager", () => ({
  AsyncTaskManager: {
    register: (_taskId: string, promise: Promise<void>) => {
      asyncTasks.push(promise);
      return new AbortController();
    },
    touch: () => true,
    cleanup: () => {},
    cancel: () => {},
  },
}));

vi.mock("@/lib/config/system-settings-cache", () => ({
  getCachedSystemSettings: vi.fn(async () => ({ billNonSuccessfulRequests: false })),
}));

vi.mock("@/lib/langfuse/emit-proxy-trace", () => ({
  emitProxyLangfuseTrace: vi.fn(),
  // perf-bundle-a 新增的文本释放门控：mock 必须提供，否则 finalize 访问即抛错
  isLangfuseTraceEnabled: vi.fn(() => false),
}));

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnMock,
    error: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock("@/lib/price-sync/cloud-price-updater", () => ({
  requestCloudPriceTableSync: vi.fn(),
}));

vi.mock("@/lib/proxy-status-tracker", () => ({
  ProxyStatusTracker: {
    getInstance: () => ({ endRequest: vi.fn() }),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: {
    decrementLeaseBudget: vi.fn(async () => undefined),
    trackCost: vi.fn(async () => undefined),
    trackUserDailyCost: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/redis/live-chain-store", () => ({
  deleteLiveChain: vi.fn(async () => undefined),
  writeLiveChain: vi.fn(async () => undefined),
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    clearSessionProvider: vi.fn(async () => undefined),
    extractCodexPromptCacheKey: vi.fn(),
    storeSessionRequestHeaders: vi.fn(),
    storeSessionRequestPhaseSnapshot: vi.fn(),
    storeSessionResponse: vi.fn(async () => undefined),
    storeSessionResponseHeaders: vi.fn(),
    storeSessionResponsePhaseSnapshot: vi.fn(),
    storeSessionSpecialSettings: vi.fn(),
    storeSessionUpstreamRequestMeta: vi.fn(),
    storeSessionUpstreamResponseMeta: vi.fn(),
    updateSessionBindingSmart: vi.fn(async () => ({ updated: false, reason: "test" })),
    updateSessionProvider: vi.fn(async () => undefined),
    updateSessionUsage: vi.fn(async () => undefined),
    updateSessionWithCodexCacheKey: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    refreshSession: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/circuit-breaker", () => ({
  recordFailure: vi.fn(async () => undefined),
  recordSuccess: vi.fn(async () => undefined),
}));

vi.mock("@/lib/endpoint-circuit-breaker", () => ({
  recordEndpointFailure: vi.fn(async () => undefined),
  recordEndpointSuccess: vi.fn(async () => undefined),
  resetEndpointCircuit: vi.fn(async () => undefined),
}));

vi.mock("@/repository/message-write-buffer", () => ({
  flushMessageRequestWriteBuffer: vi.fn(async () => undefined),
  enqueueMessageRequestUpdate: vi.fn(),
}));

vi.mock("@/repository/message", () => ({
  addMessageRequestHedgeLoserCost: vi.fn(async () => undefined),
  updateMessageRequestCostWithBreakdown: vi.fn(async (_id: number, cost: unknown) => String(cost)),
  updateMessageRequestDetails: vi.fn(async () => undefined),
  updateMessageRequestDuration: vi.fn(async () => undefined),
  updateMessageRequestUnsupportedBillingSettlement: vi.fn(async () => undefined),
  updateMessageRequestWinnerCost: vi.fn(async (_id: number, cost: unknown) => String(cost)),
}));

import { ProxyResponseHandler } from "@/app/v1/_lib/proxy/response-handler";
import { flushMessageRequestWriteBuffer } from "@/repository/message-write-buffer";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { setDeferredStreamingFinalization } from "@/app/v1/_lib/proxy/stream-finalization";
import { RateLimitService } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { emitProxyLangfuseTrace } from "@/lib/langfuse/emit-proxy-trace";
import { SessionManager } from "@/lib/session-manager";
import {
  updateMessageRequestCostWithBreakdown,
  updateMessageRequestDetails,
  updateMessageRequestDuration,
  updateMessageRequestUnsupportedBillingSettlement,
  updateMessageRequestWinnerCost,
} from "@/repository/message";
import type { ModelPriceData } from "@/types/model-price";
import type { Provider } from "@/types/provider";

const GPT56_SOL_PRICE: ModelPriceData = {
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
};

function createProvider(providerType: "codex" | "openai-compatible"): Provider {
  return {
    id: providerType === "codex" ? 11 : 12,
    name: providerType === "codex" ? "Private Codex" : "OpenAI Compatible",
    url:
      providerType === "codex"
        ? "https://chatgpt.com/backend-api/codex"
        : "https://api.openai.com/v1",
    providerType,
    costMultiplier: 1,
    streamingIdleTimeoutMs: 0,
    firstByteTimeoutStreamingMs: 0,
    requestTimeoutNonStreamingMs: 0,
  } as Provider;
}

function createSession(options: {
  messageId: number;
  providerType: "codex" | "openai-compatible";
  endpoint?: "/v1/responses" | "/v1/chat/completions";
  requestMessage?: Record<string, unknown>;
  sessionId?: string;
}): ProxySession {
  const endpoint = options.endpoint ?? "/v1/responses";
  const model = "gpt-5.6-sol";
  const provider = createProvider(options.providerType);
  const user = {
    id: 101,
    name: "test-user",
    dailyResetTime: "00:00",
    dailyResetMode: "fixed",
  } as any;
  const key = {
    id: 202,
    name: "test-key",
    dailyResetTime: "00:00",
    dailyResetMode: "fixed",
  } as any;
  const session = new (
    ProxySession as unknown as {
      new (init: {
        startTime: number;
        method: string;
        requestUrl: URL;
        headers: Headers;
        headerLog: string;
        request: { message: Record<string, unknown>; log: string; model: string | null };
        userAgent: string | null;
        context: unknown;
        clientAbortSignal: AbortSignal | null;
      }): ProxySession;
    }
  )({
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL(`http://localhost${endpoint}`),
    headers: new Headers(),
    headerLog: "",
    request: {
      message: {
        model,
        stream: endpoint === "/v1/responses",
        ...(options.requestMessage ?? {}),
      },
      log: "(test)",
      model,
    },
    userAgent: null,
    context: {},
    clientAbortSignal: null,
  });

  session.setOriginalModel(model);
  session.setSessionId(options.sessionId ?? `gpt56-lifecycle-${options.messageId}`);
  session.setProvider(provider);
  session.setAuthState({ user, key, apiKey: "sk-test", success: true });
  session.setMessageContext({
    id: options.messageId,
    createdAt: new Date(),
    user,
    key,
    apiKey: "sk-test",
  });

  Object.assign(session, {
    getCodexPriorityBillingSource: vi.fn(async () => "requested"),
    getResolvedPricingByBillingSource: vi.fn(async () => ({
      resolvedModelName: model,
      resolvedPricingProviderKey: "openai",
      source: "cloud_official",
      priceData: GPT56_SOL_PRICE,
    })),
  });

  return session;
}

function createResponsesSse(options: {
  usage: Record<string, unknown>;
  serviceTier?: string;
}): Response {
  const body = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: {
        usage: {
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          output_tokens: 0,
        },
      },
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_gpt56_lifecycle",
        model: "gpt-5.6-sol",
        ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
        usage: options.usage,
      },
    })}`,
    "",
  ].join("\n\n");

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createChatSse(options: {
  usage: Record<string, unknown>;
  serviceTier?: string;
}): Response {
  const baseChunk = {
    id: "chatcmpl_gpt56_lifecycle_stream",
    object: "chat.completion.chunk",
    model: "gpt-5.6-sol",
    ...(options.serviceTier ? { service_tier: options.serviceTier } : {}),
  };
  const body = [
    `data: ${JSON.stringify({
      ...baseChunk,
      choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      ...baseChunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: options.usage,
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function dispatchAndCapture(
  session: ProxySession,
  response: Response
): Promise<{ response: Response; body: string }> {
  const clientResponse = await ProxyResponseHandler.dispatch(session, response);
  const body = await clientResponse.text();
  while (asyncTasks.length > 0) {
    const tasks = asyncTasks.splice(0, asyncTasks.length);
    await Promise.all(tasks);
  }
  return { response: clientResponse, body };
}

async function dispatchAndDrain(session: ProxySession, response: Response): Promise<Response> {
  return (await dispatchAndCapture(session, response)).response;
}

function expectSingleSettlement(mode: "stream" | "non-stream" = "stream"): void {
  expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledTimes(1);
  expect(RateLimitService.trackCost).toHaveBeenCalledTimes(1);
  expect(SessionManager.updateSessionUsage).toHaveBeenCalledTimes(1);
  if (mode === "stream") {
    // review 修复：settlement 前必须先 flush 异步写缓冲，防止历史 buffered
    // patch 在 settlement 之后落地、用过期列覆盖终态。
    expect(flushMessageRequestWriteBuffer.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      updateMessageRequestCostWithBreakdown.mock.invocationCallOrder[0] ?? Infinity
    );
    // db-write-churn 契约：流式成功路径的终态 facts 折叠进 settlement 的
    // overlay（第 5 参），不再有独立的 buffered details/duration 写。
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        statusCode: expect.any(Number),
        durationMs: expect.any(Number),
      })
    );
    expect(updateMessageRequestDetails).not.toHaveBeenCalled();
    expect(updateMessageRequestDuration).not.toHaveBeenCalled();
  } else {
    // 非流式路径保持旧契约：settlement 不携带 overlay（第 5 参为 undefined），
    // 终态仍由一次 details 写落库。
    expect(updateMessageRequestCostWithBreakdown.mock.calls.at(-1)?.[4]).toBeUndefined();
    expect(updateMessageRequestDetails).toHaveBeenCalledTimes(1);
  }
}

/** 取最近一次 settlement 调用携带的 finalize overlay（cost/winner/unsupported 任一）。 */
function settleOverlay(): Record<string, unknown> {
  const cost = updateMessageRequestCostWithBreakdown.mock.calls.at(-1)?.[4];
  const winner = updateMessageRequestWinnerCost.mock.calls.at(-1)?.[4];
  const unsupported = updateMessageRequestUnsupportedBillingSettlement.mock.calls.at(-1)?.[2];
  const overlay = cost ?? winner ?? unsupported;
  expect(overlay).toBeTruthy();
  return overlay as Record<string, unknown>;
}

describe("GPT-5.6 billing lifecycle", () => {
  beforeEach(() => {
    asyncTasks.splice(0, asyncTasks.length);
    vi.clearAllMocks();
  });

  it("settles actual Priority Responses SSE usage identically across DB, rate limit, and session", async () => {
    const session = createSession({
      messageId: 40_001,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    const response = createResponsesSse({
      serviceTier: "priority",
      usage: {
        input_tokens: 2_000,
        input_tokens_details: {
          cached_tokens: 200,
          cache_write_tokens: 300,
        },
        output_tokens: 400,
      },
    });

    await dispatchAndDrain(session, response);

    expectSingleSettlement();
    expect(vi.mocked(logger.error).mock.calls).toEqual([]);
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_001,
      expect.anything(),
      expect.objectContaining({
        input: "0.015",
        cache_read: "0.0002",
        cache_creation_default: "0.00375",
        output: "0.024",
        total: "0.04295",
        pricing: expect.objectContaining({ tier: "priority" }),
      }),
      expect.objectContaining({
        providerId: 12,
        model: "gpt-5.6-sol",
        costMultiplier: 1,
        groupCostMultiplier: 1,
        providerChain: [],
        inputTokens: 1_500,
        observedInputTokens: 2_000,
        outputTokens: 400,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 200,
        cacheWriteTokensReported: 300,
        cacheWriteAccounting: "reported_positive",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      12,
      "gpt56-lifecycle-40001",
      0.04295,
      expect.objectContaining({
        requestId: 40_001,
        userId: 101,
        billingEventId: "40001:winner",
      })
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40001",
      expect.objectContaining({
        inputTokens: 1_500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        outputTokens: 400,
        costUsd: "0.04295",
      })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        observedInputTokens: 2_000,
        inputTokens: 1_500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        outputTokens: 400,
        cacheWriteTokensReported: 300,
        cacheWriteAccounting: "reported_positive",
        specialSettings: expect.arrayContaining([
          expect.objectContaining({
            type: "openai_service_tier_result",
            actualServiceTier: "priority",
            resolvedFrom: "actual",
            effectivePriority: true,
          }),
        ]),
      })
    );
    expect(emitProxyLangfuseTrace).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ costUsd: "0.04295" })
    );
  });

  it("uses the final forwarded Priority tier when the response omits service_tier", async () => {
    const session = createSession({
      messageId: 40_002,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    session.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.6-sol",
      stream: true,
      service_tier: "priority",
    });
    const response = createResponsesSse({
      usage: {
        input_tokens: 2_000,
        input_tokens_details: {
          cached_tokens: 200,
          cache_write_tokens: 300,
        },
        output_tokens: 400,
      },
    });

    await dispatchAndDrain(session, response);

    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_002,
      expect.anything(),
      expect.objectContaining({
        total: "0.04295",
        pricing: expect.objectContaining({ tier: "priority" }),
      }),
      expect.objectContaining({ model: "gpt-5.6-sol" }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        specialSettings: expect.arrayContaining([
          expect.objectContaining({
            type: "openai_service_tier_result",
            requestedServiceTier: "priority",
            actualServiceTier: null,
            resolvedFrom: "requested",
            effectivePriority: true,
          }),
        ]),
      })
    );
  });

  it("persists the final forwarded model in both streaming settlement writes", async () => {
    const session = createSession({
      messageId: 40_018,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    session.forwardedRequestBody = JSON.stringify({
      model: "gpt-5.6-terra",
      stream: true,
      service_tier: "default",
    });
    const response = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 2_000,
        input_tokens_details: {
          cached_tokens: 200,
          cache_write_tokens: 300,
        },
        output_tokens: 400,
      },
    });

    await dispatchAndDrain(session, response);

    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_018,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: "gpt-5.6-terra" }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(settleOverlay()).toEqual(expect.objectContaining({ model: "gpt-5.6-terra" }));
  });

  it("publishes the loser-inclusive DB total to session while rate limits keep the winner event cost", async () => {
    const session = createSession({
      messageId: 40_011,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    const provider = session.provider;
    if (!provider) throw new Error("expected provider");
    setDeferredStreamingFinalization(session, {
      providerId: provider.id,
      providerName: provider.name,
      providerPriority: provider.priority ?? 0,
      attemptNumber: 1,
      totalProvidersAttempted: 2,
      isFirstAttempt: true,
      isFailoverSuccess: false,
      endpointId: null,
      endpointUrl: provider.url,
      upstreamStatusCode: 200,
      isHedgeWinner: true,
      billHedgeLosers: true,
    });
    vi.mocked(updateMessageRequestWinnerCost).mockResolvedValueOnce("0.0208");
    const response = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 2_000,
        input_tokens_details: {
          cached_tokens: 600,
          cache_write_tokens: 400,
        },
        output_tokens: 100,
      },
    });

    await dispatchAndDrain(session, response);

    expect(updateMessageRequestWinnerCost).toHaveBeenCalledTimes(1);
    expect(updateMessageRequestWinnerCost).toHaveBeenCalledWith(
      40_011,
      expect.anything(),
      expect.objectContaining({ total: "0.0108" }),
      expect.objectContaining({
        providerId: 12,
        observedInputTokens: 2_000,
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        cacheWriteTokensReported: 400,
        cacheWriteAccounting: "reported_positive",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      12,
      "gpt56-lifecycle-40011",
      0.0108,
      expect.objectContaining({ billingEventId: "40011:winner" })
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40011",
      expect.objectContaining({
        requestSequence: 1,
        costUsd: "0.0208",
      })
    );
    expect(emitProxyLangfuseTrace).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ costUsd: "0.0108" })
    );
  });

  it("does not publish or rate-track a hedge winner whose durable settlement failed", async () => {
    const session = createSession({
      messageId: 40_013,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    const provider = session.provider;
    if (!provider) throw new Error("expected provider");
    setDeferredStreamingFinalization(session, {
      providerId: provider.id,
      providerName: provider.name,
      providerPriority: provider.priority ?? 0,
      attemptNumber: 1,
      totalProvidersAttempted: 2,
      isFirstAttempt: true,
      isFailoverSuccess: false,
      endpointId: null,
      endpointUrl: provider.url,
      upstreamStatusCode: 200,
      isHedgeWinner: true,
      billHedgeLosers: true,
    });
    vi.mocked(updateMessageRequestWinnerCost).mockRejectedValueOnce(
      new Error("Message request 40013 not found during winner settlement")
    );
    const upstreamResponse = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 2_000,
        input_tokens_details: { cached_tokens: 600, cache_write_tokens: 400 },
        output_tokens: 100,
      },
    });

    const result = await dispatchAndCapture(session, upstreamResponse);

    expect(result.response.status).toBe(200);
    expect(result.body).toContain("response.completed");
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
    const sessionPayload = vi.mocked(SessionManager.updateSessionUsage).mock.calls.at(-1)?.[1];
    expect(sessionPayload).not.toHaveProperty("costUsd");
    expect(vi.mocked(emitProxyLangfuseTrace).mock.calls.at(-1)?.[1]?.costUsd).toBeUndefined();
  });

  it("does not publish or rate-track a normal winner whose durable settlement failed", async () => {
    const session = createSession({
      messageId: 40_014,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    vi.mocked(updateMessageRequestCostWithBreakdown).mockRejectedValueOnce(
      new Error("Message request 40014 not found during cost settlement")
    );
    const upstreamResponse = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 2_000,
        input_tokens_details: { cached_tokens: 600, cache_write_tokens: 400 },
        output_tokens: 100,
      },
    });

    const result = await dispatchAndCapture(session, upstreamResponse);

    expect(result.response.status).toBe(200);
    expect(result.body).toContain("response.completed");
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
    const sessionPayload = vi.mocked(SessionManager.updateSessionUsage).mock.calls.at(-1)?.[1];
    expect(sessionPayload).not.toHaveProperty("costUsd");
    expect(vi.mocked(emitProxyLangfuseTrace).mock.calls.at(-1)?.[1]?.costUsd).toBeUndefined();
  });

  it("falls back to requested Priority when a Responses SSE terminal event omits actual tier", async () => {
    const session = createSession({
      messageId: 40_002,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "priority" },
    });
    const response = createResponsesSse({
      usage: {
        input_tokens: 2_000,
        input_tokens_details: {
          cached_tokens: 200,
          cache_write_tokens: 300,
        },
        output_tokens: 400,
      },
    });

    await dispatchAndDrain(session, response);

    expectSingleSettlement();
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_002,
      expect.anything(),
      expect.objectContaining({
        total: "0.04295",
        pricing: expect.objectContaining({ tier: "priority" }),
      }),
      expect.objectContaining({
        providerId: 12,
        observedInputTokens: 2_000,
        inputTokens: 1_500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
        cacheWriteTokensReported: 300,
        cacheWriteAccounting: "reported_positive",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      12,
      "gpt56-lifecycle-40002",
      0.04295,
      expect.anything()
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40002",
      expect.objectContaining({ costUsd: "0.04295" })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        specialSettings: expect.arrayContaining([
          expect.objectContaining({
            type: "openai_service_tier_result",
            requestedServiceTier: "priority",
            actualServiceTier: null,
            resolvedFrom: "requested",
            effectivePriority: true,
          }),
        ]),
      })
    );
  });

  it("uses ordinary input when the selected Priority tier is complete without a Standard write rate", async () => {
    const session = createSession({
      messageId: 40_009,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "priority" },
    });
    Object.assign(session, {
      getResolvedPricingByBillingSource: vi.fn(async () => ({
        resolvedModelName: "gpt-5.6-sol",
        resolvedPricingProviderKey: "openai",
        source: "local_manual",
        priceData: {
          ...GPT56_SOL_PRICE,
          cache_creation_input_token_cost: undefined,
        },
      })),
    });
    const response = createResponsesSse({
      serviceTier: "priority",
      usage: {
        input_tokens: 9_016,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    await dispatchAndDrain(session, response);

    expectSingleSettlement();
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_009,
      expect.anything(),
      expect.objectContaining({
        input: "0.09016",
        cache_creation_default: "0",
        output: "0.0003",
        total: "0.09046",
        pricing: expect.objectContaining({ tier: "priority" }),
      }),
      expect.objectContaining({
        providerId: 12,
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      })
    );
  });

  it("does not borrow a Priority write rate when the selected Standard tier has a zero write rate", async () => {
    const session = createSession({
      messageId: 40_010,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "priority" },
    });
    Object.assign(session, {
      getResolvedPricingByBillingSource: vi.fn(async () => ({
        resolvedModelName: "gpt-5.6-sol",
        resolvedPricingProviderKey: "openai",
        source: "local_manual",
        priceData: {
          ...GPT56_SOL_PRICE,
          cache_creation_input_token_cost: 0,
          openai_official_pricing_supplement: {
            id: "openai-gpt56-2026-06-30",
            source: "https://developers.openai.com/api/docs/pricing",
            applied_fields: ["cache_creation_input_token_cost_priority"],
            conflicting_fields: ["cache_creation_input_token_cost"],
          },
        },
      })),
    });
    const response = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 9_016,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    await dispatchAndDrain(session, response);

    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
    // db-write-churn：流式 unsupported 路径同样折叠 overlay，details 不再单独调用。
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        statusCode: expect.any(Number),
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
        specialSettings: expect.arrayContaining([
          expect.objectContaining({
            type: "billing_settlement",
            status: "unsupported",
            reason: "gpt56_standard_rates_incomplete",
            missingFields: ["cache_creation_input_token_cost"],
            pricingContext: {
              source: "local_manual",
              model: "gpt-5.6-sol",
              provider: "openai",
              supplement: {
                id: "openai-gpt56-2026-06-30",
                source: "https://developers.openai.com/api/docs/pricing",
                applied_fields: ["cache_creation_input_token_cost_priority"],
                conflicting_fields: ["cache_creation_input_token_cost"],
              },
            },
          }),
        ]),
      })
    );
    expect(updateMessageRequestUnsupportedBillingSettlement).toHaveBeenCalledWith(
      40_010,
      expect.objectContaining({
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheCreationInputTokens: 0,
        specialSettings: expect.arrayContaining([
          expect.objectContaining({
            type: "billing_settlement",
            status: "unsupported",
            reason: "gpt56_standard_rates_incomplete",
            missingFields: ["cache_creation_input_token_cost"],
          }),
        ]),
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
  });

  it("keeps the Standard pricing snapshot above 272K", async () => {
    const session = createSession({
      messageId: 40_014,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    const upstreamResponse = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 272_001,
        input_tokens_details: {
          cached_tokens: 100_000,
          cache_write_tokens: 50_000,
        },
        output_tokens: 5,
      },
    });

    await dispatchAndDrain(session, upstreamResponse);

    expectSingleSettlement();
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_014,
      expect.anything(),
      expect.objectContaining({
        pricing: expect.objectContaining({ tier: "standard" }),
      }),
      expect.objectContaining({
        observedInputTokens: 272_001,
        inputTokens: 122_001,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 50_000,
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
  });

  it("settles an actual Priority response above 272K with normal Priority rates", async () => {
    const session = createSession({
      messageId: 40_012,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    Object.assign(session, {
      getResolvedPricingByBillingSource: vi.fn(async () => ({
        resolvedModelName: "gpt-5.6-sol",
        resolvedPricingProviderKey: "openai",
        source: "cloud_official",
        priceData: {
          ...GPT56_SOL_PRICE,
          openai_official_pricing_supplement: {
            id: "openai-gpt56-2026-06-30",
            source: "https://developers.openai.com/api/docs/pricing",
            applied_fields: ["input_cost_per_token_priority"],
            conflicting_fields: [],
          },
        },
      })),
    });
    const upstreamResponse = createResponsesSse({
      serviceTier: "priority",
      usage: {
        input_tokens: 272_001,
        input_tokens_details: {
          cached_tokens: 100_000,
          cache_write_tokens: 50_000,
        },
        output_tokens: 5,
      },
    });

    const result = await dispatchAndCapture(session, upstreamResponse);

    expect(result.response.status).toBe(200);
    expect(result.body).toContain("response.completed");
    expect(result.body).toContain('"service_tier":"priority"');
    expect(result.body).toContain('"input_tokens":272001');
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_012,
      expect.anything(),
      expect.objectContaining({
        input: "1.22001",
        cache_read: "0.1",
        cache_creation_default: "0.625",
        output: "0.0003",
        total: "1.94531",
        pricing: expect.objectContaining({ tier: "priority" }),
      }),
      expect.objectContaining({
        providerId: 12,
        model: "gpt-5.6-sol",
        observedInputTokens: 272_001,
        inputTokens: 122_001,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 50_000,
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(updateMessageRequestUnsupportedBillingSettlement).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      12,
      "gpt56-lifecycle-40012",
      1.94531,
      expect.anything()
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40012",
      expect.objectContaining({ costUsd: "1.94531" })
    );
    expect(vi.mocked(emitProxyLangfuseTrace).mock.calls.at(-1)?.[1]?.costUsd).toBe("1.94531");
  });

  it("keeps cost side effects closed when durable unsupported audit persistence fails", async () => {
    const session = createSession({
      messageId: 40_013,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default" },
    });
    Object.assign(session, {
      getResolvedPricingByBillingSource: vi.fn(async () => ({
        resolvedModelName: "gpt-5.6-sol",
        resolvedPricingProviderKey: "openai",
        source: "local_manual",
        priceData: {
          ...GPT56_SOL_PRICE,
          cache_creation_input_token_cost: undefined,
        },
      })),
    });
    vi.mocked(updateMessageRequestUnsupportedBillingSettlement).mockRejectedValueOnce(
      new Error("database unavailable")
    );
    const upstreamResponse = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 9_016,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    const result = await dispatchAndCapture(session, upstreamResponse);

    expect(result.response.status).toBe(200);
    expect(updateMessageRequestUnsupportedBillingSettlement).toHaveBeenCalledTimes(1);
    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(updateMessageRequestWinnerCost).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
    expect(RateLimitService.decrementLeaseBudget).not.toHaveBeenCalled();
    expect(vi.mocked(SessionManager.updateSessionUsage).mock.calls.at(-1)?.[1]).not.toHaveProperty(
      "costUsd"
    );
    expect(logger.error).toHaveBeenCalledWith(
      "[BillingSettlement] Failed to persist unsupported pricing audit",
      expect.objectContaining({
        messageId: 40_013,
        reason: "gpt56_standard_rates_incomplete",
        error: "database unavailable",
      })
    );
  });

  it("settles Chat Completions nested cache read and write details into disjoint buckets", async () => {
    const session = createSession({
      messageId: 40_003,
      providerType: "openai-compatible",
      endpoint: "/v1/chat/completions",
      requestMessage: { service_tier: "default" },
    });
    const response = new Response(
      JSON.stringify({
        id: "chatcmpl_gpt56_lifecycle",
        model: "gpt-5.6-sol",
        service_tier: "default",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" } }],
        usage: {
          prompt_tokens: 2_000,
          prompt_tokens_details: {
            cached_tokens: 600,
            cache_write_tokens: 400,
          },
          completion_tokens: 100,
          total_tokens: 2_100,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

    await dispatchAndDrain(session, response);

    expectSingleSettlement("non-stream");
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_003,
      expect.anything(),
      expect.objectContaining({
        input: "0.005",
        cache_read: "0.0003",
        cache_creation_default: "0.0025",
        output: "0.003",
        total: "0.0108",
        pricing: expect.objectContaining({ tier: "standard" }),
      }),
      expect.objectContaining({
        providerId: 12,
        observedInputTokens: 2_000,
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        cacheWriteTokensReported: 400,
        cacheWriteAccounting: "reported_positive",
      }),
      undefined
    );
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      12,
      "gpt56-lifecycle-40003",
      0.0108,
      expect.anything()
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40003",
      expect.objectContaining({
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        outputTokens: 100,
        costUsd: "0.0108",
      })
    );
    expect(updateMessageRequestDetails).toHaveBeenCalledWith(
      40_003,
      expect.objectContaining({
        observedInputTokens: 2_000,
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        outputTokens: 100,
        cacheWriteTokensReported: 400,
        cacheWriteAccounting: "reported_positive",
      })
    );
  });

  it("settles non-stream Responses nested cache usage through the same accounting path", async () => {
    const session = createSession({
      messageId: 40_007,
      providerType: "openai-compatible",
      requestMessage: { service_tier: "default", stream: false },
    });
    Object.assign(session, {
      getResolvedPricingByBillingSource: vi.fn(async () => ({
        resolvedModelName: "gpt-5.6-sol",
        resolvedPricingProviderKey: "openai",
        source: "cloud_official",
        priceData: {
          ...GPT56_SOL_PRICE,
          long_context_pricing: {
            threshold_tokens: 1,
            scope: "request",
            input_cost_per_token: 1,
            output_cost_per_token: 1,
          },
        },
      })),
    });
    const response = new Response(
      JSON.stringify({
        id: "resp_gpt56_lifecycle_non_stream",
        object: "response",
        model: "gpt-5.6-sol",
        service_tier: "default",
        output: [],
        usage: {
          input_tokens: 2_000,
          input_tokens_details: {
            cached_tokens: 600,
            cache_write_tokens: 400,
          },
          output_tokens: 100,
          total_tokens: 2_100,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );

    await dispatchAndDrain(session, response);

    expectSingleSettlement("non-stream");
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_007,
      expect.anything(),
      expect.objectContaining({
        input: "0.005",
        cache_read: "0.0003",
        cache_creation_default: "0.0025",
        output: "0.003",
        total: "0.0108",
        pricing: expect.objectContaining({ tier: "standard" }),
      }),
      expect.objectContaining({
        providerId: 12,
        observedInputTokens: 2_000,
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        cacheWriteTokensReported: 400,
        cacheWriteAccounting: "reported_positive",
      }),
      undefined
    );
    expect(updateMessageRequestDetails).toHaveBeenCalledWith(
      40_007,
      expect.objectContaining({
        observedInputTokens: 2_000,
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        outputTokens: 100,
        cacheWriteTokensReported: 400,
        cacheWriteAccounting: "reported_positive",
      })
    );
    const persistedDetails = vi.mocked(updateMessageRequestDetails).mock.calls[0]?.[1] as {
      specialSettings?: Array<{ type?: string }>;
    };
    expect(persistedDetails.specialSettings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "long_context_pricing" })])
    );
  });

  it("settles streaming Chat nested cache usage from the terminal usage chunk", async () => {
    const session = createSession({
      messageId: 40_008,
      providerType: "openai-compatible",
      endpoint: "/v1/chat/completions",
      requestMessage: { service_tier: "default", stream: true },
    });
    const response = createChatSse({
      serviceTier: "default",
      usage: {
        prompt_tokens: 2_000,
        prompt_tokens_details: {
          cached_tokens: 600,
          cache_write_tokens: 400,
        },
        completion_tokens: 100,
        total_tokens: 2_100,
      },
    });

    await dispatchAndDrain(session, response);

    expectSingleSettlement();
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_008,
      expect.anything(),
      expect.objectContaining({
        input: "0.005",
        cache_read: "0.0003",
        cache_creation_default: "0.0025",
        output: "0.003",
        total: "0.0108",
        pricing: expect.objectContaining({ tier: "standard" }),
      }),
      expect.objectContaining({
        providerId: 12,
        observedInputTokens: 2_000,
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        cacheWriteTokensReported: 400,
        cacheWriteAccounting: "reported_positive",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        observedInputTokens: 2_000,
        inputTokens: 1_000,
        cacheReadInputTokens: 600,
        cacheCreationInputTokens: 400,
        outputTokens: 100,
        cacheWriteTokensReported: 400,
        cacheWriteAccounting: "reported_positive",
      })
    );
  });

  it("keeps the private Codex cold fixture as ordinary input", async () => {
    const session = createSession({
      messageId: 40_004,
      providerType: "codex",
      requestMessage: { service_tier: "default" },
    });
    const response = createResponsesSse({
      usage: {
        input_tokens: 9_016,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    await dispatchAndDrain(session, response);

    expectSingleSettlement();
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_004,
      expect.anything(),
      expect.objectContaining({
        input: "0.04508",
        cache_read: "0",
        cache_creation_default: "0",
        output: "0.00015",
        total: "0.04523",
      }),
      expect.objectContaining({
        providerId: 11,
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      11,
      "gpt56-lifecycle-40004",
      0.04523,
      expect.anything()
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40004",
      expect.objectContaining({
        inputTokens: 9_016,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
        costUsd: "0.04523",
      })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      })
    );
  });

  it("keeps the private Codex hot fixture remainder as ordinary input", async () => {
    const session = createSession({
      messageId: 40_005,
      providerType: "codex",
      requestMessage: { service_tier: "default" },
    });
    const response = createResponsesSse({
      usage: {
        input_tokens: 9_016,
        input_tokens_details: {
          cached_tokens: 7_936,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    await dispatchAndDrain(session, response);

    expectSingleSettlement();
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_005,
      expect.anything(),
      expect.objectContaining({
        input: "0.0054",
        cache_read: "0.003968",
        cache_creation_default: "0",
        output: "0.00015",
        total: "0.009518",
      }),
      expect.objectContaining({
        providerId: 11,
        observedInputTokens: 9_016,
        inputTokens: 1_080,
        cacheReadInputTokens: 7_936,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      11,
      "gpt56-lifecycle-40005",
      0.009518,
      expect.anything()
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40005",
      expect.objectContaining({
        inputTokens: 1_080,
        cacheReadInputTokens: 7_936,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
        costUsd: "0.009518",
      })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        observedInputTokens: 9_016,
        inputTokens: 1_080,
        cacheReadInputTokens: 7_936,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      })
    );
  });

  it("does not infer cache write for explicit cache mode without a breakpoint", async () => {
    const session = createSession({
      messageId: 40_006,
      providerType: "openai-compatible",
      requestMessage: {
        service_tier: "default",
        prompt_cache_options: { mode: "explicit" },
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "stable prompt without a breakpoint" }],
          },
        ],
      },
    });
    const response = createResponsesSse({
      serviceTier: "default",
      usage: {
        input_tokens: 9_016,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
        output_tokens: 5,
      },
    });

    await dispatchAndDrain(session, response);

    expectSingleSettlement();
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledWith(
      40_006,
      expect.anything(),
      expect.objectContaining({
        input: "0.04508",
        cache_read: "0",
        cache_creation_default: "0",
        output: "0.00015",
        total: "0.04523",
      }),
      expect.objectContaining({
        providerId: 12,
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      }),
      expect.objectContaining({ statusCode: expect.any(Number), durationMs: expect.any(Number) })
    );
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      202,
      12,
      "gpt56-lifecycle-40006",
      0.04523,
      expect.anything()
    );
    expect(SessionManager.updateSessionUsage).toHaveBeenCalledWith(
      "gpt56-lifecycle-40006",
      expect.objectContaining({
        inputTokens: 9_016,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
        costUsd: "0.04523",
      })
    );
    expect(settleOverlay()).toEqual(
      expect.objectContaining({
        observedInputTokens: 9_016,
        inputTokens: 9_016,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 5,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      })
    );
  });
});
