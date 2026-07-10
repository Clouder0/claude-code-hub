import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPrice, ModelPriceData } from "@/types/model-price";
import type { SystemSettings } from "@/types/system-config";

const asyncTasks: Promise<void>[] = [];
const cloudPriceSyncRequests: Array<{ reason: string }> = [];
const unexpectedLogErrors: unknown[][] = [];

vi.mock("@/lib/async-task-manager", () => ({
  AsyncTaskManager: {
    register: (_taskId: string, promise: Promise<void>) => {
      asyncTasks.push(promise);
      return new AbortController();
    },
    touch: () => {},
    cleanup: () => {},
    cancel: () => {},
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (...args: unknown[]) => {
      unexpectedLogErrors.push(args);
    },
    trace: () => {},
  },
}));

vi.mock("@/lib/price-sync/cloud-price-updater", () => ({
  requestCloudPriceTableSync: (payload: { reason: string }) => {
    cloudPriceSyncRequests.push(payload);
  },
}));

vi.mock("@/repository/model-price", () => ({
  findLatestPriceByModel: vi.fn(),
}));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: vi.fn(),
}));

vi.mock("@/repository/message", () => ({
  updateMessageRequestCostWithBreakdown: vi.fn(),
  updateMessageRequestDetails: vi.fn(),
  updateMessageRequestDuration: vi.fn(),
}));

