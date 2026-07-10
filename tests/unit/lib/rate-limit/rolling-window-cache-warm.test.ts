import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pipelineCommands: Array<unknown[]> = [];

const pipeline = {
  zadd: vi.fn((...args: unknown[]) => {
    pipelineCommands.push(["zadd", ...args]);
    return pipeline;
  }),
  expire: vi.fn((...args: unknown[]) => {
    pipelineCommands.push(["expire", ...args]);
    return pipeline;
  }),
  incrbyfloat: vi.fn(() => pipeline),
  exec: vi.fn(async () => {
    pipelineCommands.push(["exec"]);
    return [];
  }),
};

const redisClient = {
  status: "ready",
  eval: vi.fn(async () => "0"),
  exists: vi.fn(async () => 0),
  pipeline: vi.fn(() => pipeline),
  get: vi.fn(async () => null),
  set: vi.fn(async () => "OK"),
};

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => redisClient,
}));

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn(async () => "Asia/Shanghai"),
}));

const statisticsMock = {
  sumKeyTotalCost: vi.fn(async () => 0),
  sumUserCostToday: vi.fn(async () => 0),
  sumUserTotalCost: vi.fn(async () => 0),
  sumKeyCostInTimeRange: vi.fn(async () => 0),
  sumProviderCostInTimeRange: vi.fn(async () => 0),
  sumUserCostInTimeRange: vi.fn(async () => 0),
  findKeyCostEntriesInTimeRange: vi.fn(async () => []),
  findProviderCostEntriesInTimeRange: vi.fn(async () => []),
  findUserCostEntriesInTimeRange: vi.fn(async () => []),
};

vi.mock("@/repository/statistics", () => statisticsMock);

