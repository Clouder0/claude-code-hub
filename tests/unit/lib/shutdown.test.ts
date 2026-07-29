import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe.sequential("lifecycle/shutdown", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    delete (globalThis as unknown as { __CCH_LIFECYCLE__?: unknown }).__CCH_LIFECYCLE__;
    delete (globalThis as unknown as { __CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__?: unknown })
      .__CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__;
    delete (globalThis as unknown as { __CCH_API_KEY_VF_SYNC_CLEANUP__?: unknown })
      .__CCH_API_KEY_VF_SYNC_CLEANUP__;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("markShuttingDown flips isShuttingDown idempotently", async () => {
    const { markShuttingDown, isShuttingDown, __resetShutdownStateForTests } = await import(
      "@/lib/lifecycle/shutdown"
    );
    __resetShutdownStateForTests();

    expect(isShuttingDown()).toBe(false);
    markShuttingDown();
    expect(isShuttingDown()).toBe(true);
    markShuttingDown();
    expect(isShuttingDown()).toBe(true);
  });

  it("bindLifecycleGlobals attaches once and re-binding is a no-op", async () => {
    const { bindLifecycleGlobals } = await import("@/lib/lifecycle/shutdown");

    bindLifecycleGlobals();
    const first = (globalThis as unknown as { __CCH_LIFECYCLE__?: unknown }).__CCH_LIFECYCLE__;
    expect(first).toBeDefined();

    bindLifecycleGlobals();
    const second = (globalThis as unknown as { __CCH_LIFECYCLE__?: unknown }).__CCH_LIFECYCLE__;
    expect(second).toBe(first);
  });

  it("runApplicationCleanup invokes the staged modules and survives one step throwing", async () => {
    const calls: string[] = [];
    const stopCache = vi.fn();
    const stopSmartProbe = vi.fn();
    const stopProbe = vi.fn();
    const stopPublicStatus = vi.fn(async () => {});
    const stopProbeLog = vi.fn();
    const stopCleanupQueue = vi.fn(async () => {});
    const stopNotificationQueue = vi.fn(async () => {});
    const shutdownTasks = vi.fn(() => {
      throw new Error("simulated tasks shutdown failure");
    });
    const stopWriteBuffer = vi.fn(async () => {
      calls.push("write-buffer");
    });
    const shutdownLf = vi.fn(async () => {});
    const closeDatabase = vi.fn(async () => {
      calls.push("database");
    });
    const closeRedis = vi.fn(async () => {
      calls.push("redis");
    });

    vi.doMock("@/lib/cache/session-cache", () => ({ stopCacheCleanup: stopCache }));
    vi.doMock("@/lib/circuit-breaker-probe", () => ({ stopProbeScheduler: stopSmartProbe }));
    vi.doMock("@/lib/provider-endpoints/probe-scheduler", () => ({
      stopEndpointProbeScheduler: stopProbe,
    }));
    vi.doMock("@/lib/public-status/scheduler", () => ({
      stopPublicStatusRebuildScheduler: stopPublicStatus,
    }));
    vi.doMock("@/lib/provider-endpoints/probe-log-cleanup", () => ({
      stopEndpointProbeLogCleanup: stopProbeLog,
    }));
    vi.doMock("@/lib/log-cleanup/cleanup-queue", () => ({ stopCleanupQueue }));
    vi.doMock("@/lib/notification/notification-queue", () => ({ stopNotificationQueue }));
    vi.doMock("@/lib/async-task-manager", () => ({ shutdownAllAsyncTasks: shutdownTasks }));
    vi.doMock("@/repository/message-write-buffer", () => ({
      stopMessageRequestWriteBuffer: stopWriteBuffer,
    }));
    vi.doMock("@/lib/langfuse", () => ({ shutdownLangfuse: shutdownLf }));
    vi.doMock("@/drizzle/db", () => ({ closeDatabase }));
    vi.doMock("@/lib/redis", () => ({ closeRedis }));

    const cleanupSpy = vi.fn();
    (
      globalThis as unknown as { __CCH_API_KEY_VF_SYNC_CLEANUP__?: () => void }
    ).__CCH_API_KEY_VF_SYNC_CLEANUP__ = cleanupSpy;

    const intervalId = setInterval(() => {}, 60_000);
    (
      globalThis as unknown as {
        __CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__?: ReturnType<typeof setInterval>;
      }
    ).__CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__ = intervalId;
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const { runApplicationCleanup } = await import("@/lib/lifecycle/shutdown");

    await runApplicationCleanup("SIGTERM", { totalTimeoutMs: 5_000, perStepTimeoutMs: 500 });

    expect(stopCache).toHaveBeenCalled();
    expect(stopSmartProbe).toHaveBeenCalled();
    expect(stopProbe).toHaveBeenCalled();
    expect(stopPublicStatus).toHaveBeenCalled();
    expect(stopProbeLog).toHaveBeenCalled();
    expect(stopCleanupQueue).toHaveBeenCalled();
    expect(stopNotificationQueue).toHaveBeenCalled();
    expect(shutdownTasks).toHaveBeenCalled();
    expect(stopWriteBuffer).toHaveBeenCalled();
    expect(shutdownLf).toHaveBeenCalled();
    expect(closeDatabase).toHaveBeenCalled();
    expect(closeRedis).toHaveBeenCalled();
    expect(cleanupSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
    expect(calls).toEqual(["write-buffer", "database", "redis"]);
  });

  it("runApplicationCleanup returns within totalTimeoutMs even if one step hangs", async () => {
    let releaseHang: () => void = () => {};
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    vi.doMock("@/lib/cache/session-cache", () => ({ stopCacheCleanup: () => {} }));
    vi.doMock("@/lib/circuit-breaker-probe", () => ({ stopProbeScheduler: () => {} }));
    vi.doMock("@/lib/provider-endpoints/probe-scheduler", () => ({
      stopEndpointProbeScheduler: () => {},
    }));
    vi.doMock("@/lib/public-status/scheduler", () => ({
      stopPublicStatusRebuildScheduler: async () => {},
    }));
    vi.doMock("@/lib/provider-endpoints/probe-log-cleanup", () => ({
      stopEndpointProbeLogCleanup: () => {},
    }));
    vi.doMock("@/lib/log-cleanup/cleanup-queue", () => ({ stopCleanupQueue: async () => {} }));
    vi.doMock("@/lib/notification/notification-queue", () => ({
      stopNotificationQueue: async () => {},
    }));
    vi.doMock("@/lib/async-task-manager", () => ({ shutdownAllAsyncTasks: () => {} }));
    vi.doMock("@/repository/message-write-buffer", () => ({
      stopMessageRequestWriteBuffer: async () => {},
    }));
    // The hanging step
    vi.doMock("@/lib/langfuse", () => ({ shutdownLangfuse: async () => hang }));
    vi.doMock("@/drizzle/db", () => ({ closeDatabase: async () => {} }));
    vi.doMock("@/lib/redis", () => ({ closeRedis: async () => {} }));

    const { runApplicationCleanup } = await import("@/lib/lifecycle/shutdown");
    const started = Date.now();
    await runApplicationCleanup("SIGTERM", { totalTimeoutMs: 300, perStepTimeoutMs: 100 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    releaseHang();
  });
});
