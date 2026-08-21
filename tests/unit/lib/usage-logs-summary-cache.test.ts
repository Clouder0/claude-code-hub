import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindUsageLogsSummary = vi.hoisted(() => vi.fn());
const redisClient = vi.hoisted(() => ({
  get: vi.fn(),
  setex: vi.fn(),
}));

vi.mock("@/repository/usage-logs", () => ({
  findUsageLogsSummary: mockFindUsageLogsSummary,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => redisClient,
}));

const SUMMARY = {
  total: 42,
  summary: {
    totalRequests: 40,
    totalCost: 1.5,
    totalTokens: 9000,
    totalInputTokens: 5000,
    totalOutputTokens: 4000,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreation5mTokens: 0,
    totalCacheCreation1hTokens: 0,
  },
};

describe("getUsageLogsSummaryWithCache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFindUsageLogsSummary.mockResolvedValue(SUMMARY);
    redisClient.get.mockResolvedValue(null);
    redisClient.setex.mockResolvedValue("OK");
  });

  it("缓存命中时直接返回且不查库", async () => {
    redisClient.get.mockResolvedValueOnce(JSON.stringify(SUMMARY));

    const { getUsageLogsSummaryWithCache } = await import("@/lib/redis/usage-logs-summary-cache");
    const result = await getUsageLogsSummaryWithCache({ userId: 1 });

    expect(result).toEqual(SUMMARY);
    expect(mockFindUsageLogsSummary).not.toHaveBeenCalled();
    expect(redisClient.setex).not.toHaveBeenCalled();
  });

  it("未命中时查库一次并写入 60s TTL", async () => {
    const { getUsageLogsSummaryWithCache } = await import("@/lib/redis/usage-logs-summary-cache");
    const result = await getUsageLogsSummaryWithCache({ userId: 1 });

    expect(result).toEqual(SUMMARY);
    expect(mockFindUsageLogsSummary).toHaveBeenCalledTimes(1);
    expect(redisClient.setex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = redisClient.setex.mock.calls[0];
    expect(key).toMatch(/^usage-logs:summary:v1:[0-9a-f]{24}$/);
    expect(ttl).toBe(60);
    expect(JSON.parse(value)).toEqual(SUMMARY);
  });

  it("page/pageSize 不参与缓存键：翻页复用同一条缓存", async () => {
    const { getUsageLogsSummaryWithCache } = await import("@/lib/redis/usage-logs-summary-cache");
    await getUsageLogsSummaryWithCache({ userId: 1, model: "m" });
    await getUsageLogsSummaryWithCache({ userId: 1, model: "m" });

    const firstKey = redisClient.setex.mock.calls[0][0];
    const secondKey = redisClient.setex.mock.calls[1][0];
    expect(secondKey).toBe(firstKey);
  });

  it("不同过滤维度使用不同的缓存键", async () => {
    const { getUsageLogsSummaryWithCache } = await import("@/lib/redis/usage-logs-summary-cache");
    await getUsageLogsSummaryWithCache({ userId: 1 });
    await getUsageLogsSummaryWithCache({ userId: 2 });

    expect(redisClient.setex.mock.calls[0][0]).not.toBe(redisClient.setex.mock.calls[1][0]);
  });

  it("Redis 抛错时 fail-open 直查", async () => {
    redisClient.get.mockRejectedValueOnce(new Error("redis down"));

    const { getUsageLogsSummaryWithCache } = await import("@/lib/redis/usage-logs-summary-cache");
    const result = await getUsageLogsSummaryWithCache({ userId: 1 });

    expect(result).toEqual(SUMMARY);
    expect(mockFindUsageLogsSummary).toHaveBeenCalledTimes(1);
  });
});
