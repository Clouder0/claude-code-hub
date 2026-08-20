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
  getGroupCostMultiplier: vi.fn(async () => 1.5),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

function createHaikuOnlyProvider(): Provider {
  return {
    id: 78,
    name: "zhipu_Haiku",
    isEnabled: true,
    providerType: "claude",
    groupTag: null,
    weight: 1,
    priority: 1,
    costMultiplier: 1,
    disableSessionReuse: false,
    allowedModels: ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
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

function createOpusProvider(): Provider {
  return {
    id: 94,
    name: "yescode_team",
    isEnabled: true,
    providerType: "claude",
    groupTag: null,
    weight: 1,
    priority: 0,
    costMultiplier: 1,
    allowedModels: null, // supports all claude models
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

function createCodexProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    ...createOpusProvider(),
    id: 1455,
    name: "pirelay",
    providerType: "codex",
    ...overrides,
  } as Provider;
}

function createAlphaSearchSession() {
  return {
    sessionId: "019b82ff-08ff-75a3-a203-7e10274fdbd8",
    authState: { key: { id: 7, providerGroup: null }, user: { providerGroup: null } },
    originalFormat: "response",
    userAgent: "codex-cli",
    getOriginalModel: () => null,
    setProvider: vi.fn(),
    addProviderToChain: vi.fn(),
    recordProviderSessionRef: vi.fn(),
    setGroupCostMultiplier: vi.fn(),
  } as any;
}

describe("findReusable - model mismatch clears stale binding", () => {
  test("should clear binding when bound provider disables session reuse", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(78);
    const provider = createHaikuOnlyProvider();
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce({
      ...provider,
      disableSessionReuse: true,
    } as Provider);

    const session = {
      sessionId: "sess_disable_reuse",
      shouldReuseProvider: () => true,
      getOriginalModel: () => "claude-haiku-4-5-20251001",
      authState: null,
      getCurrentModel: () => null,
    } as any;

    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toBeNull();
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).toHaveBeenCalledWith(
      "sess_disable_reuse"
    );
  });

  test("should clear stale binding when bound provider does not support requested model", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    // Session bound to haiku-only provider
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(78);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(createHaikuOnlyProvider());

    const session = {
      sessionId: "4c25cf92",
      shouldReuseProvider: () => true,
      getOriginalModel: () => "claude-opus-4-6",
      authState: null,
      getCurrentModel: () => null,
    } as any;

    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toBeNull();
    // Key assertion: clearSessionProvider should have been called
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).toHaveBeenCalledWith(
      "4c25cf92"
    );
  });

  test("should clear stale binding when bound provider type is incompatible with request format", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(94);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(createOpusProvider());

    const session = {
      sessionId: "sess_response_format_mismatch",
      shouldReuseProvider: () => true,
      originalFormat: "response",
      getOriginalModel: () => null,
      authState: null,
      getCurrentModel: () => null,
    } as any;

    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toBeNull();
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).toHaveBeenCalledWith(
      "sess_response_format_mismatch"
    );
  });

  test("should NOT clear binding when bound provider supports requested model", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    // Session bound to provider that supports all claude models
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(94);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(createOpusProvider());
    rateLimitMocks.RateLimitService.checkCostLimitsWithLease.mockResolvedValueOnce({
      allowed: true,
    });
    rateLimitMocks.RateLimitService.checkTotalCostLimit.mockResolvedValueOnce({
      allowed: true,
      current: 0,
    });

    const session = {
      sessionId: "sess_ok",
      shouldReuseProvider: () => true,
      getOriginalModel: () => "claude-opus-4-6",
      authState: null,
      getCurrentModel: () => null,
    } as any;

    const result = await (ProxyProviderResolver as any).findReusable(session);

    // Should return the provider (model matches)
    expect(result).not.toBeNull();
    expect(result?.id).toBe(94);
    // clearSessionProvider should NOT have been called
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
  });

  test("should NOT clear binding when shouldReuseProvider returns false", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    const session = {
      sessionId: "sess_short",
      shouldReuseProvider: () => false,
      getOriginalModel: () => "claude-opus-4-6",
      authState: null,
    } as any;

    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toBeNull();
    // Should not even reach the model check, so no clear
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
    expect(sessionManagerMocks.SessionManager.getSessionProvider).not.toHaveBeenCalled();
  });

  test("should clear binding for haiku-only provider when requesting haiku-4-5 variant not in allowlist", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");

    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(78);
    const provider = createHaikuOnlyProvider();
    // Restrictive allowlist - only allows specific variant
    provider.allowedModels = ["claude-haiku-4-5-20251001"];
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(provider);

    const session = {
      sessionId: "sess_variant",
      shouldReuseProvider: () => true,
      getOriginalModel: () => "claude-sonnet-4-5-20250929",
      authState: null,
      getCurrentModel: () => null,
    } as any;

    const result = await (ProxyProviderResolver as any).findReusable(session);

    expect(result).toBeNull();
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).toHaveBeenCalledWith(
      "sess_variant"
    );
  });
});

