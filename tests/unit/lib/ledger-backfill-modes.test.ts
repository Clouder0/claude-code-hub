import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/drizzle/db", () => ({
  db: { transaction: mocks.transaction },
}));

import { backfillUsageLedger } from "@/lib/ledger-backfill/service";

function batchRow(overrides: Record<string, number> = {}) {
  return [{ processed: 0, inserted: 0, updated: 0, max_id: 0, ...overrides }];
}

// execute 调用序列的第 1 个总是 advisory lock 查询。
function lockGranted() {
  return [{ acquired: true }];
}

/**
 * 模式形状契约（2026-08-20 回填改造）：
 * - sync（启动默认）：锁之后先取 max(request_id) 水位锚点；批次 SQL 只含缺失行
 *   anti-join，不出现语义比较条件（那些条件曾让每次启动对全表逐行求值
 *   PL/pgSQL 函数）。
 * - repair（显式）：批次 SQL 保留完整语义重导条件，且必须直接调 fn_compute
 *   （mr.success_rate_outcome 列可能存着旧语义的值）。
 */
describe("backfillUsageLedger modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: mocks.execute })
    );
  });

  it("sync mode anchors at max ledger request_id and uses anti-join only", async () => {
    mocks.execute
      .mockResolvedValueOnce(lockGranted())
      .mockResolvedValueOnce([{ max_request_id: 500 }]) // 水位锚点
      .mockResolvedValueOnce(batchRow()); // processed=0 → 结束

    const summary = await backfillUsageLedger({ mode: "sync" });

    expect(summary.totalProcessed).toBe(0);
    expect(mocks.execute).toHaveBeenCalledTimes(3);

    const anchorSql = JSON.stringify(mocks.execute.mock.calls[1][0]);
    expect(anchorSql).toContain("MAX(request_id)");

    const batchSql = JSON.stringify(mocks.execute.mock.calls[2][0]);
    expect(batchSql).toContain("ul.request_id IS NULL");
    // 语义比较条件不得出现（warmup 过滤的 IS DISTINCT FROM 'warmup' 不算）
    expect(batchSql).not.toContain("ul.final_provider_id IS DISTINCT FROM");
    expect(batchSql).not.toContain("ul.is_success IS DISTINCT FROM");
    expect(batchSql).not.toContain("ul.success_rate_outcome IS NULL");
    // sync 模式允许复用触发器维护的 outcome 列
    expect(batchSql).toContain("COALESCE");
    expect(batchSql).toContain("mr.success_rate_outcome");
  });

  it("repair mode keeps full semantic re-derivation conditions and no anchor", async () => {
    mocks.execute.mockResolvedValueOnce(lockGranted()).mockResolvedValueOnce(batchRow());

    const summary = await backfillUsageLedger({ mode: "repair" });

    expect(summary.totalProcessed).toBe(0);
    expect(mocks.execute).toHaveBeenCalledTimes(2);

    const batchSql = JSON.stringify(mocks.execute.mock.calls[1][0]);
    expect(batchSql).toContain("IS DISTINCT FROM");
    expect(batchSql).toContain("resolved.final_provider_id");
    // repair 必须直接调函数，不走 COALESCE 列捷径
    expect(batchSql).not.toContain("mr.success_rate_outcome,");
    expect(batchSql).toContain("fn_compute_message_request_success_rate_outcome");
    expect(batchSql).not.toContain("MAX(request_id)");
  });

  it("sync mode batches until processed=0 and reports totals", async () => {
    mocks.execute
      .mockResolvedValueOnce(lockGranted())
      .mockResolvedValueOnce([{ max_request_id: 100 }])
      .mockResolvedValueOnce(batchRow({ processed: 3, inserted: 2, updated: 1, max_id: 150 }))
      .mockResolvedValueOnce(batchRow());

    const summary = await backfillUsageLedger({ mode: "sync" });

    expect(summary.totalProcessed).toBe(3);
    expect(summary.totalInserted).toBe(2);
    expect(summary.alreadyExisted).toBe(1);
    expect(mocks.execute).toHaveBeenCalledTimes(4);
  });

  it("does not run batches when the advisory lock is held elsewhere", async () => {
    mocks.execute.mockResolvedValueOnce([{ acquired: false }]);

    const summary = await backfillUsageLedger({ mode: "sync" });

    expect(summary.totalProcessed).toBe(0);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
