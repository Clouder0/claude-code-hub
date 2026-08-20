import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { rollupWriteMock, groupsMock } = vi.hoisted(() => ({
  rollupWriteMock: vi.fn(async () => ({ written: true, retryable: false })),
  groupsMock: vi.fn(async () => ({ groups: [{ id: 1, name: "g" }], retryable: false })),
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

vi.mock("@/lib/public-status/rollup-store", () => ({
  queuePublicStatusRollupWrite: rollupWriteMock,
  getConfiguredPublicStatusGroupsForRollupResolution: groupsMock,
}));

// db mock: update(...) chain captures .set() payload; select(...) chain serves
// the public-status seed fallback read.
const setPayloads: Array<Record<string, unknown>> = [];

vi.mock("@/drizzle/db", () => ({
  db: {
    update: vi.fn(() => ({
      set: (arg: Record<string, unknown>) => {
        setPayloads.push(arg);
        return {
          where: () => ({
            returning: async () => [{ costUsd: "1.500000000000000", id: 1 }],
          }),
        };
      },
    })),
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          // 生产时序：seed 回退读发生在 overlay 持久化 duration_ms 之后，
          // 因此读到的行已带终态时长。
          limit: async () => [
            {
              createdAt: new Date("2026-08-21T00:00:00Z"),
              model: "test-model",
              originalModel: "test-model",
              durationMs: 9876,
            },
          ],
        }),
      }),
    })),
  },
}));

import {
  updateMessageRequestCostWithBreakdown,
  updateMessageRequestUnsupportedBillingSettlement,
  updateMessageRequestWinnerCost,
  type MessageRequestBillingSettlement,
  type MessageRequestFinalizeOverlay,
} from "@/repository/message";

function baseSettlement(): MessageRequestBillingSettlement {
  return {
    providerId: 7,
    model: "gpt-5.2",
    costMultiplier: 1,
    groupCostMultiplier: 1,
    providerChain: [{ id: 7, name: "p7" }],
    specialSettings: [{ type: "pricing_resolution", scope: "billing", hit: true }],
    context1mApplied: false,
    swapCacheTtlApplied: false,
    inputTokens: 1000, // billable-split value — the overlay must WIN with observed value
    outputTokens: 200,
    cacheCreationInputTokens: 300,
    cacheReadInputTokens: 400,
    cacheCreation5mInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheWriteTokensReported: 0,
    cacheWriteAccounting: "reported_positive",
    cacheTtlApplied: null,
  };
}

function baseOverlay(): MessageRequestFinalizeOverlay {
  return {
    statusCode: 200,
    durationMs: 9876,
    ttfbMs: 321,
    inputTokens: 107000,
    outputTokens: 250,
    providerChain: [{ id: 7, name: "p7" }],
    model: "gpt-5.2",
    providerId: 7,
    context1mApplied: false,
    swapCacheTtlApplied: false,
    specialSettings: [{ type: "pricing_resolution", scope: "billing", hit: true }],
  };
}

// rollup 的 once-only 声明缓存是模块级状态：每个测试用唯一 ID，避免跨用例去重。
let idCursor = 0;
function nextId() {
  idCursor += 1;
  return 910_000 + idCursor;
}

describe("settlement finalize overlay (single-UPDATE finalize)", () => {
  beforeEach(() => {
    setPayloads.length = 0;
    rollupWriteMock.mockClear();
    groupsMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("cost settlement folds terminal facts into the same UPDATE and overlay wins overlaps", async () => {
    const persisted = await updateMessageRequestCostWithBreakdown(
      nextId(),
      "1.5",
      undefined,
      baseSettlement(),
      baseOverlay()
    );

    expect(persisted).toBe("1.500000000000000");
    expect(setPayloads).toHaveLength(1);
    const payload = setPayloads[0];
    expect(payload.statusCode).toBe(200);
    expect(payload.durationMs).toBe(9876);
    expect(payload.ttfbMs).toBe(321);
    // 关键语义：终态 token 取 overlay 的观测值（与合并前 details 最后覆盖的终态一致），
    // 而不是 settlement 的 billable 拆桶值。
    expect(payload.inputTokens).toBe(107000);
    expect(payload.outputTokens).toBe(250);
    // settlement-only 列仍在
    expect(payload.costUsd).toBe("1.500000000000000");
    expect(payload.costMultiplier).toBe("1");
  });

  it("public-status rollup fires once after the durable write when the overlay is terminal", async () => {
    await updateMessageRequestCostWithBreakdown(
      nextId(),
      "1.5",
      undefined,
      baseSettlement(),
      baseOverlay()
    );
    await vi.waitFor(() => expect(rollupWriteMock).toHaveBeenCalledTimes(1));
    const event = rollupWriteMock.mock.calls[0][0].event;
    expect(event.durationMs).toBe(9876);
    expect(event.ttfbMs).toBe(321);
  });

  it("without overlay the settlement write keeps its legacy column set", async () => {
    await updateMessageRequestCostWithBreakdown(nextId(), "1.5", undefined, baseSettlement());
    expect(setPayloads).toHaveLength(1);
    const payload = setPayloads[0];
    expect(payload.statusCode).toBeUndefined();
    expect(payload.durationMs).toBeUndefined();
    // 没有 overlay 也不该触发 rollup
    await new Promise((r) => setTimeout(r, 20));
    expect(rollupWriteMock).not.toHaveBeenCalled();
  });

  it("unsupported-billing settlement also folds the overlay", async () => {
    await updateMessageRequestUnsupportedBillingSettlement(
      nextId(),
      baseSettlement(),
      baseOverlay()
    );
    expect(setPayloads).toHaveLength(1);
    expect(setPayloads[0].statusCode).toBe(200);
    expect(setPayloads[0].durationMs).toBe(9876);
  });

  it("winner settlement also folds the overlay (hedge path compatibility)", async () => {
    const persisted = await updateMessageRequestWinnerCost(
      nextId(),
      "2.0",
      undefined,
      baseSettlement(),
      baseOverlay()
    );
    expect(persisted).toBe("1.500000000000000");
    expect(setPayloads).toHaveLength(1);
    expect(setPayloads[0].statusCode).toBe(200);
    expect(setPayloads[0].durationMs).toBe(9876);
  });

  it("overlay without providerChain does not queue a rollup (non-terminal shape)", async () => {
    const { providerChain: _drop, ...partial } = baseOverlay();
    await updateMessageRequestCostWithBreakdown(
      nextId(),
      "1.5",
      undefined,
      baseSettlement(),
      partial
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(rollupWriteMock).not.toHaveBeenCalled();
  });
});