vi.mock("@/lib/session-manager", () => ({
  SessionManager: {
    clearSessionProvider: vi.fn(),
    updateSessionUsage: vi.fn(),
    updateSessionProvider: vi.fn(),
    storeSessionResponse: vi.fn(),
    extractCodexPromptCacheKey: vi.fn(),
    updateSessionWithCodexCacheKey: vi.fn(),
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  RateLimitService: {
    decrementLeaseBudget: vi.fn(),
    trackCost: vi.fn(),
    trackUserDailyCost: vi.fn(),
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

import { finalizeRequestStats, ProxyResponseHandler } from "@/app/v1/_lib/proxy/response-handler";
import { ProxySession } from "@/app/v1/_lib/proxy/session";
import { getCachedSystemSettings, invalidateSystemSettingsCache } from "@/lib/config";
import { SessionManager } from "@/lib/session-manager";
import { RateLimitService } from "@/lib/rate-limit";
import { SessionTracker } from "@/lib/session-tracker";
import {
  updateMessageRequestCostWithBreakdown,
  updateMessageRequestDetails,
  updateMessageRequestDuration,
} from "@/repository/message";
import { findLatestPriceByModel } from "@/repository/model-price";
import { getSystemSettings } from "@/repository/system-config";

beforeEach(() => {
  vi.clearAllMocks();
  cloudPriceSyncRequests.splice(0, cloudPriceSyncRequests.length);
  unexpectedLogErrors.splice(0, unexpectedLogErrors.length);
  invalidateSystemSettingsCache();
  vi.mocked(SessionManager.clearSessionProvider).mockResolvedValue(undefined);
  vi.mocked(SessionManager.updateSessionUsage).mockResolvedValue(undefined);
  vi.mocked(SessionManager.updateSessionProvider).mockResolvedValue(undefined);
  vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
  vi.mocked(SessionManager.updateSessionWithCodexCacheKey).mockResolvedValue(undefined);
  vi.mocked(RateLimitService.decrementLeaseBudget).mockResolvedValue(undefined);
  vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);
  vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
  vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);
});

function makeSystemSettings(
  billingModelSource: SystemSettings["billingModelSource"],
  codexPriorityBillingSource: SystemSettings["codexPriorityBillingSource"] = "requested",
  enableHighConcurrencyMode: boolean = false
): SystemSettings {
  const now = new Date();
  return {
    id: 1,
    siteTitle: "test",
    allowGlobalUsageView: false,
    currencyDisplay: "USD",
    billingModelSource,
    codexPriorityBillingSource,
    timezone: null,
    enableAutoCleanup: false,
    cleanupRetentionDays: 30,
    cleanupSchedule: "0 2 * * *",
    cleanupBatchSize: 10000,
    enableClientVersionCheck: false,
    verboseProviderError: false,
    enableHttp2: false,
    enableHighConcurrencyMode,
    interceptAnthropicWarmupRequests: false,
    enableThinkingSignatureRectifier: true,
    enableThinkingBudgetRectifier: true,
    enableBillingHeaderRectifier: true,
    enableResponseInputRectifier: true,
    enableCodexSessionIdCompletion: true,
    enableClaudeMetadataUserIdInjection: true,
    enableResponseFixer: true,
    responseFixerConfig: {
      fixTruncatedJson: true,
      fixSseFormat: true,
      fixEncoding: true,
      maxJsonDepth: 200,
      maxFixSize: 1024 * 1024,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makePriceRecord(
  modelName: string,
  priceData: ModelPriceData,
  source: ModelPrice["source"] = "litellm"
): ModelPrice {
  const now = new Date();
  return {
    id: 1,
    modelName,
    priceData,
    source,
    createdAt: now,
    updatedAt: now,
  };
}

function createSession({
  originalModel,
  redirectedModel,
  sessionId,
  messageId,
  enableHighConcurrencyMode = false,
  providerOverrides,
  requestMessage,
  requestPath = "/v1/messages",
  groupCostMultiplier,
}: {
  originalModel: string;
  redirectedModel: string;
  sessionId: string;
  messageId: number;
  enableHighConcurrencyMode?: boolean;
  providerOverrides?: Record<string, unknown>;
  requestMessage?: Record<string, unknown>;
  requestPath?: string;
  groupCostMultiplier?: number;
}): ProxySession {
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
    requestUrl: new URL(`http://localhost${requestPath}`),
    headers: new Headers(),
    headerLog: "",
    request: { message: requestMessage ?? {}, log: "(test)", model: redirectedModel },
    userAgent: null,
    context: {},
    clientAbortSignal: null,
  });

  session.setOriginalModel(originalModel);
  session.setSessionId(sessionId);
  session.setHighConcurrencyModeEnabled(enableHighConcurrencyMode);
  if (groupCostMultiplier !== undefined) {
    session.setGroupCostMultiplier(groupCostMultiplier);
  }

  const provider = {
    id: 99,
    name: "test-provider",
    url: "https://api.anthropic.com",
    providerType: "claude",
    costMultiplier: 1.0,
    streamingIdleTimeoutMs: 0,
    ...providerOverrides,
  } as any;

  const user = {
    id: 123,
    name: "test-user",
    dailyResetTime: "00:00",
    dailyResetMode: "fixed",
  } as any;

  const key = {
    id: 456,
    name: "test-key",
    dailyResetTime: "00:00",
    dailyResetMode: "fixed",
  } as any;

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

function createNonStreamResponse(
  usage: Record<string, unknown>,
  extras?: Record<string, unknown>
): Response {
  return new Response(
    JSON.stringify({
      type: "message",
      usage,
      ...(extras ?? {}),
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

function createImageEditResponseWithoutUsage(): Response {
  return new Response(
    JSON.stringify({
      created: 1_776_729_600,
      data: [{ b64_json: "test-image-bytes" }],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
}

function createFake200ErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "invalid api key",
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    }
  );
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
  const fatalBackgroundErrors = unexpectedLogErrors.filter(([message]) =>
    typeof message === "string"
      ? message === "Failed to handle non-stream log:" ||
        message === "Failed to handle stream log:" ||
        message.includes("Uncaught error in")
      : false
  );
  expect(fatalBackgroundErrors).toEqual([]);
}

function captureRateLimitCosts(): number[] {
  const rateLimitCosts: number[] = [];
  vi.mocked(RateLimitService.trackCost).mockImplementation(
    async (_keyId: number, _providerId: number, _sessionId: string, costUsd: number) => {
      rateLimitCosts.push(costUsd);
    }
  );
  return rateLimitCosts;
}

async function runScenario({
  billingModelSource,
  isStream,
  enableHighConcurrencyMode = false,
}: {
  billingModelSource: SystemSettings["billingModelSource"];
  isStream: boolean;
  enableHighConcurrencyMode?: boolean;
}): Promise<{
  dbCostCalls: number;
  dbCostUsd: string;
  rateLimitCalls: number;
  rateLimitCost: number;
  sessionCostCalls: number;
  sessionCostUsd: string;
}> {
  invalidateSystemSettingsCache();

  const usage = { input_tokens: 2, output_tokens: 3 };
  const originalModel = "original-model";
  const redirectedModel = "redirected-model";

  const originalPriceData: ModelPriceData = { input_cost_per_token: 1, output_cost_per_token: 1 };
  const redirectedPriceData: ModelPriceData = {
    input_cost_per_token: 10,
    output_cost_per_token: 10,
  };

  vi.mocked(getSystemSettings).mockResolvedValue(
    makeSystemSettings(billingModelSource, "requested", enableHighConcurrencyMode)
  );
  vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
    if (modelName === originalModel) {
      return makePriceRecord(modelName, originalPriceData);
    }
    if (modelName === redirectedModel) {
      return makePriceRecord(modelName, redirectedPriceData);
    }
    return null;
  });

  vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
  vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
  vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
  vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
  vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

  const dbCosts: string[] = [];
  vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
    async (_id: number, costUsd: unknown) => {
      dbCosts.push(String(costUsd));
      return String(costUsd);
    }
  );

  const sessionCosts: string[] = [];
  vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
    async (_sessionId: string, payload: Record<string, unknown>) => {
      if (typeof payload.costUsd === "string") {
        sessionCosts.push(payload.costUsd);
      }
    }
  );

  const rateLimitCosts: number[] = [];
  vi.mocked(RateLimitService.trackCost).mockImplementation(
    async (_keyId: number, _providerId: number, _sessionId: string, costUsd: number) => {
      rateLimitCosts.push(costUsd);
    }
  );

  const session = createSession({
    originalModel,
    redirectedModel,
    sessionId: `sess-${billingModelSource}-${isStream ? "s" : "n"}`,
    messageId: isStream ? 2001 : 2000,
    enableHighConcurrencyMode,
  });

  const response = isStream ? createStreamResponse(usage) : createNonStreamResponse(usage);
  const clientResponse = await ProxyResponseHandler.dispatch(session, response);

  if (isStream) {
    await clientResponse.text();
  }

  await drainAsyncTasks();

  return {
    dbCostCalls: dbCosts.length,
    dbCostUsd: dbCosts[0] ?? "",
    rateLimitCalls: rateLimitCosts.length,
    rateLimitCost: rateLimitCosts[0] ?? Number.NaN,
    sessionCostCalls: sessionCosts.length,
    sessionCostUsd: sessionCosts[0] ?? "",
  };
}

describe("Billing model source - Redis session cost vs DB cost", () => {
  it("非流式响应：配置 = original 时 Session 成本与数据库一致", async () => {
    const result = await runScenario({ billingModelSource: "original", isStream: false });

    expect(result.dbCostUsd).toBe("5");
    expect(result.sessionCostUsd).toBe("5");
    expect(result.rateLimitCost).toBe(5);
  });

  it("非流式响应：配置 = redirected 时 Session 成本与数据库一致", async () => {
    const result = await runScenario({ billingModelSource: "redirected", isStream: false });

    expect(result.dbCostUsd).toBe("50");
    expect(result.sessionCostUsd).toBe("50");
    expect(result.rateLimitCost).toBe(50);
  });

  it("流式响应：配置 = original 时 Session 成本与数据库一致", async () => {
    const result = await runScenario({ billingModelSource: "original", isStream: true });

    expect(result.dbCostUsd).toBe("5");
    expect(result.sessionCostUsd).toBe("5");
    expect(result.rateLimitCost).toBe(5);
  });

  it("流式响应：配置 = redirected 时 Session 成本与数据库一致", async () => {
    const result = await runScenario({ billingModelSource: "redirected", isStream: true });

    expect(result.dbCostUsd).toBe("50");
    expect(result.sessionCostUsd).toBe("50");
    expect(result.rateLimitCost).toBe(50);
  });

  it("从 original 切换到 redirected 后应生效", async () => {
    const original = await runScenario({ billingModelSource: "original", isStream: false });
    const redirected = await runScenario({ billingModelSource: "redirected", isStream: false });

    expect(original.sessionCostUsd).toBe("5");
    expect(redirected.sessionCostUsd).toBe("50");
    expect(original.sessionCostUsd).not.toBe(redirected.sessionCostUsd);
  });

  it("高并发模式：仍更新 DB cost 与限流 cost，但跳过 session usage / session refresh 观测写入", async () => {
    const result = await runScenario({
      billingModelSource: "redirected",
      enableHighConcurrencyMode: true,
      isStream: false,
    });

    expect(result.dbCostUsd).toBe("50");
    expect(result.rateLimitCost).toBe(50);
    expect(result.sessionCostUsd).toBe("");
    expect(vi.mocked(SessionManager.storeSessionResponse)).not.toHaveBeenCalled();
    expect(vi.mocked(SessionManager.updateSessionUsage)).not.toHaveBeenCalled();
    expect(vi.mocked(SessionTracker.refreshSession)).not.toHaveBeenCalled();
  });

  it("高并发模式：流式成功收尾时不应更新 session provider 观测信息", async () => {
    const result = await runScenario({
      billingModelSource: "redirected",
      enableHighConcurrencyMode: true,
      isStream: true,
    });

    expect(result.dbCostUsd).toBe("50");
    expect(result.rateLimitCost).toBe(50);
    expect(vi.mocked(SessionManager.updateSessionProvider)).not.toHaveBeenCalled();
  });

  it("nested pricing: gpt-5.5 alias model should bill from pricing.openai when provider is chatgpt", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 2.5,
              output_cost_per_token: 15,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const sessionCosts: string[] = [];
    vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
      async (_sessionId: string, payload: Record<string, unknown>) => {
        if (typeof payload.costUsd === "string") {
          sessionCosts.push(payload.costUsd);
        }
      }
    );

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-chatgpt",
      messageId: 3100,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
    });

    const response = createNonStreamResponse({ input_tokens: 2, output_tokens: 3 });
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("50");
    expect(sessionCosts[0]).toBe("50");
  });

  it("openai-compatible GPT-5.6 uses actual Priority rates for all four usage buckets", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected", "actual"));
    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName !== "gpt-5.6-sol") {
        return null;
      }

      return makePriceRecord(modelName, {
        input_cost_per_token: 0.000005,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
        output_cost_per_token: 0.00003,
        input_cost_per_token_priority: 0.00001,
        cache_read_input_token_cost_priority: 0.000001,
        cache_creation_input_token_cost_priority: 0.0000125,
        output_cost_per_token_priority: 0.00006,
      });
    });

    const dbCosts: string[] = [];
    const dbBreakdowns: Array<Record<string, unknown>> = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown, breakdown?: unknown) => {
        dbCosts.push(String(costUsd));
        if (breakdown && typeof breakdown === "object") {
          dbBreakdowns.push(breakdown as Record<string, unknown>);
        }
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const sessionCosts: string[] = [];
    vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
      async (_sessionId: string, payload: Record<string, unknown>) => {
        if (typeof payload.costUsd === "string") {
          sessionCosts.push(payload.costUsd);
        }
      }
    );

    const session = createSession({
      originalModel: "gpt-5.6-sol",
      redirectedModel: "gpt-5.6-sol",
      sessionId: "sess-gpt56-openai-compatible-priority",
      messageId: 3300,
      providerOverrides: {
        name: "OpenAI Compatible",
        url: "https://api.openai.com/v1",
        providerType: "openai-compatible",
      },
      requestMessage: { service_tier: "priority" },
      requestPath: "/v1/responses",
    });

    const response = createNonStreamResponse(
      {
        input_tokens: 1000,
        input_tokens_details: {
          cached_tokens: 200,
          cache_write_tokens: 300,
        },
        output_tokens: 400,
      },
      { service_tier: "priority" }
    );
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbBreakdowns[0]).toMatchObject({
      input: "0.005",
      cache_read: "0.0002",
      cache_creation: "0.00375",
      cache_creation_default: "0.00375",
      output: "0.024",
      total: "0.03295",
      pricing: {
        tier: "priority",
        unit_rates: {
          input: "0.00001",
          cache_read: "0.000001",
          cache_write: "0.0000125",
          output: "0.00006",
        },
        rate_source: "model_price_data",
        price_book_model: "gpt-5.6-sol",
      },
    });
    expect(dbCosts[0]).toBe("0.03295");
    expect(rateLimitCosts[0]).toBe(0.03295);
    expect(sessionCosts[0]).toBe("0.03295");
  });

  it("openai-compatible GPT-5.6 bills an actual Standard downgrade at Standard rates", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected", "requested"));
    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName !== "gpt-5.6-sol") {
        return null;
      }

      return makePriceRecord(modelName, {
        input_cost_per_token: 0.000005,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
        output_cost_per_token: 0.00003,
        input_cost_per_token_priority: 0.00001,
        cache_read_input_token_cost_priority: 0.000001,
        cache_creation_input_token_cost_priority: 0.0000125,
        output_cost_per_token_priority: 0.00006,
      });
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const sessionCosts: string[] = [];
    vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
      async (_sessionId: string, payload: Record<string, unknown>) => {
        if (typeof payload.costUsd === "string") {
          sessionCosts.push(payload.costUsd);
        }
      }
    );

    const session = createSession({
      originalModel: "gpt-5.6-sol",
      redirectedModel: "gpt-5.6-sol",
      sessionId: "sess-gpt56-openai-compatible-downgrade",
      messageId: 3301,
      providerOverrides: {
        name: "OpenAI Compatible",
        url: "https://api.openai.com/v1",
        providerType: "openai-compatible",
      },
      requestMessage: { service_tier: "priority" },
      requestPath: "/v1/responses",
    });

    const response = createNonStreamResponse(
      {
        input_tokens: 1000,
        input_tokens_details: {
          cached_tokens: 200,
          cache_write_tokens: 300,
        },
        output_tokens: 400,
      },
      { service_tier: "default" }
    );
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("0.016475");
    expect(rateLimitCosts[0]).toBe(0.016475);
    expect(sessionCosts[0]).toBe("0.016475");
  });

  it("openai-compatible GPT-5.6 preserves but marks actual Priority long-context billing unsupported", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected", "requested"));
    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName !== "gpt-5.6-sol") {
        return null;
      }

      return makePriceRecord(modelName, {
        input_cost_per_token: 0.000005,
        cache_read_input_token_cost: 0.0000005,
        cache_creation_input_token_cost: 0.00000625,
        output_cost_per_token: 0.00003,
        input_cost_per_token_above_272k_tokens: 0.00001,
        cache_read_input_token_cost_above_272k_tokens: 0.000001,
        cache_creation_input_token_cost_above_272k_tokens: 0.0000125,
        output_cost_per_token_above_272k_tokens: 0.000045,
        input_cost_per_token_priority: 0.00001,
        cache_read_input_token_cost_priority: 0.000001,
        cache_creation_input_token_cost_priority: 0.0000125,
        output_cost_per_token_priority: 0.00006,
      });
    });

    const persistedDetails: Array<Record<string, unknown>> = [];
    vi.mocked(updateMessageRequestDetails).mockImplementation(async (_id, details) => {
      persistedDetails.push(details as Record<string, unknown>);
    });
    vi.mocked(updateMessageRequestCostWithBreakdown).mockResolvedValue(undefined);
    const rateLimitCosts = captureRateLimitCosts();

    const session = createSession({
      originalModel: "gpt-5.6-sol",
      redirectedModel: "gpt-5.6-sol",
      sessionId: "sess-gpt56-openai-compatible-priority-long",
      messageId: 3302,
      providerOverrides: {
        name: "OpenAI Compatible",
        url: "https://api.openai.com/v1",
        providerType: "openai-compatible",
      },
      requestMessage: { service_tier: "priority" },
      requestPath: "/v1/responses",
    });

    const response = createNonStreamResponse(
      {
        input_tokens: 272_001,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 1,
        },
        output_tokens: 1,
      },
      { service_tier: "priority" }
    );
    const clientResponse = await ProxyResponseHandler.dispatch(session, response);
    await clientResponse.text();
    await drainAsyncTasks();

    expect(clientResponse.status).toBe(200);
    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(rateLimitCosts).toEqual([]);
    expect(persistedDetails.at(-1)?.specialSettings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "billing_settlement",
          status: "unsupported",
          reason: "gpt56_priority_long_context_unsupported",
          observedInputTokens: 272_001,
        }),
      ])
    );
  });

  it("codex fast: requested mode ignores actual priority when request tier is default", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const sessionCosts: string[] = [];
    vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
      async (_sessionId: string, payload: Record<string, unknown>) => {
        if (typeof payload.costUsd === "string") {
          sessionCosts.push(payload.costUsd);
        }
      }
    );

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-actual",
      messageId: 3200,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "default" },
    });

    const response = createNonStreamResponse(
      { input_tokens: 2, output_tokens: 3 },
      { service_tier: "priority" }
    );
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("32");
    expect(sessionCosts[0]).toBe("32");
    expect(rateLimitCosts[0]).toBe(32);
  });

  it("codex fast: falls back to requested priority pricing when response omits service_tier", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-requested",
      messageId: 3201,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "priority" },
    });

    const response = createNonStreamResponse({ input_tokens: 2, output_tokens: 3 });
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("64");
    expect(rateLimitCosts[0]).toBe(64);
  });

  it("codex fast: uses long-context priority pricing when request is priority and response omits service_tier", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
              input_cost_per_token_above_272k_tokens: 5,
              output_cost_per_token_above_272k_tokens: 50,
              input_cost_per_token_above_272k_tokens_priority: 7,
              output_cost_per_token_above_272k_tokens_priority: 70,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const sessionCosts: string[] = [];
    vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
      async (_sessionId: string, payload: Record<string, unknown>) => {
        if (typeof payload.costUsd === "string") {
          sessionCosts.push(payload.costUsd);
        }
      }
    );

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-requested-long-context",
      messageId: 3203,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "priority" },
    });

    const response = createNonStreamResponse({ input_tokens: 272001, output_tokens: 2 });
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("1904147");
    expect(sessionCosts[0]).toBe("1904147");
    expect(rateLimitCosts[0]).toBe(1904147);
  });

  it("codex fast: requested mode keeps priority pricing even when actual tier is downgraded", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-downgraded",
      messageId: 3202,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "priority" },
    });

    const response = createNonStreamResponse(
      { input_tokens: 2, output_tokens: 3 },
      { service_tier: "default" }
    );
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("64");
    expect(rateLimitCosts[0]).toBe(64);
  });

  it("codex fast: actual mode uses priority pricing when response reports service_tier=priority", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected", "actual"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-actual-mode-upgrade",
      messageId: 3204,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "default" },
    });

    const response = createNonStreamResponse(
      { input_tokens: 2, output_tokens: 3 },
      { service_tier: "priority" }
    );
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("64");
    expect(rateLimitCosts[0]).toBe(64);
  });

  it("codex fast: actual mode does not use priority pricing when response explicitly reports non-priority tier", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected", "actual"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-actual-mode-downgrade",
      messageId: 3205,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "priority" },
    });

    const response = createNonStreamResponse(
      { input_tokens: 2, output_tokens: 3 },
      { service_tier: "default" }
    );
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("32");
    expect(rateLimitCosts[0]).toBe(32);
  });

  it("codex fast: actual mode falls back to requested priority pricing when response omits service_tier", async () => {
    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("redirected", "actual"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-actual-mode-fallback",
      messageId: 3206,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "priority" },
    });

    const response = createNonStreamResponse({ input_tokens: 2, output_tokens: 3 });
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("64");
    expect(rateLimitCosts[0]).toBe(64);
  });

  it("codex fast: actual mode reuses cached system setting when direct settings read fails", async () => {
    vi.mocked(getSystemSettings).mockResolvedValueOnce(makeSystemSettings("redirected", "actual"));
    await getCachedSystemSettings();

    vi.mocked(getSystemSettings).mockRejectedValueOnce(new Error("db down"));
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === "gpt-5.5") {
        return makePriceRecord(modelName, {
          mode: "responses",
          model_family: "gpt",
          litellm_provider: "chatgpt",
          pricing: {
            openai: {
              input_cost_per_token: 1,
              output_cost_per_token: 10,
              input_cost_per_token_priority: 2,
              output_cost_per_token_priority: 20,
            },
          },
        });
      }
      return null;
    });

    const dbCosts: string[] = [];
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown) => {
        dbCosts.push(String(costUsd));
        return String(costUsd);
      }
    );
    const rateLimitCosts = captureRateLimitCosts();

    const session = createSession({
      originalModel: "gpt-5.5",
      redirectedModel: "gpt-5.5",
      sessionId: "sess-gpt55-priority-actual-mode-cached-settings",
      messageId: 3207,
      providerOverrides: {
        name: "ChatGPT",
        url: "https://chatgpt.com/backend-api/codex",
        providerType: "codex",
      },
      requestMessage: { service_tier: "priority" },
    });

    const response = createNonStreamResponse(
      { input_tokens: 2, output_tokens: 3 },
      { service_tier: "default" }
    );
    await ProxyResponseHandler.dispatch(session, response);
    await drainAsyncTasks();

    expect(dbCosts[0]).toBe("32");
    expect(rateLimitCosts[0]).toBe(32);
  });
});

