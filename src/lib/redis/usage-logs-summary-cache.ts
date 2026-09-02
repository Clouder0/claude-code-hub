import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis/client";
import {
  findUsageLogsStats,
  findUsageLogsSummary,
  type UsageLogFilters,
  type UsageLogSummary,
  type UsageLogsResult,
} from "@/repository/usage-logs";

/**
 * Usage logs summary 微缓存。
 *
 * 背景：findUsageLogsWithDetails 每次调用（包括每一次翻页）都会对
 * message_request 的整个过滤窗口重跑 count + 6×SUM 聚合。窗口默认收窄到
 * 7 天后单次成本已可控，但翻页仍然完全重复——这里按"规范化过滤器哈希
 * （不含 page/pageSize）"缓存 summary 60 秒，翻页立即变为只查行。
 *
 * 一致性取舍：60 秒内新请求不反映在 total/统计里（行列表本身永远实时）。
 * Fail-open：Redis 不可用 -> 直接查询。
 */
const USAGE_LOGS_SUMMARY_TTL = 60;
const KEY_PREFIX = "usage-logs:summary:v1";

// 参与 cache key 的过滤维度（刻意排除 page/pageSize）。
const KEYED_FILTER_FIELDS = [
  "userId",
  "keyId",
  "providerId",
  "sessionId",
  "startTime",
  "endTime",
  "allTime",
  "statusCode",
  "excludeStatusCode200",
  "model",
  "actualResponseModelMismatch",
  "endpoint",
  "minRetryCount",
] as const;

function buildSummaryCacheKey(filters: Omit<UsageLogFilters, "page" | "pageSize">): string {
  const normalized: Record<string, unknown> = {};
  for (const field of KEYED_FILTER_FIELDS) {
    const value = filters[field];
    if (value !== undefined) normalized[field] = value;
  }
  const stableJson = JSON.stringify(normalized, KEYED_FILTER_FIELDS.slice().sort() as string[]);
  const hash = createHash("sha256").update(stableJson).digest("hex").slice(0, 24);
  return `${KEY_PREFIX}:${hash}`;
}

function buildSummaryCacheKeyHash(filters: Omit<UsageLogFilters, "page" | "pageSize">): string {
  return buildSummaryCacheKey(filters).split(":").slice(-1)[0];
}

export async function getUsageLogsSummaryWithCache(
  filters: Omit<UsageLogFilters, "page" | "pageSize">
): Promise<Pick<UsageLogsResult, "total" | "summary">> {
  const redis = getRedisClient();
  if (!redis) {
    return await findUsageLogsSummary(filters);
  }

  const cacheKey = buildSummaryCacheKey(filters);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as Pick<UsageLogsResult, "total" | "summary">;
    }

    const data = await findUsageLogsSummary(filters);
    await redis
      .setex(cacheKey, USAGE_LOGS_SUMMARY_TTL, JSON.stringify(data))
      .catch((err: unknown) =>
        logger.warn("[UsageLogsSummaryCache] Failed to write cache", { cacheKey, error: err })
      );
    return data;
  } catch (error) {
    logger.warn("[UsageLogsSummaryCache] Redis error, fallback to direct query", {
      error: error instanceof Error ? error.message : String(error),
    });
    return await findUsageLogsSummary(filters);
  }
}

/**
 * 统计面板（getUsageLogsStats）的 60 秒微缓存。
 *
 * 面板常驻展开、页面打开即加载；主查询已是 index-only 后单次成本亚秒，
 * 这里把"换筛选条件来回看"和"短时间重开页面"也挡掉，且换页/刷新不再重跑。
 * 键与分页 summary 同维度（排除 page/pageSize）；fail-open。
 */
export async function getUsageLogsStatsWithCache(
  filters: Omit<UsageLogFilters, "page" | "pageSize">
): Promise<UsageLogSummary> {
  const redis = getRedisClient();
  if (!redis) {
    return await findUsageLogsStats(filters);
  }
  const cacheKey = `usage-logs:stats:v1:${buildSummaryCacheKeyHash(filters)}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    const data = await findUsageLogsStats(filters);
    await redis
      .setex(cacheKey, USAGE_LOGS_SUMMARY_TTL, JSON.stringify(data))
      .catch((err: unknown) =>
        logger.warn("[UsageLogsSummaryCache] Failed to write stats cache", { cacheKey, error: err })
      );
    return data;
  } catch (error) {
    logger.warn("[UsageLogsSummaryCache] Redis error on stats, fallback to direct query", {
      error: error instanceof Error ? error.message : String(error),
    });
    return await findUsageLogsStats(filters);
  }
}
