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

/**
 * 写路径失效：单模型编辑精准失效；不传 modelName 时整表清空（云同步等
 * 批量写后使用）。审计"before"快照与计费读取共享本缓存，写后不失效会让
 * 60s 内的连续编辑读到上一次编辑前的旧值。
 */
export function invalidateLatestPriceCache(modelName?: string): void {
  if (modelName === undefined) {
    latestPriceCache.clear();
    return;
  }
  // 与 findLatestPriceByModel 的缓存键归一化保持一致
  latestPriceCache.delete(modelName.trim());
}