describe("模型重定向后的图片按次计费", () => {
  async function runImageEditPerRequestScenario(
    billingModelSource: SystemSettings["billingModelSource"]
  ): Promise<{
    dbCostCalls: number;
    dbCostUsd: string;
    rateLimitCalls: number;
    rateLimitCost: number;
    sessionCostCalls: number;
    sessionCostUsd: string;
    storedBreakdown: Record<string, unknown> | undefined;
  }> {
    invalidateSystemSettingsCache();

    const originalModel = "gpt-image-2";
    const redirectedModel = "gpt-image-2-all";
    const providerMultiplier = 2;
    const groupCostMultiplier = 3;

    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings(billingModelSource));
    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      if (modelName === originalModel) {
        return makePriceRecord(modelName, { input_cost_per_request: 0.01 }, "manual");
      }
      if (modelName === redirectedModel) {
        return makePriceRecord(modelName, { input_cost_per_request: 0.02 }, "manual");
      }
      return null;
    });

    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    const dbCosts: string[] = [];
    let storedBreakdown: Record<string, unknown> | undefined;
    vi.mocked(updateMessageRequestCostWithBreakdown).mockImplementation(
      async (_id: number, costUsd: unknown, breakdown?: Record<string, unknown>) => {
        dbCosts.push(String(costUsd));
        storedBreakdown = breakdown;
        return String(costUsd);
      }
    );

    const sessionCosts: string[] = [];
    vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
      async (_sessionId: string, payload: Record<string, unknown>) => {
        if (typeof payload.costUsd === "string") {
          sessionCosts.push(payload.costUsd);
        }
      }
    );

    const rateLimitCosts: number[] = [];
    vi.mocked(RateLimitService.trackCost).mockImplementation(
      async (_keyId: number, _providerId: number, _sessionId: string, costUsd: number) => {
        rateLimitCosts.push(costUsd);
      }
    );

    const session = createSession({
      originalModel,
      redirectedModel,
      sessionId: `sess-image-edit-${billingModelSource}`,
      messageId: billingModelSource === "original" ? 4000 : 4001,
      requestPath: "/v1/images/edits",
      providerOverrides: {
        providerType: "openai",
        url: "https://api.openai.com/v1",
        costMultiplier: providerMultiplier,
      },
      groupCostMultiplier,
    });

    const clientResponse = await ProxyResponseHandler.dispatch(
      session,
      createImageEditResponseWithoutUsage()
    );
    await clientResponse.text();
    await drainAsyncTasks();

    return {
      dbCostCalls: dbCosts.length,
      dbCostUsd: dbCosts[0] ?? "",
      rateLimitCalls: rateLimitCosts.length,
      rateLimitCost: rateLimitCosts[0] ?? Number.NaN,
      sessionCostCalls: sessionCosts.length,
      sessionCostUsd: sessionCosts[0] ?? "",
      storedBreakdown,
    };
  }

  it("配置 = original 时命中重定向前模型的本地按次价格并应用倍率", async () => {
    const result = await runImageEditPerRequestScenario("original");

    expect(result.dbCostUsd).toBe("0.06");
    expect(result.sessionCostUsd).toBe("0.06");
    expect(result.rateLimitCost).toBe(0.06);
    expect(result.dbCostCalls).toBe(1);
    expect(result.sessionCostCalls).toBe(1);
    expect(result.rateLimitCalls).toBe(1);
    expect(result.storedBreakdown).toMatchObject({
      input: "0.01",
      base_total: "0.01",
      provider_multiplier: 2,
      group_multiplier: 3,
      total: "0.06",
    });
  });

  it("配置 = redirected 时命中重定向后模型的本地按次价格并应用倍率", async () => {
    const result = await runImageEditPerRequestScenario("redirected");

    expect(result.dbCostUsd).toBe("0.12");
    expect(result.sessionCostUsd).toBe("0.12");
    expect(result.rateLimitCost).toBe(0.12);
    expect(result.dbCostCalls).toBe(1);
    expect(result.sessionCostCalls).toBe(1);
    expect(result.rateLimitCalls).toBe(1);
    expect(result.storedBreakdown).toMatchObject({
      input: "0.02",
      base_total: "0.02",
      provider_multiplier: 2,
      group_multiplier: 3,
      total: "0.12",
    });
  });

  it("按次价格为 0 时不进入空 usage 计费写入路径", async () => {
    invalidateSystemSettingsCache();

    const originalModel = "gpt-image-2";
    const redirectedModel = "gpt-image-2-all";

    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("original"));
    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      return makePriceRecord(modelName, { input_cost_per_request: 0 }, "manual");
    });

    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestCostWithBreakdown).mockResolvedValue(undefined);
    vi.mocked(SessionManager.updateSessionUsage).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);

    const session = createSession({
      originalModel,
      redirectedModel,
      sessionId: "sess-image-edit-zero-per-request",
      messageId: 4002,
      requestPath: "/v1/images/edits",
      providerOverrides: {
        providerType: "openai",
        url: "https://api.openai.com/v1",
      },
    });

    const clientResponse = await ProxyResponseHandler.dispatch(
      session,
      createImageEditResponseWithoutUsage()
    );
    await clientResponse.text();
    await drainAsyncTasks();

    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(SessionManager.updateSessionUsage).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
  });

  it("价格查询失败时跳过按次计费且不影响成功响应", async () => {
    invalidateSystemSettingsCache();

    const originalModel = "gpt-image-2";
    const redirectedModel = "gpt-image-2-all";

    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("original"));
    vi.mocked(findLatestPriceByModel).mockImplementation(async () => {
      throw new Error("pricing db unavailable");
    });

    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestCostWithBreakdown).mockResolvedValue(undefined);
    vi.mocked(SessionManager.updateSessionUsage).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);

    const session = createSession({
      originalModel,
      redirectedModel,
      sessionId: "sess-image-edit-pricing-error",
      messageId: 4004,
      requestPath: "/v1/images/edits",
      providerOverrides: {
        providerType: "openai",
        url: "https://api.openai.com/v1",
      },
    });

    const clientResponse = await ProxyResponseHandler.dispatch(
      session,
      createImageEditResponseWithoutUsage()
    );
    const responseText = await clientResponse.text();
    await drainAsyncTasks();

    expect(clientResponse.status).toBe(200);
    expect(JSON.parse(responseText)).toMatchObject({
      data: [{ b64_json: "test-image-bytes" }],
    });
    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(SessionManager.updateSessionUsage).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
  });

  it("上游假 200 错误 payload 不触发图片按次计费", async () => {
    invalidateSystemSettingsCache();

    const originalModel = "gpt-image-2";
    const redirectedModel = "gpt-image-2-all";

    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("original"));
    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      return makePriceRecord(modelName, { input_cost_per_request: 0.01 }, "manual");
    });

    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestCostWithBreakdown).mockResolvedValue(undefined);
    vi.mocked(SessionManager.updateSessionUsage).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);

    const session = createSession({
      originalModel,
      redirectedModel,
      sessionId: "sess-image-edit-fake-200-error",
      messageId: 4005,
      requestPath: "/v1/images/edits",
      providerOverrides: {
        providerType: "openai",
        url: "https://api.openai.com/v1",
      },
    });

    const clientResponse = await ProxyResponseHandler.dispatch(
      session,
      createFake200ErrorResponse()
    );
    const responseText = await clientResponse.text();
    await drainAsyncTasks();

    expect(clientResponse.status).toBe(200);
    expect(JSON.parse(responseText)).toMatchObject({
      error: { message: "invalid api key" },
    });
    expect(updateMessageRequestCostWithBreakdown).not.toHaveBeenCalled();
    expect(SessionManager.updateSessionUsage).not.toHaveBeenCalled();
    expect(RateLimitService.trackCost).not.toHaveBeenCalled();
  });

  it("finalizeRequestStats 的按次计费 session usage 保留 errorMessage", async () => {
    invalidateSystemSettingsCache();

    const originalModel = "gpt-image-2";
    const redirectedModel = "gpt-image-2-all";
    const errorMessage = "fake 200 upstream warning";

    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings("original"));
    vi.mocked(findLatestPriceByModel).mockImplementation(async (modelName: string) => {
      return makePriceRecord(modelName, { input_cost_per_request: 0.01 }, "manual");
    });

    vi.mocked(updateMessageRequestCostWithBreakdown).mockResolvedValue("0.01");
    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);

    let sessionUsagePayload: Record<string, unknown> | undefined;
    vi.mocked(SessionManager.updateSessionUsage).mockImplementation(
      async (_sessionId: string, payload: Record<string, unknown>) => {
        sessionUsagePayload = payload;
      }
    );

    const session = createSession({
      originalModel,
      redirectedModel,
      sessionId: "sess-image-edit-finalize-error-message",
      messageId: 4003,
      requestPath: "/v1/images/edits",
      providerOverrides: {
        providerType: "openai",
        url: "https://api.openai.com/v1",
      },
    });

    await finalizeRequestStats(
      session,
      JSON.stringify({
        created: 1_776_729_600,
        data: [{ b64_json: "test-image-bytes" }],
      }),
      200,
      42,
      errorMessage,
      99,
      false
    );

    expect(sessionUsagePayload).toMatchObject({
      costUsd: "0.01",
      status: "completed",
      statusCode: 200,
      errorMessage,
    });
  });
});

