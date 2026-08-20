import type { ModelPrice } from "@/types/model-price";

/**
 * findLatestPriceByModel 的进程内 TTL 缓存（非 "use server" 模块：重置钩子
 * 是同步导出，不能放进 server-actions 文件）。
 *
 * 该查询在每条流的计费结算时触发，原先每请求 1-2 次 SELECT。价格表变更
 * 频率极低（管理端/云同步），60s 陈旧窗口对成本计算可接受。命中与未命中
 * （null）都缓存——未命中缓存可避免无价格模型反复打库；查询异常不缓存
 * （瞬态故障不应固定结果）。
 */
const PRICE_CACHE_TTL_MS = 60_000;
const PRICE_CACHE_MAX_ENTRIES = 512;

const latestPriceCache = new Map<string, { value: ModelPrice | null; expiresAt: number }>();

export function getCachedLatestPrice(modelName: string): { value: ModelPrice | null } | null {
  const cached = latestPriceCache.get(modelName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }
  return null;
}

export function setCachedLatestPrice(modelName: string, value: ModelPrice | null): void {
  const now = Date.now();
  // Map 插入序作 LRU：重置位置并淘汰最旧条目
  latestPriceCache.delete(modelName);
  if (latestPriceCache.size >= PRICE_CACHE_MAX_ENTRIES) {
    const oldest = latestPriceCache.keys().next().value;
    if (oldest !== undefined) {
      latestPriceCache.delete(oldest);
    }
  }
  latestPriceCache.set(modelName, { value, expiresAt: now + PRICE_CACHE_TTL_MS });
}

export function resetModelPriceCacheForTests(): void {
  latestPriceCache.clear();
}
