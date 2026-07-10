import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasAdminAuthority: vi.fn(),
  findUsageLogsWithDetails: vi.fn(),
  findUsageLogsBatch: vi.fn(),
  findUsageLogsStats: vi.fn(),
  findUsageLogSessionIdSuggestions: vi.fn(),
  getUsedModels: vi.fn(),
  getUsedStatusCodes: vi.fn(),
  getUsedEndpoints: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
  hasAdminAuthority: mocks.hasAdminAuthority,
}));

vi.mock("@/repository/usage-logs", () => ({
  findUsageLogsWithDetails: mocks.findUsageLogsWithDetails,
  findUsageLogsBatch: mocks.findUsageLogsBatch,
  findUsageLogsStats: mocks.findUsageLogsStats,
  findUsageLogSessionIdSuggestions: mocks.findUsageLogSessionIdSuggestions,
  getUsedModels: mocks.getUsedModels,
  getUsedStatusCodes: mocks.getUsedStatusCodes,
  getUsedEndpoints: mocks.getUsedEndpoints,
}));

vi.mock("@/lib/redis/live-chain-store", () => ({
  readLiveChainBatch: vi.fn(async () => new Map()),
}));

describe("usage log effective authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasAdminAuthority.mockReturnValue(false);
    mocks.findUsageLogsWithDetails.mockResolvedValue({ logs: [], total: 0, summary: {} });
    mocks.findUsageLogsBatch.mockResolvedValue({ logs: [], nextCursor: null, hasMore: false });
    mocks.findUsageLogsStats.mockResolvedValue({ totalRequests: 0 });
    mocks.findUsageLogSessionIdSuggestions.mockResolvedValue([]);
    mocks.getUsedModels.mockImplementation(async (userId?: number) => [`model-${userId}`]);
    mocks.getUsedStatusCodes.mockImplementation(async (userId?: number) => [userId ?? 200]);
    mocks.getUsedEndpoints.mockImplementation(async (userId?: number) => [`/user/${userId}`]);
  });

  it("forces every normal Web query to the current user", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: 44, role: "admin" },
      key: { canLoginWebUi: true },
    });

    const actions = await import("@/actions/usage-logs");
    await actions.getUsageLogs({ page: 1, pageSize: 20 } as never);
    await actions.getUsageLogsBatch({ limit: 20 } as never);
    await actions.getUsageLogsStats({ model: "claude" } as never);
    await actions.getUsageLogSessionIdSuggestions({
      term: "session",
      userId: 999,
      keyId: 7,
    });

    expect(mocks.findUsageLogsWithDetails).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 44 })
    );
    expect(mocks.findUsageLogsBatch).toHaveBeenCalledWith(expect.objectContaining({ userId: 44 }));
    expect(mocks.findUsageLogsStats).toHaveBeenCalledWith(expect.objectContaining({ userId: 44 }));
    expect(mocks.findUsageLogSessionIdSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 44, keyId: 7 })
    );
  });

  it("scopes filter options per user without retaining an unbounded user cache", async () => {
    const actions = await import("@/actions/usage-logs");

    mocks.getSession.mockResolvedValue({
      user: { id: 51, role: "user" },
      key: { canLoginWebUi: true },
    });
    const first = await actions.getFilterOptions();
    const firstAgain = await actions.getFilterOptions();

    mocks.getSession.mockResolvedValue({
      user: { id: 52, role: "user" },
      key: { canLoginWebUi: true },
    });
    const second = await actions.getFilterOptions();

    expect(first).toMatchObject({ ok: true, data: { models: ["model-51"] } });
    expect(firstAgain).toMatchObject({ ok: true, data: { models: ["model-51"] } });
    expect(second).toMatchObject({ ok: true, data: { models: ["model-52"] } });
    expect(mocks.getUsedModels).toHaveBeenNthCalledWith(1, 51);
    expect(mocks.getUsedModels).toHaveBeenNthCalledWith(2, 51);
    expect(mocks.getUsedModels).toHaveBeenNthCalledWith(3, 52);
  });

  it("preserves global filters only for effective admins", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: 1, role: "admin" },
      key: { canLoginWebUi: true },
    });
    mocks.hasAdminAuthority.mockReturnValue(true);

    const actions = await import("@/actions/usage-logs");
    await actions.getUsageLogs({ userId: 99, page: 1 } as never);
    await actions.getModelList();

    expect(mocks.findUsageLogsWithDetails).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 99 })
    );
    expect(mocks.getUsedModels).toHaveBeenCalledWith(undefined);
  });
});
