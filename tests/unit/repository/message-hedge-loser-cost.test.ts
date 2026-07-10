import { describe, expect, test, vi } from "vitest";

function sqlToString(sqlObj: unknown): string {
  const visited = new Set<unknown>();
  const walk = (node: unknown): string => {
    if (!node || visited.has(node)) return "";
    visited.add(node);
    if (typeof node === "string") return node;
    if (typeof node === "object") {
      const anyNode = node as any;
      if (Array.isArray(anyNode)) return anyNode.map(walk).join("");
      if (anyNode.name && typeof anyNode.name === "string") return anyNode.name;
      if (anyNode.value !== undefined) {
        if (Array.isArray(anyNode.value)) return anyNode.value.map(String).join("");
        return String(anyNode.value);
      }
      if (anyNode.queryChunks) return walk(anyNode.queryChunks);
      // Plain object (e.g. a drizzle .set({...}) payload): walk its values.
      return Object.values(anyNode).map(walk).join(" ");
    }
    return "";
  };
  return walk(sqlObj);
}

function mockDbWithWhere(
  whereImpl: () => Promise<unknown>,
  selectWhereImpl: () => Promise<unknown> = async () => []
) {
  const whereArgs: unknown[] = [];
  const setArgs: unknown[] = [];
  const update = vi.fn(() => ({
    set: vi.fn((obj: unknown) => {
      setArgs.push(obj);
      return {
        where: vi.fn((cond: unknown) => {
          whereArgs.push(cond);
          return { returning: vi.fn(() => whereImpl()) };
        }),
      };
    }),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(() => selectWhereImpl()) })),
  }));
  vi.doMock("@/drizzle/db", () => ({
    db: {
      update,
      select,
      execute: vi.fn(async () => []),
    },
  }));
  return { update, select, whereArgs, setArgs };
}

const LOSER = {
  providerId: 2,
  providerName: "p2",
  attemptNumber: 3,
  costUsd: "0.01",
};

const BILLING_SETTLEMENT = {
  providerId: 10,
  model: "gpt-5.6-sol",
  costMultiplier: 1,
  groupCostMultiplier: 1,
  providerChain: [{ id: 10, name: "winner", reason: "hedge_winner" }],
  specialSettings: [],
  context1mApplied: false,
  swapCacheTtlApplied: false,
  inputTokens: 10,
  observedInputTokens: 10,
  outputTokens: 2,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreation5mInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheWriteTokensReported: null,
  cacheWriteAccounting: "none" as const,
};