describe("RateLimitService rolling window cache warm", () => {
  const nowMs = 1_700_000_000_000;

  const rollingMemberFromEvalCall = (call: unknown[]): string => {
    const cost = String(call[3]);
    const createdAtMs = String(call[4]);
    const requestId = String(call[6] ?? "");
    const billingEventId = String(call[7] ?? "");
    const memberId = billingEventId || requestId;
    return memberId ? `${createdAtMs}:${memberId}:${cost}` : `${createdAtMs}:${cost}`;
  };

  beforeEach(() => {
    pipelineCommands.length = 0;
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowMs));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getCurrentCost(5h) rebuilds ZSET from DB entries on cache miss", async () => {
    statisticsMock.findKeyCostEntriesInTimeRange.mockResolvedValueOnce([
      { id: 101, createdAt: new Date(nowMs - 4 * 60 * 60 * 1000), costUsd: 1.5 },
      { id: 102, createdAt: new Date(nowMs - 1 * 60 * 60 * 1000), costUsd: 2.0 },
    ]);

    const { RateLimitService } = await import("@/lib/rate-limit");

    const current = await RateLimitService.getCurrentCost(1, "key", "5h");
    expect(current).toBeCloseTo(3.5, 10);

    const zaddCalls = pipelineCommands.filter((c) => c[0] === "zadd");
    expect(zaddCalls).toHaveLength(2);

    const expireCalls = pipelineCommands.filter((c) => c[0] === "expire");
    expect(expireCalls).toHaveLength(1);
    expect(expireCalls[0][1]).toBe("key:1:cost_5h_rolling");
    expect(expireCalls[0][2]).toBe(21600);

    // member format: `${createdAtMs}:${requestId}:${costUsd}`
    const first = zaddCalls[0];
    expect(first[1]).toBe("key:1:cost_5h_rolling");
    expect(first[2]).toBe(nowMs - 4 * 60 * 60 * 1000);
    expect(first[3]).toBe(`${nowMs - 4 * 60 * 60 * 1000}:101:1.5`);
  });

  it("provider cache warm preserves distinct billing event ids for one request", async () => {
    const createdAt = new Date(nowMs - 60_000);
    statisticsMock.findProviderCostEntriesInTimeRange.mockResolvedValueOnce([
      {
        id: 123,
        billingEventId: "123:winner",
        createdAt,
        costUsd: 0.5,
      },
      {
        id: 123,
        billingEventId: "123:hedge-loser:2:2",
        createdAt,
        costUsd: 0.5,
      },
    ]);

    const { RateLimitService } = await import("@/lib/rate-limit");
    const current = await RateLimitService.getCurrentCost(2, "provider", "5h");

    expect(current).toBe(1);
    const members = pipelineCommands
      .filter((command) => command[0] === "zadd")
      .map((command) => command[3]);
    expect(members).toEqual([
      `${createdAt.getTime()}:123:winner:0.5`,
      `${createdAt.getTime()}:123:hedge-loser:2:2:0.5`,
    ]);
  });

  it("getCurrentCost(5h) clips user cache-miss rebuild by the later 5h reset marker", async () => {
    const limit5hCostResetAt = new Date(nowMs - 2 * 60 * 60 * 1000);
    statisticsMock.findUserCostEntriesInTimeRange.mockResolvedValueOnce([
      { id: 201, createdAt: new Date(nowMs - 60 * 60 * 1000), costUsd: 2.5 },
    ]);

    const { RateLimitService } = await import("@/lib/rate-limit");
    const current = await RateLimitService.getCurrentCost(7, "user", "5h", "00:00", "rolling", {
      costResetAt: new Date(nowMs - 3 * 60 * 60 * 1000),
      limit5hCostResetAt,
    });

    expect(current).toBeCloseTo(2.5, 10);
    expect(statisticsMock.findUserCostEntriesInTimeRange).toHaveBeenCalledWith(
      7,
      limit5hCostResetAt,
      new Date(nowMs)
    );
  });

  it("trackCost passes requestId and uses createdAtMs for rolling windows", async () => {
    const { RateLimitService } = await import("@/lib/rate-limit");

    await RateLimitService.trackCost(1, 2, "sess", 0.5, {
      requestId: 123,
      createdAtMs: nowMs - 1000,
      keyResetMode: "fixed",
      providerResetMode: "fixed",
    });

    const evalCalls = redisClient.eval.mock.calls;
    expect(evalCalls.length).toBeGreaterThanOrEqual(2);

    const [firstCall] = evalCalls;
    expect(firstCall[2]).toBe("key:1:cost_5h_rolling");
    expect(firstCall[4]).toBe(String(nowMs - 1000));
    expect(firstCall[6]).toBe("123");
  });

  it("trackCost passes a distinct billing event id to every rolling window", async () => {
    const { RateLimitService } = await import("@/lib/rate-limit");

    await RateLimitService.trackCost(1, 2, "sess", 0.5, {
      requestId: 123,
      billingEventId: "123:loser:2",
      createdAtMs: nowMs,
      keyResetMode: "rolling",
      providerResetMode: "rolling",
    });

    const rollingCalls = redisClient.eval.mock.calls.filter((call) =>
      String(call[2]).includes("rolling")
    );
    expect(rollingCalls).toHaveLength(4);
    expect(rollingCalls.every((call) => call[6] === "123")).toBe(true);
    expect(rollingCalls.every((call) => call[7] === "123:loser:2")).toBe(true);
  });

  it("keeps equal-cost winner and loser events distinct in both 5h and daily windows", async () => {
    const { RateLimitService } = await import("@/lib/rate-limit");
    const common = {
      requestId: 123,
      createdAtMs: nowMs,
      keyResetMode: "rolling" as const,
      providerResetMode: "rolling" as const,
    };

    await RateLimitService.trackCost(1, 2, "sess", 0.5, {
      ...common,
      billingEventId: "123:winner",
    });
    await RateLimitService.trackCost(1, 2, "sess", 0.5, {
      ...common,
      billingEventId: "123:loser:2",
    });

    for (const key of ["key:1:cost_5h_rolling", "key:1:cost_daily_rolling"]) {
      const members = redisClient.eval.mock.calls
        .filter((call) => call[2] === key)
        .map(rollingMemberFromEvalCall);
      expect(new Set(members)).toHaveLength(2);
    }
  });

  it("deduplicates a retried billing event in both 5h and daily windows", async () => {
    const { RateLimitService } = await import("@/lib/rate-limit");
    const options = {
      requestId: 123,
      billingEventId: "123:loser:2",
      createdAtMs: nowMs,
      keyResetMode: "rolling" as const,
      providerResetMode: "rolling" as const,
    };

    await RateLimitService.trackCost(1, 2, "sess", 0.5, options);
    await RateLimitService.trackCost(1, 2, "sess", 0.5, options);

    for (const key of ["key:1:cost_5h_rolling", "key:1:cost_daily_rolling"]) {
      const members = redisClient.eval.mock.calls
        .filter((call) => call[2] === key)
        .map(rollingMemberFromEvalCall);
      expect(members).toHaveLength(2);
      expect(new Set(members)).toHaveLength(1);
    }
  });

  it("trackUserDailyCost passes billingEventId while retaining requestId fallback data", async () => {
    const { RateLimitService } = await import("@/lib/rate-limit");

    await RateLimitService.trackUserDailyCost(7, 0.5, "00:00", "rolling", {
      requestId: 123,
      billingEventId: "123:winner",
      createdAtMs: nowMs,
    });

    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    const call = redisClient.eval.mock.calls[0];
    expect(call[2]).toBe("user:7:cost_daily_rolling");
    expect(call[6]).toBe("123");
    expect(call[7]).toBe("123:winner");
  });

  it("keeps user daily billing events distinct and deduplicates retries", async () => {
    const { RateLimitService } = await import("@/lib/rate-limit");
    const common = { requestId: 123, createdAtMs: nowMs };

    await RateLimitService.trackUserDailyCost(7, 0.5, "00:00", "rolling", {
      ...common,
      billingEventId: "123:winner",
    });
    await RateLimitService.trackUserDailyCost(7, 0.5, "00:00", "rolling", {
      ...common,
      billingEventId: "123:loser:2",
    });
    await RateLimitService.trackUserDailyCost(7, 0.5, "00:00", "rolling", {
      ...common,
      billingEventId: "123:loser:2",
    });

    const members = redisClient.eval.mock.calls.map(rollingMemberFromEvalCall);
    expect(members).toHaveLength(3);
    expect(new Set(members)).toHaveLength(2);
  });
});
