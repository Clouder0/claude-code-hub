import { beforeEach, describe, expect, it, vi } from "vitest";

const valuesMock = vi.fn();
const returningMock = vi.fn();
const setMock = vi.fn();
const whereMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();

  process.env.NODE_ENV = "test";
  process.env.DSN = "postgres://postgres:postgres@localhost:5432/claude_code_hub_test";
  process.env.MESSAGE_REQUEST_WRITE_MODE = "sync";

  returningMock.mockResolvedValue([
    {
      id: 1,
      providerId: 2,
      userId: 3,
      key: "sk-test",
      model: "gpt-5.5",
      originalModel: null,
      durationMs: null,
      costUsd: null,
      costMultiplier: null,
      sessionId: null,
      requestSequence: null,
      userAgent: null,
      clientIp: null,
      endpoint: null,
      messagesCount: null,
      cacheTtlApplied: null,
      cacheCreationInputTokens: null,
      cacheCreation5mInputTokens: null,
      cacheCreation1hInputTokens: null,
      cacheReadInputTokens: null,
      specialSettings: null,
      createdAt: new Date("2026-06-06T00:00:00Z"),
      updatedAt: new Date("2026-06-06T00:00:00Z"),
      deletedAt: null,
    },
  ]);
  valuesMock.mockReturnValue({ returning: returningMock });
  whereMock.mockResolvedValue([]);
  setMock.mockReturnValue({ where: whereMock });

  vi.doMock("@/drizzle/db", () => ({
    db: {
      insert: vi.fn(() => ({ values: valuesMock })),
      update: vi.fn(() => ({ set: setMock })),
      execute: vi.fn(async () => []),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
      })),
    },
  }));
});

describe("message_request JSONB write paths", () => {
  it("sanitizes special_settings during the initial insert", async () => {
    const { createMessageRequest } = await import("@/repository/message");

    await createMessageRequest({
      provider_id: 2,
      user_id: 3,
      key: "sk-test",
      model: "gpt-5.5",
      special_settings: [
        {
          type: "thinking_budget_rectifier",
          scope: "request",
          hit: true,
          providerId: 1,
          providerName: "bad\u0000provider\u0001name \u{1f600}",
          trigger: "x\u000by",
          attemptNumber: 1,
          retryAttemptNumber: 0,
        },
      ],
    });

    const inserted = valuesMock.mock.calls[0]?.[0];
    expect(inserted.specialSettings[0].providerName).toBe("badprovider name \u{1f600}");
    expect(inserted.specialSettings[0].trigger).toBe("x y");
  });

  it("sanitizes provider_chain and special_settings during a synchronous details update", async () => {
    const { updateMessageRequestDetails } = await import("@/repository/message");

    await updateMessageRequestDetails(123, {
      providerChain: [
        {
          id: 1,
          name: "provider",
          reason: "retry_failed",
          errorDetails: {
            request: {
              url: "https://proxy.example.com/v1/responses",
              method: "POST",
              headers: "content-encoding: zstd",
              body: "bad\u0000body\ud800",
            },
          },
        },
      ],
      specialSettings: [
        {
          type: "thinking_budget_rectifier",
          scope: "request",
          hit: true,
          providerId: 1,
          providerName: "provider",
          trigger: "bad\u0000trigger",
          attemptNumber: 1,
          retryAttemptNumber: 0,
        },
      ],
    });

    const updated = setMock.mock.calls[0]?.[0];
    expect(updated.providerChain[0].errorDetails.request.body).toBe("badbody\uFFFD");
    expect(updated.specialSettings[0].trigger).toBe("badtrigger");
  });

  it("sanitizes costBreakdown during a synchronous cost update", async () => {
    const { updateMessageRequestCostWithBreakdown } = await import("@/repository/message");

    await updateMessageRequestCostWithBreakdown(123, "0.03", {
      input: "0.01",
      output: "0.02",
      cache_creation: "0",
      cache_read: "0",
      base_total: "0.03",
      provider_multiplier: 1,
      group_multiplier: 1,
      total: "0.03\u0000\ud800",
    });

    const updated = setMock.mock.calls[0]?.[0];
    expect(updated.costBreakdown.total).toBe("0.03\uFFFD");
  });

  it("sanitizes costBreakdown in the direct winner-cost write", async () => {
    const { updateMessageRequestWinnerCost } = await import("@/repository/message");

    await updateMessageRequestWinnerCost(123, "0.03", {
      input: "0.01",
      output: "0.02",
      cache_creation: "0",
      cache_read: "0",
      base_total: "0.03",
      provider_multiplier: 1,
      group_multiplier: 1,
      total: "winner\u0000\ud800",
    });

    const updated = setMock.mock.calls[0]?.[0];
    expect(updated.costBreakdown.total).toBe("winner\uFFFD");
  });
});
