/**
 * TDD: RED Phase - Tests for lease budget decrement in response-handler.ts
 *
 * Tests that decrementLeaseBudget is called correctly after trackCostToRedis completes.
 * - All windows: 5h, daily, weekly, monthly
 * - All entity types: key, user, provider
 * - Zero-cost requests should NOT trigger decrement
 * - Function runs once per request (no duplicates)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEndpointPolicy } from "@/app/v1/_lib/proxy/endpoint-policy";
import type { ModelPriceData } from "@/types/model-price";

// Track async tasks for draining
const asyncTasks: Promise<void>[] = [];

vi.mock("@/lib/async-task-manager", () => ({
  AsyncTaskManager: {
    register: (_taskId: string, promise: Promise<void>) => {
      asyncTasks.push(promise);
      return new AbortController();
    },
    touch: vi.fn(() => true),
    cleanup: () => {},
    cancel: () => {},
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    trace: () => {},
  },
}));

vi.mock("@/lib/price-sync/cloud-price-updater", () => ({
  requestCloudPriceTableSync: () => {},
}));

vi.mock("@/repository/model-price", () => ({
  findLatestPriceByModel: vi.fn(),
}));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: vi.fn(),
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestCost: vi.fn(),
  updateMessageRequestCostWithBreakdown: vi.fn(async (_id: number, costUsd: unknown) =>
    String(costUsd)
  ),
  updateMessageRequestDetails: vi.fn(),
  updateMessageRequestDuration: vi.fn(),
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    updateSessionUsage: vi.fn(async () => undefined),
    storeSessionResponse: vi.fn(),
    storeSessionResponsePhaseSnapshot: vi.fn(async () => undefined),
    extractCodexPromptCacheKey: vi.fn(),
    updateSessionWithCodexCacheKey: vi.fn(),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: {
    trackCost: vi.fn(),
    trackUserDailyCost: vi.fn(),
    decrementLeaseBudget: vi.fn(),
  },
}));

vi.mock("@/lib/session-tracker", () => ({
  SessionTracker: {
    refreshSession: vi.fn(),
  },
}));

vi.mock("@/lib/proxy-status-tracker", () => ({
  ProxyStatusTracker: {
    getInstance: () => ({
      endRequest: () => {},
    }),
  },
}));

import { ProxyResponseHandler } from "@/app/v1/_lib/proxy/response-handler";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { AsyncTaskManager } from "@/lib/async-task-manager";
import { SessionManager } from "@/lib/session-manager";
import { RateLimitService } from "@/lib/rate-limit";
import { SessionTracker } from "@/lib/session-tracker";
import {
  updateMessageRequestCost,
  updateMessageRequestCostWithBreakdown,
  updateMessageRequestDetails,
  updateMessageRequestDuration,
} from "@/repository/message";
import { findLatestPriceByModel } from "@/repository/model-price";
import { getSystemSettings } from "@/repository/system-config";

// Test price data
const testPriceData: ModelPriceData = {
  input_cost_per_token: 0.000003,
  output_cost_per_token: 0.000015,
};

function makePriceRecord(modelName: string, priceData: ModelPriceData) {
  return {
    id: 1,
    modelName,
    priceData,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeSystemSettings(billingModelSource: "original" | "redirected" = "original") {
  return {
    billingModelSource,
    streamBufferEnabled: false,
    streamBufferMode: "none",
    streamBufferSize: 0,
  } as ReturnType<typeof getSystemSettings> extends Promise<infer T> ? T : never;
}

function createSession(opts: {
  originalModel: string;
  redirectedModel: string;
  sessionId: string;
  messageId: number;
  pathname?: string;
  providerType?: "claude" | "codex";
  originalFormat?: "claude" | "response";
}): ProxySession {
  const {
    originalModel,
    redirectedModel,
    sessionId,
    messageId,
    pathname = "/v1/messages",
    providerType = "claude",
    originalFormat = "claude",
  } = opts;

  const session = Object.create(ProxySession.prototype) as ProxySession;
  Object.assign(session, {
    request: { message: {}, log: "(test)", model: redirectedModel },
    startTime: Date.now(),
    method: "POST",
    requestUrl: new URL(`http://localhost${pathname}`),
    headers: new Headers(),
    headerLog: "",
    userAgent: null,
    context: {},
    clientAbortSignal: null,
    userName: "test-user",
    authState: null,
    provider: null,
    messageContext: null,
    sessionId: null,
    requestSequence: 1,
    originalFormat,
    providerType: null,
    originalModelName: null,
    originalUrlPathname: null,
    providerChain: [],
    cacheTtlResolved: null,
    context1mApplied: false,
    specialSettings: [],
    cachedPriceData: undefined,
    cachedBillingModelSource: undefined,
    resolvedPricingCache: new Map(),
    endpointPolicy: resolveEndpointPolicy(pathname),
    isHeaderModified: () => false,
    getContext1mApplied: () => false,
    getGroupCostMultiplier: () => 1,
    getOriginalModel: () => originalModel,
    getCurrentModel: () => redirectedModel,
    getProviderChain: () => [],
    getResolvedPricingByBillingSource: async () => ({
      resolvedModelName: redirectedModel,
      resolvedPricingProviderKey: "test-provider",
      source: "cloud_exact" as const,
      priceData: testPriceData,
    }),
    recordTtfb: () => 100,
    ttfbMs: null,
    getRequestSequence: () => 1,
  });

  (session as { setOriginalModel(m: string | null): void }).setOriginalModel = function (
    m: string | null
  ) {
    (this as { originalModelName: string | null }).originalModelName = m;
  };
  (session as { setSessionId(s: string): void }).setSessionId = function (s: string) {
    (this as { sessionId: string | null }).sessionId = s;
  };
  (session as { setProvider(p: unknown): void }).setProvider = function (p: unknown) {
    (this as { provider: unknown }).provider = p;
  };
  (session as { setAuthState(a: unknown): void }).setAuthState = function (a: unknown) {
    (this as { authState: unknown }).authState = a;
  };
  (session as { setMessageContext(c: unknown): void }).setMessageContext = function (c: unknown) {
    (this as { messageContext: unknown }).messageContext = c;
  };

  session.setOriginalModel(originalModel);
  session.setSessionId(sessionId);

  const provider = {
    id: 99,
    name: "test-provider",
    providerType,
    costMultiplier: 1.0,
    streamingIdleTimeoutMs: 0,
    dailyResetTime: "00:00",
    dailyResetMode: "fixed",
  } as unknown;

  const user = {
    id: 123,
    name: "test-user",
    dailyResetTime: "00:00",
    dailyResetMode: "fixed",
  } as unknown;

  const key = {
    id: 456,
    name: "test-key",
    dailyResetTime: "00:00",
    dailyResetMode: "fixed",
  } as unknown;

  session.setProvider(provider);
  session.setAuthState({
    user,
    key,
    apiKey: "sk-test",
    success: true,
  });
  session.setMessageContext({
    id: messageId,
    createdAt: new Date(),
    user,
    key,
    apiKey: "sk-test",
  });

  return session;
}

function createNonStreamResponse(usage: { input_tokens: number; output_tokens: number }): Response {
  return new Response(
    JSON.stringify({
      type: "message",
      usage,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

function createChunkedNonStreamResponse(usage: {
  input_tokens: number;
  output_tokens: number;
}): Response {
  const body = JSON.stringify({
    type: "message",
    usage,
  });
  const encoder = new TextEncoder();
  const chunks = [
    encoder.encode(body.slice(0, 8)),
    encoder.encode(body.slice(8, 24)),
    encoder.encode(body.slice(24)),
  ];
  let index = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createStreamResponse(usage: { input_tokens: number; output_tokens: number }): Response {
  const sseText = `event: message_delta\ndata: ${JSON.stringify({ usage })}\n\n`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function drainAsyncTasks(): Promise<void> {
  const tasks = asyncTasks.splice(0, asyncTasks.length);
  await Promise.all(tasks);
}

beforeEach(() => {
  vi.clearAllMocks();
  asyncTasks.splice(0, asyncTasks.length);
});

describe("Lease Budget Decrement after trackCostToRedis", () => {
  const originalModel = "claude-sonnet-4-20250514";
  const usage = { input_tokens: 1000, output_tokens: 500 };

  beforeEach(async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("original"));
    vi.mocked(findLatestPriceByModel).mockResolvedValue(
      makePriceRecord(originalModel, testPriceData)
    );
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponsePhaseSnapshot).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.decrementLeaseBudget).mockResolvedValue({
      success: true,
      newRemaining: 10,
    });
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);
  });

  it("should call decrementLeaseBudget for all windows and entity types (non-stream)", async () => {
    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-lease-test-1",
      messageId: 5001,
    });

    const response = createNonStreamResponse(usage);
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    // Expected cost: (1000 * 0.000003) + (500 * 0.000015) = 0.003 + 0.0075 = 0.0105
    const expectedCost = 0.0105;

    // Should be called 12 times:
    // 4 windows x 3 entity types = 12 calls
    // Windows: 5h, daily, weekly, monthly
    // Entity types: key(456), user(123), provider(99)
    expect(RateLimitService.decrementLeaseBudget).toHaveBeenCalled();

    const calls = vi.mocked(RateLimitService.decrementLeaseBudget).mock.calls;
    expect(calls.length).toBe(12);

    // Verify all windows are covered for each entity type
    const windows = ["5h", "daily", "weekly", "monthly"];
    const entities = [
      { id: 456, type: "key" },
      { id: 123, type: "user" },
      { id: 99, type: "provider" },
    ];

    for (const entity of entities) {
      for (const window of windows) {
        const matchingCall = calls.find(
          (call) => call[0] === entity.id && call[1] === entity.type && call[2] === window
        );
        expect(matchingCall).toBeDefined();
        // Cost should be approximately 0.0105
        expect(matchingCall![3]).toBeCloseTo(expectedCost, 4);
      }
    }
  });

  it("should refresh task activity while reading chunked non-stream response bodies", async () => {
    const messageId = 5010;
    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-non-stream-chunked-touch",
      messageId,
    });

    const response = createChunkedNonStreamResponse(usage);
    const cloneSpy = vi.spyOn(response, "clone");

    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    const taskId = `non-stream-${messageId}`;
    const touchCalls = vi
      .mocked(AsyncTaskManager.touch)
      .mock.calls.filter(([calledTaskId]) => calledTaskId === taskId);
    expect(touchCalls.length).toBeGreaterThanOrEqual(2);
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(SessionManager.storeSessionResponsePhaseSnapshot).toHaveBeenCalledWith(
      session.sessionId,
      "after",
      expect.objectContaining({
        body: expect.stringContaining('"type":"message"'),
        meta: expect.objectContaining({ statusCode: 200 }),
      }),
      session.requestSequence
    );
    expect(updateMessageRequestDetails).toHaveBeenCalledWith(
      messageId,
      expect.objectContaining({
        statusCode: 200,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      })
    );
  });

  it("should call decrementLeaseBudget for all windows and entity types (stream)", async () => {
    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-lease-test-2",
      messageId: 5002,
    });

    const response = createStreamResponse(usage);
    const clientResponse = await ProxyResponseHandler.dispatch(session, response);
    await clientResponse.text();
    await drainAsyncTasks();

    expect(RateLimitService.decrementLeaseBudget).toHaveBeenCalled();
    const calls = vi.mocked(RateLimitService.decrementLeaseBudget).mock.calls;

    // Should have exactly 12 calls (4 windows x 3 entity types)
    expect(calls.length).toBe(12);
  });

  it("should NOT call decrementLeaseBudget when cost is zero", async () => {
    // Mock price data that results in zero cost
    const zeroPriceData: ModelPriceData = {
      input_cost_per_token: 0,
      output_cost_per_token: 0,
    };
    vi.mocked(findLatestPriceByModel).mockResolvedValue(
      makePriceRecord(originalModel, zeroPriceData)
    );

    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-lease-test-3",
      messageId: 5003,
    });

    // Override getResolvedPricingByBillingSource to return zero prices
    (
      session as {
        getResolvedPricingByBillingSource: () => Promise<{
          resolvedModelName: string;
          resolvedPricingProviderKey: string;
          source: string;
          priceData: ModelPriceData;
        }>;
      }
    ).getResolvedPricingByBillingSource = async () => ({
      resolvedModelName: originalModel,
      resolvedPricingProviderKey: "test-provider",
      source: "cloud_exact" as const,
      priceData: zeroPriceData,
    });

    const response = createNonStreamResponse(usage);
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    // Zero cost should NOT trigger decrement
    expect(RateLimitService.decrementLeaseBudget).not.toHaveBeenCalled();
  });

  it("should skip redis cost tracking and lease decrement for non-billing compact endpoint variants", async () => {
    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-non-billing-compact",
      messageId: 5999,
      pathname: "/v1/responses/compact/",
      providerType: "codex",
      originalFormat: "response",
    });

    const response = createNonStreamResponse(usage);
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
    expect(RateLimitService.trackUserDailyCost).not.toHaveBeenCalled();
    expect(RateLimitService.decrementLeaseBudget).not.toHaveBeenCalled();
    expect(updateMessageRequestDetails).toHaveBeenCalledWith(
      5999,
      expect.objectContaining({
        statusCode: 200,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      })
    );
  });

  it("should call decrementLeaseBudget exactly once per request (no duplicates)", async () => {
    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-lease-test-4",
      messageId: 5004,
    });

    const response = createNonStreamResponse(usage);
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    // Each window/entity combo should be called exactly once
    const calls = vi.mocked(RateLimitService.decrementLeaseBudget).mock.calls;

    // Create a unique key for each call to check for duplicates
    const callKeys = calls.map((call) => `${call[0]}-${call[1]}-${call[2]}`);
    const uniqueKeys = new Set(callKeys);

    // No duplicates: unique keys should equal total calls
    expect(uniqueKeys.size).toBe(calls.length);
    expect(calls.length).toBe(12); // 4 windows x 3 entities
  });

  it("should use correct entity IDs from session", async () => {
    const customKeyId = 789;
    const customUserId = 321;
    const customProviderId = 111;

    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-lease-test-5",
      messageId: 5005,
    });

    // Override with custom IDs
    session.setProvider({
      id: customProviderId,
      name: "custom-provider",
      providerType: "claude",
      costMultiplier: 1.0,
      dailyResetTime: "00:00",
      dailyResetMode: "fixed",
    } as unknown);

    session.setAuthState({
      user: {
        id: customUserId,
        name: "custom-user",
        dailyResetTime: "00:00",
        dailyResetMode: "fixed",
      },
      key: {
        id: customKeyId,
        name: "custom-key",
        dailyResetTime: "00:00",
        dailyResetMode: "fixed",
      },
      apiKey: "sk-custom",
      success: true,
    });

    session.setMessageContext({
      id: 5005,
      createdAt: new Date(),
      user: {
        id: customUserId,
        name: "custom-user",
        dailyResetTime: "00:00",
        dailyResetMode: "fixed",
      },
      key: {
        id: customKeyId,
        name: "custom-key",
        dailyResetTime: "00:00",
        dailyResetMode: "fixed",
      },
      apiKey: "sk-custom",
    });

    const response = createNonStreamResponse(usage);
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    const calls = vi.mocked(RateLimitService.decrementLeaseBudget).mock.calls;

    // Verify key ID
    const keyCalls = calls.filter((c) => c[1] === "key");
    expect(keyCalls.every((c) => c[0] === customKeyId)).toBe(true);
    expect(keyCalls.length).toBe(4);

    // Verify user ID
    const userCalls = calls.filter((c) => c[1] === "user");
    expect(userCalls.every((c) => c[0] === customUserId)).toBe(true);
    expect(userCalls.length).toBe(4);

    // Verify provider ID
    const providerCalls = calls.filter((c) => c[1] === "provider");
    expect(providerCalls.every((c) => c[0] === customProviderId)).toBe(true);
    expect(providerCalls.length).toBe(4);
  });

  it("should use fire-and-forget pattern (not block on decrement failures)", async () => {
    // Mock decrementLeaseBudget to fail
    vi.mocked(RateLimitService.decrementLeaseBudget).mockRejectedValue(
      new Error("Redis connection failed")
    );

    const session = createSession({
      originalModel,
      redirectedModel: originalModel,
      sessionId: "sess-lease-test-6",
      messageId: 5006,
    });

    const response = createNonStreamResponse(usage);

    // Should NOT throw even if decrementLeaseBudget fails
    await expect(ProxyResponseHandler.dispatch(session, response)).resolves.toBeDefined();
    await drainAsyncTasks();

    // Verify decrement was attempted
    expect(RateLimitService.decrementLeaseBudget).toHaveBeenCalled();
  });
});

describe("Alpha Search fixed-request billing", () => {
  const createAlphaSession = () => {
    const session = createSession({
      originalModel: "gpt-5",
      redirectedModel: "gpt-5",
      sessionId: "019b82ff-08ff-75a3-a203-7e10274fdbd8",
      messageId: 7001,
      pathname: "/v1/alpha/search",
      providerType: "codex",
      originalFormat: "response",
    });
    Object.assign(session.provider!, { costMultiplier: 2 });
    Object.assign(session, { getGroupCostMultiplier: () => 1.5 });
    return session;
  };

  beforeEach(() => {
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(async (_id, costUsd) =>
      String(costUsd)
    );
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.updateSessionUsage).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.decrementLeaseBudget).mockResolvedValue({
      success: true,
      newRemaining: 10,
    });
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);
  });

  it("charges one completed 2xx operation and preserves the exact upstream response", async () => {
    const session = createAlphaSession();
    const clearResponseTimeout = vi.fn();
    const releaseAgent = vi.fn();
    Object.assign(session, { clearResponseTimeout, releaseAgent });
    const body = new Uint8Array([0, 1, 2, 127, 128, 255]);
    const upstream = new Response(body, {
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/octet-stream", "x-upstream": "kept" },
    });

    const result = await ProxyResponseHandler.dispatch(session, upstream);

    expect(result.status).toBe(201);
    expect(result.statusText).toBe("Created");
    expect(result.headers.get("x-upstream")).toBe("kept");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(body);
    expect(updateMessageRequestCostWithBreakdown).toHaveBeenCalledTimes(1);
    const [requestId, settledCost, breakdown, settlement] = vi.mocked(
      updateMessageRequestCostWithBreakdown
    ).mock.calls[0];
    expect(requestId).toBe(7001);
    expect(String(settledCost)).toBe("0.03");
    expect(breakdown).toBeUndefined();
    expect(settlement).toEqual(
      expect.objectContaining({
        providerId: 99,
        costMultiplier: 2,
        groupCostMultiplier: 1.5,
        inputTokens: 0,
        outputTokens: 0,
      })
    );
    expect(RateLimitService.trackCost).toHaveBeenCalledWith(
      456,
      99,
      session.sessionId,
      0.03,
      expect.objectContaining({ billingEventId: "7001:alpha-search" })
    );
    expect(clearResponseTimeout).toHaveBeenCalledTimes(1);
    expect(releaseAgent).toHaveBeenCalledTimes(1);
    expect(
      (session as ProxySession & { clearResponseTimeout?: () => void }).clearResponseTimeout
    ).toBeUndefined();
  });

  it("does not charge a non-2xx response", async () => {
    const session = createAlphaSession();

    const result = await ProxyResponseHandler.dispatch(
      session,
      new Response('{"error":"upstream"}', { status: 503 })
    );

    expect(result.status).toBe(503);
    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
    expect(updateMessageRequestDetails).toHaveBeenCalledWith(
      7001,
      expect.objectContaining({ statusCode: 503, errorMessage: "HTTP 503" })
    );
  });

  it("does not settle cost when the upstream body cannot be read completely", async () => {
    const session = createAlphaSession();
    const clearResponseTimeout = vi.fn();
    const releaseAgent = vi.fn();
    Object.assign(session, { clearResponseTimeout, releaseAgent });
    const brokenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("truncated"));
      },
    });

    await expect(
      ProxyResponseHandler.dispatch(session, new Response(brokenBody, { status: 200 }))
    ).rejects.toThrow("truncated");
    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
    expect(clearResponseTimeout).toHaveBeenCalledTimes(1);
    expect(releaseAgent).toHaveBeenCalledTimes(1);
  });

  it("clears response timeout when billing persistence fails", async () => {
    const session = createAlphaSession();
    const clearResponseTimeout = vi.fn();
    const releaseAgent = vi.fn();
    Object.assign(session, { clearResponseTimeout, releaseAgent });
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementationOnce(async () => {
      expect(clearResponseTimeout).toHaveBeenCalledTimes(1);
      throw new Error("billing unavailable");
    });

    await expect(
      ProxyResponseHandler.dispatch(session, new Response("{}", { status: 200 }))
    ).rejects.toThrow("billing unavailable");

    expect(clearResponseTimeout).toHaveBeenCalledTimes(1);
    expect(releaseAgent).toHaveBeenCalledTimes(1);
  });
});
