import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCurrentProviderStatus = vi.hoisted(() => vi.fn());
const redisClient = vi.hoisted(() => ({
  get: vi.fn(),
  setex: vi.fn(),
}));

vi.mock("@/lib/availability", () => ({
  getCurrentProviderStatus: mockGetCurrentProviderStatus,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: () => redisClient,
}));

const STATUS_PAYLOAD = [
  {
    providerId: 1,
    providerName: "Provider A",
    status: "green",
    availability: 1,
    requestCount: 10,
    lastRequestAt: "2026-04-13T08:59:00.000Z",
  },
];

describe("getCurrentProviderStatusWithCache", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetCurrentProviderStatus.mockResolvedValue(STATUS_PAYLOAD);
    redisClient.get.mockResolvedValue(null);
    redisClient.setex.mockResolvedValue("OK");
  });

  it("缓存命中时直接返回且不再查询", async () => {
    redisClient.get.mockResolvedValueOnce(JSON.stringify(STATUS_PAYLOAD));

    const { getCurrentProviderStatusWithCache } = await import("@/lib/redis/availability-cache");
    const result = await getCurrentProviderStatusWithCache();

    expect(result).toEqual(STATUS_PAYLOAD);
    expect(mockGetCurrentProviderStatus).not.toHaveBeenCalled();
    expect(redisClient.setex).not.toHaveBeenCalled();
  });

  it("缓存未命中时查询一次并以量化键写入 60 秒 TTL", async () => {
    const { getCurrentProviderStatusWithCache } = await import("@/lib/redis/availability-cache");
    const result = await getCurrentProviderStatusWithCache();

    expect(result).toEqual(STATUS_PAYLOAD);
    expect(mockGetCurrentProviderStatus).toHaveBeenCalledTimes(1);

    expect(redisClient.setex).toHaveBeenCalledTimes(1);
    const [key, ttl, value] = redisClient.setex.mock.calls[0];
    expect(key).toMatch(/^availability:current:v1:\d+$/);
    expect(ttl).toBe(60);
    expect(JSON.parse(value)).toEqual(STATUS_PAYLOAD);
  });

  it("同一 30 秒量化窗口内的两次未命中复用同一个键", async () => {
    const { getCurrentProviderStatusWithCache } = await import("@/lib/redis/availability-cache");
    await getCurrentProviderStatusWithCache();
    await getCurrentProviderStatusWithCache();

    const firstKey = redisClient.setex.mock.calls[0][0];
    const secondKey = redisClient.setex.mock.calls[1][0];
    expect(secondKey).toBe(firstKey);
  });

  it("Redis 读抛错时 fail-open 直查", async () => {
    redisClient.get.mockRejectedValueOnce(new Error("redis down"));

    const { getCurrentProviderStatusWithCache } = await import("@/lib/redis/availability-cache");
    const result = await getCurrentProviderStatusWithCache();

    expect(result).toEqual(STATUS_PAYLOAD);
    expect(mockGetCurrentProviderStatus).toHaveBeenCalledTimes(1);
  });
});
