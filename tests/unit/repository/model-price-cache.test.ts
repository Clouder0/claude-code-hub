import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
  const state = { queryCount: 0 };
  return {
    state,
    db: {
      select: () => {
        state.queryCount += 1;
        return {
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [],
              }),
            }),
          }),
        };
      },
      execute: async () => {
        state.queryCount += 1;
        return [];
      },
    },
  };
});

vi.mock("@/drizzle/db", () => ({ db: dbMocks.db }));

import { findLatestPriceByModel } from "@/repository/model-price";
import {
  invalidateLatestPriceCache,
  resetModelPriceCacheForTests,
} from "@/repository/_shared/model-price-cache";

describe("findLatestPriceByModel in-process TTL cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dbMocks.state.queryCount = 0;
    resetModelPriceCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("same model hits the database only once within the TTL window", async () => {
    await findLatestPriceByModel("gpt-5.6-sol");
    await findLatestPriceByModel("gpt-5.6-sol");
    await findLatestPriceByModel("gpt-5.6-sol");

    // 未命中精确名会继续走回退查询，但同一模型三次调用只应产生一轮查询
    expect(dbMocks.state.queryCount).toBe(2);
  });

  test("cache expires after the TTL window", async () => {
    await findLatestPriceByModel("gpt-5.6-sol");
    vi.advanceTimersByTime(61_000);
    await findLatestPriceByModel("gpt-5.6-sol");

    expect(dbMocks.state.queryCount).toBe(4);
  });

  test("different models are cached independently", async () => {
    await findLatestPriceByModel("gpt-5.6-sol");
    await findLatestPriceByModel("gpt-5.6-terra");
    await findLatestPriceByModel("gpt-5.6-sol");

    expect(dbMocks.state.queryCount).toBe(4);
  });
});

describe("invalidateLatestPriceCache write invalidation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dbMocks.state.queryCount = 0;
    resetModelPriceCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("invalidating a model forces a fresh query for it only", async () => {
    await findLatestPriceByModel("gpt-5.6-sol");
    await findLatestPriceByModel("gpt-5.6-terra");
    expect(dbMocks.state.queryCount).toBe(4);

    invalidateLatestPriceCache("gpt-5.6-sol");
    await findLatestPriceByModel("gpt-5.6-sol");
    // sol 重新查询，terra 仍走缓存
    expect(dbMocks.state.queryCount).toBe(6);

    await findLatestPriceByModel("gpt-5.6-terra");
    expect(dbMocks.state.queryCount).toBe(6);
  });

  test("invalidating without a model clears everything (bulk sync path)", async () => {
    await findLatestPriceByModel("gpt-5.6-sol");
    await findLatestPriceByModel("gpt-5.6-terra");
    expect(dbMocks.state.queryCount).toBe(4);

    invalidateLatestPriceCache();
    await findLatestPriceByModel("gpt-5.6-sol");
    await findLatestPriceByModel("gpt-5.6-terra");
    expect(dbMocks.state.queryCount).toBe(8);
  });
});
