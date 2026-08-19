import { logger } from "@/lib/logger";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import {
  getOverviewMetricsWithComparison,
  type OverviewMetricsWithComparison,
} from "@/repository/overview";
import { buildOverviewCacheKey } from "@/types/dashboard-cache";
import { getRedisClient } from "./client";
import { scanPattern } from "./scan-helper";

// 面板聚合查询在 9.3GB usage_ledger 上耗时可达分钟级；TTL 必须显著大于查询时长，
// 否则缓存永远在查询完成前过期（10s TTL 的旧设计导致每次轮询都打库）。
// 锁 TTL 同样必须覆盖查询时长，否则并发轮询会在锁过期后重复执行同一查询。
const CACHE_TTL = 600; // 10 minutes
const LOCK_TTL = 600; // 10 minutes
const LOCK_WAIT_MS = 100;
const LAST_TTL = 30 * 60; // 旧快照保留 30 分钟，仅在刷新窗口内被读取

function buildCacheKey(userId: number | undefined, timezone: string): string {
  return userId !== undefined
    ? buildOverviewCacheKey("user", userId, timezone)
    : buildOverviewCacheKey("global", timezone);
}

/**
 * Get overview metrics with Redis caching (10min TTL + stale-while-revalidate).
 * Fail-open: Redis unavailable -> direct DB query.
 * Thundering herd protection via lock key; waiters serve the `:last` snapshot
 * instead of fanning out direct queries when the refresh is slow.
 */
export async function getOverviewWithCache(
  userId?: number
): Promise<OverviewMetricsWithComparison> {
  const redis = getRedisClient();
  const timezone = await resolveSystemTimezone();
  const cacheKey = buildCacheKey(userId, timezone);
  const lastKey = `${cacheKey}:last`;
  const lockKey = `${cacheKey}:lock`;

  if (!redis) {
    return await getOverviewMetricsWithComparison(userId);
  }

  let lockAcquired = false;
  let data: OverviewMetricsWithComparison | undefined;

  try {
    // 1. Try cache hit
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as OverviewMetricsWithComparison;
    }

    // 2. Acquire lock (prevent thundering herd)
    const lockResult = await redis.set(lockKey, "1", "EX", LOCK_TTL, "NX");
    lockAcquired = lockResult === "OK";

    if (!lockAcquired) {
      // Another instance is computing -- wait briefly and retry cache
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      const retried = await redis.get(cacheKey);
      if (retried) return JSON.parse(retried) as OverviewMetricsWithComparison;
      // Still nothing -- serve the last snapshot if present (stale-while-revalidate)
      const last = await redis.get(lastKey);
      if (last) return JSON.parse(last) as OverviewMetricsWithComparison;
      // Cold cache with no snapshot -- direct query
      return await getOverviewMetricsWithComparison(userId);
    }

    // 3. Cache miss -- query DB
    data = await getOverviewMetricsWithComparison(userId);

    // 4. Store in cache with TTL (best-effort)
    try {
      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(data));
      await redis.setex(lastKey, LAST_TTL, JSON.stringify(data));
    } catch (writeErr) {
      logger.warn("[OverviewCache] Failed to write cache", { cacheKey, error: writeErr });
    }

    return data;
  } catch (error) {
    logger.warn("[OverviewCache] Redis error, fallback to direct query", { userId, error });
    return data ?? (await getOverviewMetricsWithComparison(userId));
  } finally {
    if (lockAcquired) {
      await redis
        .del(lockKey)
        .catch((err) =>
          logger.warn("[OverviewCache] Failed to release lock", { lockKey, error: err })
        );
    }
  }
}

/**
 * Invalidate overview cache for a specific user or global scope.
 */
export async function invalidateOverviewCache(userId?: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const scopePattern = userId !== undefined ? `overview:user:${userId}` : "overview:global";
  const pattern = `${scopePattern}:tz:*`;
  try {
    const matchedKeys = await scanPattern(redis, pattern);
    const keysToDelete = [...matchedKeys, scopePattern];
    await redis.del(...keysToDelete);
    logger.info("[OverviewCache] Cache invalidated", { userId, keysToDelete });
  } catch (error) {
    logger.error("[OverviewCache] Failed to invalidate cache", { userId, error });
  }
}

export async function invalidateAllOverviewCaches(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    const keys = await scanPattern(redis, "overview:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    logger.info("[OverviewCache] All caches invalidated", { deletedCount: keys.length });
  } catch (error) {
    logger.error("[OverviewCache] Failed to invalidate all caches", { error });
  }
}
