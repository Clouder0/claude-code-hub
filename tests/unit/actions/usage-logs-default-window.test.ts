import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 动作层默认窗口契约：startTime 缺省且未显式 allTime 时，getUsageLogs /
 * getUsageLogsStats / 导出必须收窄到最近 7 天；allTime=true 是唯一的
 * 绕过途径。这是对 API 直调方的行为承诺（UI 之外）。
 */

const mockGetSession = vi.hoisted(() => vi.fn());
const mockFindUsageLogsRows = vi.hoisted(() => vi.fn());
const mockFindUsageLogsStats = vi.hoisted(() => vi.fn());
const mockSummaryCache = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  hasAdminAuthority: () => true,
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("@/repository/usage-logs", () => ({
  findUsageLogsRows: mockFindUsageLogsRows,
  findUsageLogsStats: mockFindUsageLogsStats,
  findUsageLogsBatch: vi.fn(),
  findUsageLogSessionIdSuggestions: vi.fn(),
  getUsedEndpoints: vi.fn(),
  getUsedModels: vi.fn(),
  getUsedStatusCodes: vi.fn(),
}));

vi.mock("@/lib/redis/usage-logs-summary-cache", () => ({
  getUsageLogsSummaryWithCache: mockSummaryCache,
}));

vi.mock("@/lib/redis/live-chain-store", () => ({
  readLiveChainBatch: vi.fn(async () => []),
}));

const EMPTY_SUMMARY = {
  total: 0,
  summary: {
    totalRequests: 0,
    totalCost: 0,
    totalTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreation5mTokens: 0,
    totalCacheCreation1hTokens: 0,
  },
};

describe("usage logs default time window (action layer)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({ user: { id: 1, role: "admin" } });
    mockFindUsageLogsRows.mockResolvedValue({ logs: [] });
    mockFindUsageLogsStats.mockResolvedValue(EMPTY_SUMMARY.summary);
    mockSummaryCache.mockImplementation(async (filters: { startTime?: number }) => ({
      ...EMPTY_SUMMARY,
      total: filters.startTime ? 1 : 0,
    }));
  });

  it("getUsageLogs 在无 startTime 且无 allTime 时注入最近 7 天下界", async () => {
    const { getUsageLogs } = await import("@/actions/usage-logs");
    const before = Date.now();
    await getUsageLogs({});
    const after = Date.now();

    const rowsFilters = mockFindUsageLogsRows.mock.calls[0][0] as { startTime?: number };
    expect(rowsFilters.startTime).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(rowsFilters.startTime).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it("getUsageLogs 尊重显式 startTime 与 allTime", async () => {
    const { getUsageLogs } = await import("@/actions/usage-logs");

    await getUsageLogs({ startTime: 1000 });
    expect((mockFindUsageLogsRows.mock.calls[0][0] as { startTime?: number }).startTime).toBe(1000);

    await getUsageLogs({ allTime: true });
    expect(
      (mockFindUsageLogsRows.mock.calls[1][0] as { startTime?: number }).startTime
    ).toBeUndefined();
  });

  it("getUsageLogsStats 应用同一默认窗口，allTime 同样绕过", async () => {
    const { getUsageLogsStats } = await import("@/actions/usage-logs");
    const before = Date.now();
    await getUsageLogsStats({});
    const after = Date.now();

    const statsFilters = mockFindUsageLogsStats.mock.calls[0][0] as { startTime?: number };
    expect(statsFilters.startTime).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(statsFilters.startTime).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);

    await getUsageLogsStats({ allTime: true });
    expect(
      (mockFindUsageLogsStats.mock.calls[1][0] as { startTime?: number }).startTime
    ).toBeUndefined();
  });

  it("getUsageLogs 走缓存的 summary + 实时的行列表", async () => {
    const { getUsageLogs } = await import("@/actions/usage-logs");
    const result = await getUsageLogs({});

    expect(mockSummaryCache).toHaveBeenCalledTimes(1);
    expect(mockFindUsageLogsRows).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.total).toBe(1);
      expect(result.data.logs).toEqual([]);
    }
  });
});
