import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@/types/provider";

const circuitBreakerMocks = vi.hoisted(() => ({
  isCircuitOpen: vi.fn(async () => false),
  getCircuitState: vi.fn(() => "closed"),
}));

vi.mock("@/lib/circuit-breaker", () => circuitBreakerMocks);

const vendorTypeCircuitMocks = vi.hoisted(() => ({
  isVendorTypeCircuitOpen: vi.fn(async () => false),
}));

vi.mock("@/lib/vendor-type-circuit-breaker", () => vendorTypeCircuitMocks);

const sessionManagerMocks = vi.hoisted(() => ({
  SessionManager: {
    getSessionProvider: vi.fn(async () => null as number | null),
    clearSessionProvider: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/session-manager", () => sessionManagerMocks);

const providerRepositoryMocks = vi.hoisted(() => ({
  findProviderById: vi.fn(async () => null as Provider | null),
  findAllProviders: vi.fn(async () => [] as Provider[]),
}));

vi.mock("@/repository/provider", () => providerRepositoryMocks);

const rateLimitMocks = vi.hoisted(() => ({
  RateLimitService: {
    checkCostLimitsWithLease: vi.fn(async () => ({ allowed: true })),
    checkTotalCostLimit: vi.fn(async () => ({ allowed: true, current: 0 })),
    checkAndTrackProviderSession: vi.fn(async () => ({ allowed: true, referenced: true })),
  },
}));

vi.mock("@/lib/rate-limit", () => rateLimitMocks);

vi.mock("@/repository/provider-groups", () => ({
  getGroupCostMultiplier: vi.fn(async () => 1),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

function createBoundProvider(): Provider {
  return {
    id: 1455,
    name: "codex-upstream",
    isEnabled: true,
    providerType: "codex",
    groupTag: null,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    disableSessionReuse: false,
    allowedModels: null,
    providerVendorId: null,
    limit5hUsd: null,
    limitDailyUsd: null,
    dailyResetMode: "fixed",
    dailyResetTime: "00:00",
    limitWeeklyUsd: null,
    limitMonthlyUsd: null,
    limitTotalUsd: null,
    totalCostResetAt: null,
    limitConcurrentSessions: 0,
  } as unknown as Provider;
}

function createReusingSession(snapshot: Provider[] | null) {
  return {
    sessionId: "sess_snapshot_reuse",
    shouldReuseProvider: () => true,
    getOriginalModel: () => null,
    authState: null,
    getCurrentModel: () => null,
    setProvider: vi.fn(),
    addProviderToChain: vi.fn(),
    recordProviderSessionRef: vi.fn(),
    setGroupCostMultiplier: vi.fn(),
    ...(snapshot !== null ? { getProvidersSnapshot: vi.fn(async () => snapshot) } : {}),
  } as any;
}

describe("findReusable - snapshot-first provider resolution", () => {
  test("resolves the bound provider from the in-process snapshot without a DB query", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    const provider = createBoundProvider();
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(provider.id);

    const session = createReusingSession([provider]);
    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toMatchObject({ id: provider.id });
    expect(providerRepositoryMocks.findProviderById).not.toHaveBeenCalled();
    expect(session.getProvidersSnapshot).toHaveBeenCalled();
  });

  test("falls back to findProviderById when the snapshot misses", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    const provider = createBoundProvider();
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(provider.id);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(provider);

    // 快照为空（新建供应商遇上 30s 缓存窗口）
    const session = createReusingSession([]);
    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toMatchObject({ id: provider.id });
    expect(providerRepositoryMocks.findProviderById).toHaveBeenCalledWith(provider.id);
  });

  test("session doubles without getProvidersSnapshot keep the legacy direct query", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    const provider = createBoundProvider();
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(provider.id);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(provider);

    const session = createReusingSession(null);
    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toMatchObject({ id: provider.id });
    expect(providerRepositoryMocks.findProviderById).toHaveBeenCalledWith(provider.id);
  });
});
