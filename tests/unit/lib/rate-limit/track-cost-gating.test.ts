/**
 * trackCost 限额配置门控测试
 *
 * 背景：trackCost 之前对 5h/daily/weekly/monthly 的跟踪完全不看限额是否配置，
 * 导致全站未配置 5h 限额时仍在每次计费事件执行 3 次全量扫描 Lua（Redis 热点）。
 *
 * 门控语义：
 * - 显式 null 或 0 = 未配置限额 → 跳过对应维度的跟踪
 * - 缺省（undefined）= 保持旧行为（继续跟踪），避免未传配置的调用方被静默关闭
 * - > 0 = 已配置 → 按原逻辑跟踪
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn(async () => "Asia/Shanghai"),
}));

const pipelineCommands: Array<unknown[]> = [];

const pipeline = {
  incrbyfloat: vi.fn((...args: unknown[]) => {
    pipelineCommands.push(["incrbyfloat", ...args]);
    return pipeline;
  }),
  expire: vi.fn((...args: unknown[]) => {
    pipelineCommands.push(["expire", ...args]);
    return pipeline;
  }),
  exec: vi.fn(async () => {
    pipelineCommands.push(["exec"]);
    return [];
  }),
};

const redisClient = {
  status: "ready",
  eval: vi.fn(async () => "0"),
  exists: vi.fn(async () => 1),
  get: vi.fn(async () => null),
  set: vi.fn(async () => "OK"),
  setex: vi.fn(async () => "OK"),
  pipeline: vi.fn(() => pipeline),
};

vi.mock("@/lib/redis", () => ({
  getRedisClient: () => redisClient,
}));

const statisticsMock = {
  sumKeyTotalCost: vi.fn(async () => 0),
  sumUserTotalCost: vi.fn(async () => 0),
  sumProviderTotalCost: vi.fn(async () => 0),
  sumKeyCostInTimeRange: vi.fn(async () => 0),
  sumProviderCostInTimeRange: vi.fn(async () => 0),
  sumUserCostInTimeRange: vi.fn(async () => 0),
  findKeyCostEntriesInTimeRange: vi.fn(async () => []),
  findProviderCostEntriesInTimeRange: vi.fn(async () => []),
  findUserCostEntriesInTimeRange: vi.fn(async () => []),
};

vi.mock("@/repository/statistics", () => statisticsMock);

describe("RateLimitService.trackCost - limit configuration gating", () => {
  const baseTime = 1700000000000;

  beforeEach(() => {
    pipelineCommands.length = 0;
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(baseTime));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("5h rolling tracking", () => {
    it("skips ALL 5h TRACK evals when key/provider/user 5h limits are explicitly null", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        userId: 3,
        key5hUsd: null,
        provider5hUsd: null,
        user5hUsd: null,
        requestId: 1,
        createdAtMs: baseTime,
      });

      expect(redisClient.eval).not.toHaveBeenCalled();
    });

    it("skips 5h TRACK evals when limits are explicitly 0", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        userId: 3,
        key5hUsd: 0,
        provider5hUsd: 0,
        user5hUsd: 0,
        requestId: 1,
        createdAtMs: baseTime,
      });

      expect(redisClient.eval).not.toHaveBeenCalled();
    });

    it("tracks key/provider/user 5h windows when limits are configured", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        userId: 3,
        key5hUsd: 100,
        provider5hUsd: 200,
        user5hUsd: 300,
        requestId: 1,
        createdAtMs: baseTime,
      });

      expect(redisClient.eval).toHaveBeenCalledTimes(3);
      const calls = redisClient.eval.mock.calls.map((call) => call[2]);
      expect(calls).toContain("key:1:cost_5h_rolling:v2");
      expect(calls).toContain("provider:2:cost_5h_rolling:v2");
      expect(calls).toContain("user:3:cost_5h_rolling:v2");
    });

    it("tracks only the configured dimension when others are null", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        key5hUsd: 100,
        provider5hUsd: null,
        requestId: 1,
        createdAtMs: baseTime,
      });

      expect(redisClient.eval).toHaveBeenCalledTimes(1);
      expect(redisClient.eval.mock.calls[0][2]).toBe("key:1:cost_5h_rolling:v2");
    });

    it("keeps legacy behavior when amounts are not passed at all", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        requestId: 1,
        createdAtMs: baseTime,
      });

      // 旧行为：key + provider 两个 5h rolling eval
      expect(redisClient.eval).toHaveBeenCalledTimes(2);
    });
  });

  describe("key-dimension daily/weekly/monthly counters", () => {
    it("writes weekly/monthly counters only when the key limit is configured", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        keyWeeklyUsd: 50,
        keyMonthlyUsd: null,
        requestId: 1,
        createdAtMs: baseTime,
      });

      const writes = pipelineCommands
        .filter(([op]) => op === "incrbyfloat")
        .map(([, key]) => key);
      expect(writes).toContain("key:1:cost_weekly");
      expect(writes).not.toContain("key:1:cost_monthly");
    });

    it("writes no key-dimension counters when all key limits are null", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        keyDailyUsd: null,
        keyWeeklyUsd: null,
        keyMonthlyUsd: null,
        requestId: 1,
        createdAtMs: baseTime,
      });

      const writes = pipelineCommands
        .filter(([op]) => op === "incrbyfloat")
        .map(([, key]) => key);
      expect(writes).not.toContain("key:1:cost_daily_");
      expect(writes).not.toContain("key:1:cost_weekly");
      expect(writes).not.toContain("key:1:cost_monthly");
      // provider 维度不受影响（本次改动不动 provider weekly/monthly）
      expect(writes).toContain("provider:2:cost_weekly");
      expect(writes).toContain("provider:2:cost_monthly");
    });

    it("writes key daily fixed counter when the daily limit is configured", async () => {
      const { RateLimitService } = await import("@/lib/rate-limit");

      await RateLimitService.trackCost(1, 2, "sess", 10, {
        keyDailyUsd: 20,
        requestId: 1,
        createdAtMs: baseTime,
      });

      const writes = pipelineCommands
        .filter(([op]) => op === "incrbyfloat")
        .map(([, key]) => key);
      expect(writes.some((key) => String(key).startsWith("key:1:cost_daily_"))).toBe(true);
    });
  });
});