describe("addMessageRequestHedgeLoserCost (idempotent + retried direct write)", () => {
  test("返回写入后的权威请求总成本", async () => {
    vi.resetModules();
    mockDbWithWhere(async () => [{ costUsd: "0.11" }]);

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(addMessageRequestHedgeLoserCost(1, "0.01", LOSER)).resolves.toBe("0.11");
  });

  test("写入已提交但客户端报错时，幂等重试回读权威请求总成本", async () => {
    vi.resetModules();
    let updateCalls = 0;
    const { update, select } = mockDbWithWhere(
      async () => {
        updateCalls++;
        if (updateCalls === 1) throw new Error("ambiguous commit");
        return [];
      },
      async () => [{ costUsd: "0.11" }]
    );

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(addMessageRequestHedgeLoserCost(1, "0.01", LOSER)).resolves.toBe("0.11");
    expect(update).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(1);
  });

  test("成功时只写一次，并带幂等 guard（NOT ... @>）与累加 SQL", async () => {
    vi.resetModules();
    const { update, whereArgs, setArgs } = mockDbWithWhere(async () => [{ costUsd: "0.11" }]);

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await addMessageRequestHedgeLoserCost(1, "0.01", LOSER);

    expect(update).toHaveBeenCalledTimes(1);

    // SET 子句应是对 cost_usd 的累加 + hedge_losers 的追加。
    const setSql = sqlToString(setArgs[0]).toLowerCase();
    expect(setSql).toContain("cost_usd");
    expect(setSql).toContain("hedge_losers");

    // WHERE 子句应包含按 (providerId, attemptNumber) 去重的 jsonb 包含 guard。
    const whereSql = sqlToString(whereArgs[0]).toLowerCase();
    expect(whereSql).toContain("@>");
    expect(whereSql).toContain("hedge_losers");
  });

  test("unsupported loser 只追加审计，不把 NULL cost_usd 物化为零", async () => {
    vi.resetModules();
    const { update, setArgs } = mockDbWithWhere(async () => [{ costUsd: null }]);

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(
      addMessageRequestHedgeLoserCost(1, "0", {
        ...LOSER,
        costUsd: "0",
        billingStatus: "unsupported",
      })
    ).resolves.toBeNull();

    expect(update).toHaveBeenCalledTimes(1);
    const setSql = sqlToString(setArgs[0]).toLowerCase();
    expect(setSql).toContain("hedge_losers");
    expect(setSql).not.toContain("cost_usd");
  });

  test("unsupported loser 模糊提交后的幂等回读允许权威成本保持 NULL", async () => {
    vi.resetModules();
    let updateCalls = 0;
    const { update, select } = mockDbWithWhere(
      async () => {
        updateCalls++;
        if (updateCalls === 1) throw new Error("ambiguous commit");
        return [];
      },
      async () => [{ costUsd: null }]
    );

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(
      addMessageRequestHedgeLoserCost(1, "0", {
        ...LOSER,
        costUsd: "0",
        billingStatus: "unsupported",
      })
    ).resolves.toBeNull();
    expect(update).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledTimes(1);
  });

  test("unsupported loser 拒绝非零费用，避免审计状态与账单互相矛盾", async () => {
    vi.resetModules();
    const { update } = mockDbWithWhere(async () => []);

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(
      addMessageRequestHedgeLoserCost(1, "0.01", {
        ...LOSER,
        billingStatus: "unsupported",
      })
    ).rejects.toThrow("Unsupported hedge-loser billing audit must not include a non-zero cost");
    expect(update).not.toHaveBeenCalled();
  });

  test("瞬时失败后重试，最终成功不抛错", async () => {
    vi.resetModules();
    let calls = 0;
    const { update } = mockDbWithWhere(async () => {
      calls++;
      if (calls < 3) throw new Error("transient db error");
      return [{ costUsd: "0.11" }];
    });

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(addMessageRequestHedgeLoserCost(1, "0.01", LOSER)).resolves.toBe("0.11");
    expect(update).toHaveBeenCalledTimes(3);
  });

  test("请求行不存在时显式失败，禁止调用方继续追踪未落库费用", async () => {
    vi.resetModules();
    const { update, select } = mockDbWithWhere(
      async () => [],
      async () => []
    );

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(addMessageRequestHedgeLoserCost(404, "0.01", LOSER)).rejects.toThrow(
      "Message request 404 not found"
    );
    expect(update).toHaveBeenCalledTimes(3);
    expect(select).toHaveBeenCalledTimes(3);
  });

  test("持续失败：重试 MAX 次后抛错（让调用方记录，不静默丢失）", async () => {
    vi.resetModules();
    const { update } = mockDbWithWhere(async () => {
      throw new Error("db down");
    });

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await expect(addMessageRequestHedgeLoserCost(1, "0.01", LOSER)).rejects.toThrow("db down");
    expect(update).toHaveBeenCalledTimes(3);
  });

  test("非法/零费用（formatCostForStorage 返回 null）时跳过写入", async () => {
    vi.resetModules();
    const { update } = mockDbWithWhere(async () => []);

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    // 传入无法解析为 Decimal 的值 -> 直接跳过，不写库。
    await addMessageRequestHedgeLoserCost(1, "not-a-number", LOSER);
    expect(update).not.toHaveBeenCalled();
  });

  test("写入 hedge_losers 前清理 providerName 中的 JSONB 非法字符", async () => {
    vi.resetModules();
    const { setArgs } = mockDbWithWhere(async () => [{ costUsd: "0.11" }]);

    const { addMessageRequestHedgeLoserCost } = await import("@/repository/message");
    await addMessageRequestHedgeLoserCost(1, "0.01", {
      ...LOSER,
      providerName: "bad\u0000provider\u0001name \u{1f600}\ud800",
    });

    const setSql = sqlToString(setArgs[0]);
    expect(setSql).not.toContain("\\u0000");
    expect(setSql).toContain("badprovider name \u{1f600}\uFFFD");
  });
});

describe("updateMessageRequestWinnerCost (direct, idempotent, loser-sum-aware)", () => {
  test("返回包含已落库输家费用的权威请求总成本", async () => {
    vi.resetModules();
    mockDbWithWhere(async () => [{ costUsd: "0.12" }]);

    const { updateMessageRequestWinnerCost } = await import("@/repository/message");
    await expect(
      updateMessageRequestWinnerCost(1, "0.1", undefined, BILLING_SETTLEMENT)
    ).resolves.toBe("0.12");
  });

  test("SET 为 winnerCost::numeric + SUM(hedge_losers[].costUsd)，幂等可重试", async () => {
    vi.resetModules();
    const { update, setArgs } = mockDbWithWhere(async () => [{ costUsd: "0.12" }]);

    const { updateMessageRequestWinnerCost } = await import("@/repository/message");
    await updateMessageRequestWinnerCost(1, "0.1", undefined, BILLING_SETTLEMENT);

    expect(update).toHaveBeenCalledTimes(1);
    const setSql = sqlToString(setArgs[0]).toLowerCase();
    // 赢家费用 + 已落库的输家费用之和（重算式 -> 替换语义 -> 重试安全）。
    expect(setSql).toContain("hedge_losers");
    expect(setSql).toContain("jsonb_array_elements");
    expect(setSql).toContain("sum");
    expect(setSql).toContain("::numeric");
  });

  test("瞬时失败后重试，最终成功不抛错", async () => {
    vi.resetModules();
    let calls = 0;
    const { update } = mockDbWithWhere(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return [{ costUsd: "0.12" }];
    });

    const { updateMessageRequestWinnerCost } = await import("@/repository/message");
    await expect(
      updateMessageRequestWinnerCost(1, "0.1", undefined, BILLING_SETTLEMENT)
    ).resolves.toBe("0.12");
    expect(update).toHaveBeenCalledTimes(3);
  });

  test("请求行不存在时显式失败，禁止后续 Redis 形成幽灵账单", async () => {
    vi.resetModules();
    const { update } = mockDbWithWhere(async () => []);

    const { updateMessageRequestWinnerCost } = await import("@/repository/message");
    await expect(
      updateMessageRequestWinnerCost(404, "0.1", undefined, BILLING_SETTLEMENT)
    ).rejects.toThrow("Message request 404 not found");
    expect(update).toHaveBeenCalledTimes(1);
  });
});
