import {
  type AvailabilityQueryOptions,
  type AvailabilityQueryResult,
  getCurrentProviderStatus,
  queryProviderAvailability,
} from "@/lib/availability";
import { logger } from "@/lib/logger";
import { getRedisClient } from "./client";

/**
 * 可用性聚合查询缓存。
 *
 * 背景：/api/availability 对 message_request 做 24h 窗口聚合（逐行 outcome 计算），
 * 实测单次查询 10-20 分钟。原实现无缓存，每次页面访问都实时重算。
 *
 * 设计要点（与面板缓存的关键差异）：
 * - 时间窗口必须量化：默认窗口终点是 now，每次刷新 endTime 都变；
 *   若缓存键用精确值则永不命中。键内将 start/end 向下取整到 30 分钟边界。
 * - TTL/锁必须超过查询时长（实测 13 分钟）：30 分钟，避免"写完即过期"。
 * - stale-while-revalidate：缓存过期后的首次刷新要重算 10+ 分钟，
 *   等待方返回 :last 快照（瞬时），页面不白屏。
 */
const CACHE_TTL = 30 * 60; // 30 min（必须 > 查询时长）
const LAST_TTL = 2 * 60 * 60; // 旧快照保留 2h，仅在刷新窗口内被读取
const LOCK_TTL = 30 * 60; // 锁必须覆盖查询时长
const LOCK_WAIT_MS = 200;
const QUANT_MS = 30 * 60 * 1000; // 键的时间量化粒度（30 分钟）

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMs(value: Date | string | undefined, fallback: () => number): number {
  if (value === undefined) return fallback();
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(parsed) ? fallback() : parsed;
}

function quantize(ms: number): number {
  return Math.floor(ms / QUANT_MS) * QUANT_MS;
}

function buildCacheKey(options: AvailabilityQueryOptions): string {
  const now = Date.now();
  const startMs = quantize(toMs(options.startTime, () => now - 24 * 60 * 60 * 1000));
  const endMs = quantize(toMs(options.endTime, () => now));
  const providerIds = [...(options.providerIds ?? [])].sort((a, b) => a - b).join(",");
  const bucket = options.bucketSizeMinutes ?? "auto";
  const disabled = options.includeDisabled ? "1" : "0";
  // maxBuckets 在 bucketSizeMinutes 缺省（auto）时决定实际桶大小，必须入键
  const maxBuckets = options.maxBuckets ?? "default";
  return `availability:v2:${startMs}:${endMs}:${providerIds || "all"}:${bucket}:${disabled}:${maxBuckets}`;
}

/**
 * 获取可用性数据（Redis 缓存，stale-while-revalidate）。
 * Fail-open：Redis 不可用 -> 直接查询。
 */
export async function getAvailabilityWithCache(
  options: AvailabilityQueryOptions = {}
): Promise<AvailabilityQueryResult> {
  const redis = getRedisClient();
  if (!redis) {
    return await queryProviderAvailability(options);
  }

  const cacheKey = buildCacheKey(options);
  const lastKey = `${cacheKey}:last`;
  const lockKey = `${cacheKey}:lock`;

  try {
    // 1. 缓存命中
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as AvailabilityQueryResult;
    }

    // 2. 获取计算锁
    const locked = await redis.set(lockKey, "1", "EX", LOCK_TTL, "NX");
    if (locked === "OK") {
      try {
        const data = await queryProviderAvailability(options);
        await redis
          .setex(cacheKey, CACHE_TTL, JSON.stringify(data))
          .catch((err: unknown) =>
            logger.warn("[AvailabilityCache] Failed to write cache", { cacheKey, error: err })
          );
        await redis.setex(lastKey, LAST_TTL, JSON.stringify(data)).catch((err: unknown) =>
          logger.warn("[AvailabilityCache] Failed to write last snapshot", {
            lastKey,
            error: err,
          })
        );
        return data;
      } finally {
        await redis
          .del(lockKey)
          .catch((err: unknown) =>
            logger.warn("[AvailabilityCache] Failed to release lock", { lockKey, error: err })
          );
      }
    }

    // 3. 锁被持有（另一实例正在计算）：短暂等待后重试缓存，仍无则返回旧快照
    await sleep(LOCK_WAIT_MS);
    const retried = await redis.get(cacheKey);
    if (retried) {
      return JSON.parse(retried) as AvailabilityQueryResult;
    }
    const last = await redis.get(lastKey);
    if (last) {
      return JSON.parse(last) as AvailabilityQueryResult;
    }

    // 4. 纯冷启动（无缓存也无快照）：直接查询
    return await queryProviderAvailability(options);
  } catch (error) {
    logger.warn("[AvailabilityCache] Redis error, fallback to direct query", {
      options,
      error: error instanceof Error ? error.message : String(error),
    });
    return await queryProviderAvailability(options);
  }
}

/**
 * /api/availability/current 的轻量微缓存。
 *
 * 与 24h 桶化查询不同：current 查询只扫 15 分钟窗口且读触发器维护的
 * success_rate_outcome 列（索引覆盖、亚秒级），所以不需要锁或
 * stale-while-revalidate——那套机制是为分钟级查询设计的。这里只做
 * 30 秒量化 + 60 秒 TTL 的 plain cache，把管理面板的重复轮询挡掉；
 * 量化保证相对窗口（NOW()-15m）在键上的稳定性。
 * Fail-open：Redis 不可用 -> 直接查询。
 */
const CURRENT_STATUS_QUANT_MS = 30 * 1000;
const CURRENT_STATUS_TTL = 60;

type CurrentProviderStatus = Awaited<ReturnType<typeof getCurrentProviderStatus>>;

export async function getCurrentProviderStatusWithCache(): Promise<CurrentProviderStatus> {
  const redis = getRedisClient();
  if (!redis) {
    return await getCurrentProviderStatus();
  }

  const bucket = Math.floor(Date.now() / CURRENT_STATUS_QUANT_MS);
  const cacheKey = `availability:current:v1:${bucket}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as CurrentProviderStatus;
    }

    const data = await getCurrentProviderStatus();
    await redis
      .setex(cacheKey, CURRENT_STATUS_TTL, JSON.stringify(data))
      .catch((err: unknown) =>
        logger.warn("[AvailabilityCache] Failed to write current cache", { cacheKey, error: err })
      );
    return data;
  } catch (error) {
    logger.warn("[AvailabilityCache] Redis error on current status, fallback to direct query", {
      error: error instanceof Error ? error.message : String(error),
    });
    return await getCurrentProviderStatus();
  }
}
