/**
 * availability-cache 测试
 *
 * 覆盖：量化键、缓存命中/未命中、锁与 stale-while-revalidate、TTL、fail-open。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRedisClient } from "@/lib/redis/client";
import { queryProviderAvailability } from "@/lib/availability";
import { getAvailabilityWithCache } from "@/lib/redis/availability-cache";

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: vi.fn(),
}));

vi.mock("@/lib/availability", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    queryProviderAvailability: vi.fn(),
  };
});

type RedisMock = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
};

function createRedisMock(): RedisMock {
  return {
    get: vi.fn(),
    set: vi.fn(),
    // 模块对 setex/del 链式调用 .catch()，必须返回 Promise
    setex: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
  };
}

function createResult(): unknown {
  return {
    queriedAt: "2026-08-19T00:00:00.000Z",
    startTime: "2026-08-18T00:00:00.000Z",
    endTime: "2026-08-19T00:00:00.000Z",
    bucketSizeMinutes: 30,
    providers: [],
    systemAvailability: 100,
  };
}

const mockedGet = vi.mocked(getRedisClient);
const mockedQuery = vi.mocked(queryProviderAvailability);

describe("getAvailabilityWithCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached data on hit without querying", async () => {
    const redis = createRedisMock();
    const data = createResult();
    redis.get.mockResolvedValueOnce(JSON.stringify(data));
    mockedGet.mockReturnValue(redis as unknown as ReturnType<typeof getRedisClient>);

    const result = await getAvailabilityWithCache({});

    expect(result).toEqual(data);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("computes on miss, writes cache + last snapshot, releases lock", async () => {
    const redis = createRedisMock();
    const data = createResult();
    redis.get.mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce("OK");
    redis.del.mockResolvedValueOnce(1);
    mockedGet.mockReturnValue(redis as unknown as ReturnType<typeof getRedisClient>);
    mockedQuery.mockResolvedValueOnce(data as never);

    const result = await getAvailabilityWithCache({});

    expect(result).toEqual(data);
    expect(mockedQuery).toHaveBeenCalledTimes(1);
    // 缓存键：start/end 量化到 30 分钟边界；锁键以 :lock 结尾
    const lockCall = redis.set.mock.calls[0] as unknown[];
    expect(String(lockCall[0])).toMatch(/^availability:v2:\d+:\d+:all:auto:0:default:lock$/);
    expect(lockCall[2]).toBe("EX");
    expect(lockCall[3]).toBe(1800);
    expect(lockCall[4]).toBe("NX");
    const cacheKey = String(lockCall[0]).replace(/:lock$/, "");
    expect(redis.setex).toHaveBeenCalledWith(cacheKey, 1800, JSON.stringify(data));
    expect(redis.setex).toHaveBeenCalledWith(`${cacheKey}:last`, 7200, JSON.stringify(data));
    expect(redis.del).toHaveBeenCalledWith(`${cacheKey}:lock`);
  });

  it("quantizes the time range so refreshes within the same window share a key", async () => {
    const redis = createRedisMock();
    const data = createResult();
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(data));
    redis.set.mockResolvedValueOnce("OK");
    redis.del.mockResolvedValueOnce(1);
    mockedGet.mockReturnValue(redis as unknown as ReturnType<typeof getRedisClient>);
    mockedQuery.mockResolvedValueOnce(data as never);

    // 12:00:00 与 12:25:00 属于同一个 30 分钟量化窗口
    await getAvailabilityWithCache({ endTime: new Date("2026-08-19T12:00:00Z") });
    vi.setSystemTime(new Date("2026-08-19T12:25:00Z"));
    await getAvailabilityWithCache({ endTime: new Date("2026-08-19T12:25:00Z") });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    expect(redis.get).toHaveBeenCalledTimes(2);
  });

  it("includes maxBuckets in the key (affects auto bucket sizing)", async () => {
    const redis = createRedisMock();
    const data = createResult();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue("OK");
    redis.del.mockResolvedValue(1);
    mockedGet.mockReturnValue(redis as unknown as ReturnType<typeof getRedisClient>);
    mockedQuery.mockResolvedValue(data as never);

    await getAvailabilityWithCache({ maxBuckets: 10 });
    await getAvailabilityWithCache({ maxBuckets: 100 });

    expect(mockedQuery).toHaveBeenCalledTimes(2);
    const keys = redis.set.mock.calls.map((call) => String(call[0]));
    expect(keys[0]).toContain(":10:lock");
    expect(keys[1]).toContain(":100:lock");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("returns the stale snapshot while another instance holds the lock", async () => {
    vi.useFakeTimers();
    const redis = createRedisMock();
    const stale = createResult();
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    redis.set.mockResolvedValueOnce(null); // lock not acquired
    redis.get.mockResolvedValueOnce(JSON.stringify(stale)); // :last hit
    mockedGet.mockReturnValue(redis as unknown as ReturnType<typeof getRedisClient>);

    const pending = getAvailabilityWithCache({});
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;

    expect(result).toEqual(stale);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("falls back to direct query when Redis is unavailable", async () => {
    mockedGet.mockReturnValue(null);
    mockedQuery.mockResolvedValueOnce(createResult() as never);

    const result = await getAvailabilityWithCache({});

    expect(result).toEqual(createResult());
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("falls back to direct query on Redis error", async () => {
    const redis = createRedisMock();
    redis.get.mockRejectedValueOnce(new Error("redis down"));
    mockedGet.mockReturnValue(redis as unknown as ReturnType<typeof getRedisClient>);
    mockedQuery.mockResolvedValueOnce(createResult() as never);

    const result = await getAvailabilityWithCache({});

    expect(result).toEqual(createResult());
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });
});
