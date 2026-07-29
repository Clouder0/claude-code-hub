import { logger } from "@/lib/logger";

// 单进程级 shutdown 状态：readiness 探针读取它在收到 SIGTERM 后立刻返回 503，
// 让 Service/Ingress 提前摘流，避免新连接打到正在 drain 的 pod 上。
let shuttingDown = false;

export function markShuttingDown(): void {
  if (!shuttingDown) {
    shuttingDown = true;
    logger.info("[Shutdown] marked as shutting down");
  }
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

// 仅供测试重置内部状态，正常代码路径不使用。
export function __resetShutdownStateForTests(): void {
  shuttingDown = false;
}

// 单步 timeout：超时 / 失败都不能让整个关闭流程被阻塞，因此 catch + 计时器双保险。
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(`[Shutdown] ${label} timed out`, { ms });
      resolve();
    }, ms);
  });
  try {
    await Promise.race([
      p.then(
        () => undefined,
        (error) => {
          logger.warn(`[Shutdown] ${label} failed`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_STEP_TIMEOUT_MS = 3000;
const DEFAULT_TOTAL_TIMEOUT_MS = 10000;

export interface RunCleanupOptions {
  totalTimeoutMs?: number;
  perStepTimeoutMs?: number;
}

// 串行执行每一步的资源回收。每步超时不阻塞后续步骤；整体超时是兜底保护。
export async function runApplicationCleanup(
  signal: string,
  opts: RunCleanupOptions = {}
): Promise<void> {
  const stepMs = opts.perStepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const totalMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  const startedAt = Date.now();
  logger.info("[Shutdown] application cleanup starting", { signal, totalMs, stepMs });

  const work = (async () => {
    // 1. 停止本地周期任务（不需要做 IO，几乎是同步）
    await withTimeout(
      (async () => {
        const { stopCacheCleanup } = await import("@/lib/cache/session-cache");
        stopCacheCleanup();
      })(),
      stepMs,
      "stopCacheCleanup"
    );

    // 2. 智能探测调度器。它也注册了信号监听器，但显式纳入统一生命周期，避免依赖
    // process listener 的注册顺序后仍在数据库关闭期间发起查询。
    await withTimeout(
      (async () => {
        const { stopProbeScheduler } = await import("@/lib/circuit-breaker-probe");
        stopProbeScheduler();
      })(),
      stepMs,
      "stopProbeScheduler"
    );

    // 3. 端点探测调度器
    await withTimeout(
      (async () => {
        const { stopEndpointProbeScheduler } = await import(
          "@/lib/provider-endpoints/probe-scheduler"
        );
        stopEndpointProbeScheduler();
      })(),
      stepMs,
      "stopEndpointProbeScheduler"
    );

    // 4. 公共状态重建调度器
    await withTimeout(
      (async () => {
        const { stopPublicStatusRebuildScheduler } = await import("@/lib/public-status/scheduler");
        await stopPublicStatusRebuildScheduler();
      })(),
      stepMs,
      "stopPublicStatusRebuildScheduler"
    );

    // 5. 端点探测日志清理
    await withTimeout(
      (async () => {
        const { stopEndpointProbeLogCleanup } = await import(
          "@/lib/provider-endpoints/probe-log-cleanup"
        );
        stopEndpointProbeLogCleanup();
      })(),
      stepMs,
      "stopEndpointProbeLogCleanup"
    );

    // 6. 关闭 Bull 后台队列，等待正在执行的 cleanup/notification job 离开数据库边界。
    await withTimeout(
      (async () => {
        const { stopCleanupQueue } = await import("@/lib/log-cleanup/cleanup-queue");
        await stopCleanupQueue();
      })(),
      stepMs,
      "stopCleanupQueue"
    );
    await withTimeout(
      (async () => {
        const { stopNotificationQueue } = await import("@/lib/notification/notification-queue");
        await stopNotificationQueue();
      })(),
      stepMs,
      "stopNotificationQueue"
    );

    // 7. 云价格定时同步必须在数据库关闭前停止。清除 interval 防止新一轮开始；若已有一轮
    // 正在查询，postgres.js end() 会等待该查询到达边界或在自己的 timeout 内结束。
    try {
      const g = globalThis as unknown as {
        __CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__?: ReturnType<typeof setInterval>;
      };
      if (g.__CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__) {
        clearInterval(g.__CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__);
        g.__CCH_CLOUD_PRICE_SYNC_INTERVAL_ID__ = undefined;
      }
    } catch (error) {
      logger.warn("[Shutdown] cloud price sync scheduler cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 8. 取消仍在飞的后台异步任务。
    //    必须排在 message-buffer flush 之前——任务被 abort 时仍会写出尾部日志/用量记录，
    //    flush 才能把这些尾部更新真正落库。
    await withTimeout(
      (async () => {
        const { shutdownAllAsyncTasks } = await import("@/lib/async-task-manager");
        shutdownAllAsyncTasks();
      })(),
      stepMs,
      "shutdownAllAsyncTasks"
    );

    // 9. 刷写 message_request 异步写缓冲
    await withTimeout(
      (async () => {
        const { stopMessageRequestWriteBuffer } = await import("@/repository/message-write-buffer");
        await stopMessageRequestWriteBuffer();
      })(),
      stepMs,
      "stopMessageRequestWriteBuffer"
    );

    // 10. Langfuse 自带超时（LANGFUSE_SHUTDOWN_TIMEOUT_MS），这里再加一层兜底
    await withTimeout(
      (async () => {
        const { shutdownLangfuse } = await import("@/lib/langfuse");
        await shutdownLangfuse();
      })(),
      stepMs,
      "shutdownLangfuse"
    );

    // 11. 所有数据库 producer 已停止并完成必要 flush，现在关闭进程级共享 pool。
    await withTimeout(
      (async () => {
        const { closeDatabase } = await import("@/drizzle/db");
        await closeDatabase();
      })(),
      stepMs,
      "closeDatabase"
    );

    // 12. API Key Vacuum Filter 先取消 Redis 订阅，再关闭 Redis client。
    try {
      const g = globalThis as unknown as {
        __CCH_API_KEY_VF_SYNC_CLEANUP__?: (() => void) | null;
      };
      g.__CCH_API_KEY_VF_SYNC_CLEANUP__?.();
    } catch (error) {
      logger.warn("[Shutdown] api-key vacuum filter cleanup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 13. Redis 连接最后关：上面的步骤可能仍在写日志/缓存
    await withTimeout(
      (async () => {
        const { closeRedis } = await import("@/lib/redis");
        await closeRedis();
      })(),
      stepMs,
      "closeRedis"
    );
  })();

  const total = new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      logger.warn("[Shutdown] application cleanup total timeout reached", { totalMs });
      resolve();
    }, totalMs);
    work.finally(() => clearTimeout(t));
  });

  await Promise.race([work, total]);

  logger.info("[Shutdown] application cleanup complete", {
    signal,
    elapsedMs: Date.now() - startedAt,
  });
}

interface LifecycleGlobals {
  markShuttingDown: () => void;
  isShuttingDown: () => boolean;
  runApplicationCleanup: (signal: string, opts?: RunCleanupOptions) => Promise<void>;
}

// 让 server.js（CommonJS 入口，无法直接 import TS 模块）通过 globalThis 调用关闭逻辑。
// 与本仓库其他桥接惯例一致：参见 src/app/v1/_lib/responses-ws/upstream-adapter.ts:332。
export function bindLifecycleGlobals(): void {
  const g = globalThis as unknown as { __CCH_LIFECYCLE__?: LifecycleGlobals };
  if (g.__CCH_LIFECYCLE__) return;
  g.__CCH_LIFECYCLE__ = {
    markShuttingDown,
    isShuttingDown,
    runApplicationCleanup,
  };
}
