import { logger } from "@/lib/logger";
import { getRedisClient } from "./client";

/**
 * 数据大屏（dashboard-realtime）整包响应缓存。
 *
 * 背景：big-screen 页面以 SWR 2 秒轮询 getDashboardRealtimeData，而该 action
 * 每次轮询都直连数据库跑三个无缓制的日榜聚合（user/provider/model），
 * 一个打开的大屏标签页即每分钟约 90 次聚合查询（2026-08-20 诊断）。
 *
 * 设计（对齐 availability-cache 的 stale-while-revalidate 形态）：
 * - 整包单一全局键：composite 对所有有权限的观看者一致；
 * - TTL 15s：大屏是展示墙，完全可容忍；
 * - `:last` 旧快照：刷新窗口内瞬时返回，不白屏、不降级直查；
 * - NX 单飞锁：同一时刻只有一个实例真正落库；
 * - fail-open：Redis 不可用时直接计算。
 */
const CACHE_KEY = "dashboard-realtime:v1";
const CACHE_TTL = 15; // 15s
const LAST_TTL = 10 * 60; // 旧快照保留 10 分钟
const LOCK_TTL = 120; // 锁覆盖 composite 计算时长（最重为日级聚合，秒级）
const LOCK_WAIT_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 获取数据大屏整包数据（Redis 缓存 + stale-while-revalidate）。
 * `compute` 仅在需要刷新时被调用。
 */
export async function getDashboardRealtimeWithCache<T>(compute: () => Promise<T>): Promise<T> {
  const redis = getRedisClient();
  if (!redis) {
    return await compute();
  }

  const lastKey = `${CACHE_KEY}:last`;
  const lockKey = `${CACHE_KEY}:lock`;

  try {
    // 1. 缓存命中
    const cached = await redis.get(CACHE_KEY);
    if (cached) {
      return JSON.parse(cached) as T;
    }

    // 2. 获取计算锁（单飞）
    const locked = await redis.set(lockKey, "1", "EX", LOCK_TTL, "NX");
    if (locked === "OK") {
      try {
        const data = await compute();
        await redis
          .setex(CACHE_KEY, CACHE_TTL, JSON.stringify(data))
          .catch((err: unknown) =>
            logger.warn("[DashboardRealtimeCache] Failed to write cache", { error: err })
          );
        await redis
          .setex(lastKey, LAST_TTL, JSON.stringify(data))
          .catch((err: unknown) =>
            logger.warn("[DashboardRealtimeCache] Failed to write last snapshot", { error: err })
          );
        return data;
      } finally {
        await redis
          .del(lockKey)
          .catch((err: unknown) =>
            logger.warn("[DashboardRealtimeCache] Failed to release lock", { lockKey, error: err })
          );
      }
    }

    // 3. 锁被持有（另一实例正在刷新）：短暂等待后重试缓存，仍无则返回旧快照
    await sleep(LOCK_WAIT_MS);
    const retried = await redis.get(CACHE_KEY);
    if (retried) {
      return JSON.parse(retried) as T;
    }
    const last = await redis.get(lastKey);
    if (last) {
      return JSON.parse(last) as T;
    }

    // 4. 纯冷启动（无缓存也无快照）：直接计算
    return await compute();
  } catch (error) {
    logger.warn("[DashboardRealtimeCache] Redis error, fallback to direct compute", {
      error: error instanceof Error ? error.message : String(error),
    });
    return await compute();
  }
}

/**
 * 使大屏整包缓存失效（例如全局视图权限设置变更后）。
 */
export async function invalidateDashboardRealtimeCache(): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(CACHE_KEY, `${CACHE_KEY}:last`);
  } catch (error) {
    logger.warn("[DashboardRealtimeCache] Failed to invalidate cache", { error });
  }
}