describe("价格表缺失/查询失败：不计费放行", () => {
  async function runNoPriceScenario(options: {
    billingModelSource: SystemSettings["billingModelSource"];
    isStream: boolean;
    priceLookup: "none" | "throws";
  }): Promise<{ dbCostCalls: number; rateLimitCalls: number }> {
    const usage = { input_tokens: 2, output_tokens: 3 };
    const originalModel = "original-model";
    const redirectedModel = "redirected-model";

    vi.mocked(getSystemSettings).mockResolvedValue(makeSystemSettings(options.billingModelSource));
    if (options.priceLookup === "none") {
      vi.mocked(findLatestPriceByModel).mockResolvedValue(null);
    } else {
      vi.mocked(findLatestPriceByModel).mockImplementation(async () => {
        throw new Error("db query failed");
      });
    }

    vi.mocked(updateMessageRequestDetails).mockResolvedValue(undefined);
    vi.mocked(updateMessageRequestDuration).mockResolvedValue(undefined);
    vi.mocked(SessionManager.storeSessionResponse).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackUserDailyCost).mockResolvedValue(undefined);
    vi.mocked(SessionTracker.refreshSession).mockResolvedValue(undefined);

    vi.mocked(updateMessageRequestCostWithBreakdown).mockResolvedValue(undefined);
    vi.mocked(RateLimitService.trackCost).mockResolvedValue(undefined);
    vi.mocked(SessionManager.updateSessionUsage).mockResolvedValue(undefined);

    const session = createSession({
      originalModel,
      redirectedModel,
      sessionId: `sess-no-price-${options.billingModelSource}-${options.isStream ? "s" : "n"}`,
      messageId: options.isStream ? 3001 : 3000,
    });

    const response = options.isStream
      ? createStreamResponse(usage)
      : createNonStreamResponse(usage);
    const clientResponse = await ProxyResponseHandler.dispatch(session, response);
    await clientResponse.text();

    await drainAsyncTasks();

    return {
      dbCostCalls: vi.mocked(updateMessageRequestCostWithBreakdown).mock.calls.length,
      rateLimitCalls: vi.mocked(RateLimitService.trackCost).mock.calls.length,
    };
  }

  it("无价格：不写入 DB cost，不追踪限流 cost，并触发一次异步同步", async () => {
    const result = await runNoPriceScenario({
      billingModelSource: "redirected",
      isStream: false,
      priceLookup: "none",
    });

    expect(result.dbCostCalls).toBe(0);
    expect(result.rateLimitCalls).toBe(0);
    expect(cloudPriceSyncRequests).toEqual([{ reason: "missing-model" }]);
  });

  it("价格查询抛错：不应影响响应，不写入 DB cost，不追踪限流 cost", async () => {
    const result = await runNoPriceScenario({
      billingModelSource: "original",
      isStream: true,
      priceLookup: "throws",
    });

    expect(result.dbCostCalls).toBe(0);
    expect(result.rateLimitCalls).toBe(0);
  });
});
