import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRedisClient } from "@/lib/redis/client";
import { getDashboardRealtimeWithCache } from "@/lib/redis/dashboard-realtime-cache";
import {
  getLeaderboardWithCache,
} from "@/lib/redis/leaderboard-cache";
import { getOverviewWithCache } from "@/lib/redis/overview-cache";
import { getStatisticsWithCache } from "@/lib/redis/statistics-cache";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import {
  findDailyLeaderboard,
} from "@/repository/leaderboard";
import { getOverviewMetricsWithComparison } from "@/repository/overview";
import { getUserStatisticsFromDB } from "@/repository/statistics";
import type { DatabaseStatRow } from "@/types/statistics";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: vi.fn(),
}));

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn().mockResolvedValue("UTC"),
}));

vi.mock("@/repository/leaderboard", () => ({
  findDailyLeaderboard: vi.fn(),
}));

vi.mock("@/repository/overview", () => ({
  getOverviewMetricsWithComparison: vi.fn(),
}));

vi.mock("@/repository/statistics", () => ({
  getUserStatisticsFromDB: vi.fn(),
}));

type RedisMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

function createRedisMock(): RedisMock {
  return { get: vi.fn(), set: vi.fn(), setex: vi.fn(), del: vi.fn() };
}

function asRedis(redis: RedisMock) {
  return redis as unknown as NonNullable<ReturnType<typeof getRedisClient>>;
}

/**
 * 刷新窗口（锁被他人持有 + 新值未算完）内的等待方必须返回 :last 旧快照，
 * 而不是降级直查数据库——这是 2026-08-20 诊断后的统一缓存契约。
 */
describe("panel caches serve stale snapshot while refresh is in flight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSystemTimezone).mockResolvedValue("UTC");
  });

  it("statistics: retry timeout with :last present serves snapshot without querying DB", async () => {
    vi.useFakeTimers();
    try {
      const stale = [{ modelName: "old" }] as unknown as DatabaseStatRow[];
      const redis = createRedisMock();
      redis.get.mockImplementation(async (key: string) =>
        key.endsWith(":last") ? JSON.stringify(stale) : null
      );
      redis.set.mockResolvedValue(null); // 锁被他人持有
      vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));

      const pending = getStatisticsWithCache("today", "users");
      await vi.advanceTimersByTimeAsync(5100);
      const result = await pending;

      expect(result).toEqual(stale);
      expect(getUserStatisticsFromDB).not.toHaveBeenCalled();
      expect(redis.get).toHaveBeenCalledWith("statistics:today:users:global:tz:UTC:last");
    } finally {
      vi.useRealTimers();
    }
  });

  it("overview: lock held and no fresh value serves :last instead of direct query", async () => {
    vi.useFakeTimers();
    try {
      const stale = { concurrentSessions: 1 } as unknown as Awaited<
        ReturnType<typeof getOverviewMetricsWithComparison>
      >;
      const redis = createRedisMock();
      redis.get.mockImplementation(async (key: string) =>
        key.endsWith(":last") ? JSON.stringify(stale) : null
      );
      redis.set.mockResolvedValue(null);
      vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));

      const pending = getOverviewWithCache(99);
      await vi.advanceTimersByTimeAsync(200);
      const result = await pending;

      expect(result).toEqual(stale);
      expect(getOverviewMetricsWithComparison).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaderboard: retry timeout with :last present serves snapshot without querying DB", async () => {
    vi.useFakeTimers();
    try {
      const stale = [
        { userId: 1, userName: "alice", totalRequests: 5, totalCost: 1, totalTokens: 9 },
      ];
      const redis = createRedisMock();
      redis.get.mockImplementation(async (key: string) =>
        key.endsWith(":last") ? JSON.stringify(stale) : null
      );
      redis.set.mockResolvedValue(null);
      vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));

      const pending = getLeaderboardWithCache("daily", "USD", "user");
      await vi.advanceTimersByTimeAsync(5100);
      const result = await pending;

      expect(result).toEqual(stale);
      expect(findDailyLeaderboard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("statistics: successful compute writes both fresh and :last keys", async () => {
    const fresh = [{ modelName: "new" }] as unknown as DatabaseStatRow[];
    const redis = createRedisMock();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue("OK"); // 获得锁
    redis.del.mockResolvedValue(1);
    vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));
    vi.mocked(getUserStatisticsFromDB).mockResolvedValueOnce(fresh);

    const result = await getStatisticsWithCache("today", "users");

    expect(result).toEqual(fresh);
    const baseKey = "statistics:today:users:global:tz:UTC";
    expect(redis.setex).toHaveBeenCalledWith(baseKey, 600, JSON.stringify(fresh));
    expect(redis.setex).toHaveBeenCalledWith(`${baseKey}:last`, expect.any(Number), JSON.stringify(fresh));
    expect(redis.del).toHaveBeenCalledWith(`${baseKey}:lock`);
  });
});

describe("getDashboardRealtimeWithCache (composite cache)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns cached composite without computing", async () => {
    const cached = { hello: 1 };
    const redis = createRedisMock();
    redis.get.mockResolvedValueOnce(JSON.stringify(cached));
    vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));
    const compute = vi.fn();

    const result = await getDashboardRealtimeWithCache(compute);

    expect(result).toEqual(cached);
    expect(compute).not.toHaveBeenCalled();
    expect(redis.get).toHaveBeenCalledWith("dashboard-realtime:v1");
  });

  it("on miss acquires lock, computes, writes fresh and :last, releases lock", async () => {
    const data = { hello: 2 };
    const redis = createRedisMock();
    redis.get.mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce("OK");
    redis.setex.mockResolvedValue("OK");
    redis.del.mockResolvedValue(1);
    vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));
    const compute = vi.fn().mockResolvedValue(data);

    const result = await getDashboardRealtimeWithCache(compute);

    expect(result).toEqual(data);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(redis.setex).toHaveBeenCalledWith("dashboard-realtime:v1", 15, JSON.stringify(data));
    expect(redis.setex).toHaveBeenCalledWith(
      "dashboard-realtime:v1:last",
      600,
      JSON.stringify(data)
    );
    expect(redis.del).toHaveBeenCalledWith("dashboard-realtime:v1:lock");
  });

  it("lock held by another instance serves :last after brief wait", async () => {
    vi.useFakeTimers();
    try {
      const stale = { hello: 3 };
      const redis = createRedisMock();
      redis.get.mockImplementation(async (key: string) =>
        key === "dashboard-realtime:v1:last" ? JSON.stringify(stale) : null
      );
      redis.set.mockResolvedValueOnce(null); // 未获锁
      vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));
      const compute = vi.fn();

      const pending = getDashboardRealtimeWithCache(compute);
      await vi.advanceTimersByTimeAsync(300);
      const result = await pending;

      expect(result).toEqual(stale);
      expect(compute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cold start (no cache, no snapshot) computes directly", async () => {
    const redis = createRedisMock();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValueOnce(null);
    vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));
    const compute = vi.fn().mockResolvedValue({ cold: true });

    const result = await getDashboardRealtimeWithCache(compute);

    expect(result).toEqual({ cold: true });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("failed compute is not cached and releases the lock", async () => {
    const redis = createRedisMock();
    redis.get.mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce("OK");
    redis.del.mockResolvedValue(1);
    vi.mocked(getRedisClient).mockReturnValue(asRedis(redis));
    const compute = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(getDashboardRealtimeWithCache(compute)).rejects.toThrow("boom");
    expect(redis.setex).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith("dashboard-realtime:v1:lock");
  });
});