describe("alpha search sticky-only resolution", () => {
  test("missing binding fails without clearing or searching the provider pool", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const session = createAlphaSearchSession();

    const response = await (ProxyProviderResolver as any).ensureStickyOnly(session);

    expect(response.status).toBe(409);
    expect(sessionManagerMocks.SessionManager.getSessionProvider).toHaveBeenCalledWith(
      session.sessionId,
      7
    );
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
    expect(providerRepositoryMocks.findAllProviders).not.toHaveBeenCalled();
  });

  test("unavailable bound provider fails in place without mutating its binding", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const session = createAlphaSearchSession();
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(1455);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(
      createCodexProvider({ isEnabled: false })
    );

    const response = await (ProxyProviderResolver as any).ensureStickyOnly(session);

    expect(response.status).toBe(503);
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
    expect(providerRepositoryMocks.findAllProviders).not.toHaveBeenCalled();
    expect(session.setProvider).not.toHaveBeenCalled();
  });

  test("provider that disabled session reuse fails in place without mutating its binding", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const session = createAlphaSearchSession();
    const provider = createCodexProvider({ disableSessionReuse: true });
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(provider.id);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(provider);

    const response = await (ProxyProviderResolver as any).ensureStickyOnly(session);

    expect(response.status).toBe(503);
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
    expect(providerRepositoryMocks.findAllProviders).not.toHaveBeenCalled();
    expect(session.setProvider).not.toHaveBeenCalled();
  });

  test("selects the matching-key bound provider and retains normal limits", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const session = createAlphaSearchSession();
    const provider = createCodexProvider();
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(provider.id);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(provider);

    const response = await (ProxyProviderResolver as any).ensureStickyOnly(session);

    expect(response).toBeNull();
    expect(session.setProvider).toHaveBeenCalledWith(provider);
    expect(rateLimitMocks.RateLimitService.checkCostLimitsWithLease).toHaveBeenCalled();
    expect(rateLimitMocks.RateLimitService.checkTotalCostLimit).toHaveBeenCalled();
    expect(rateLimitMocks.RateLimitService.checkAndTrackProviderSession).toHaveBeenCalledWith(
      provider.id,
      session.sessionId,
      0
    );
    expect(session.recordProviderSessionRef).toHaveBeenCalledWith(provider.id);
    expect(session.setGroupCostMultiplier).toHaveBeenCalledWith(1.5);
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
    expect(providerRepositoryMocks.findAllProviders).not.toHaveBeenCalled();
  });

  test("bound provider concurrency rejection does not trigger migration", async () => {
    const { ProxyProviderResolver } = await import("@/app/v1/_lib/proxy/provider-selector");
    const session = createAlphaSearchSession();
    const provider = createCodexProvider();
    sessionManagerMocks.SessionManager.getSessionProvider.mockResolvedValueOnce(provider.id);
    providerRepositoryMocks.findProviderById.mockResolvedValueOnce(provider);
    rateLimitMocks.RateLimitService.checkAndTrackProviderSession.mockResolvedValueOnce({
      allowed: false,
      referenced: false,
    });

    const response = await (ProxyProviderResolver as any).ensureStickyOnly(session);

    expect(response.status).toBe(429);
    expect(session.setProvider).not.toHaveBeenCalled();
    expect(sessionManagerMocks.SessionManager.clearSessionProvider).not.toHaveBeenCalled();
    expect(providerRepositoryMocks.findAllProviders).not.toHaveBeenCalled();
  });
});
