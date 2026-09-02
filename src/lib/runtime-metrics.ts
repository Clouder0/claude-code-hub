/**
 * 进程级运行时指标:周期性记录 Node 内存形态与在途准入计量。
 *
 * 背景:2026-09-02/03 的 memcg OOM 风暴归因(见 cops 仓
 * notes/2026-09-03-cch-post-fix-oom-root-cause-investigation.md)依赖事后
 * 推理——进程内没有 heap/external 拆分,也没有在途保留字节的实时读数。
 * 此循环把 `process.memoryUsage()` 与 `requestAdmission.snapshot()` 每
 * 30s 落一条结构化日志,让"水位标定、k 系数校准、修复效果对照"都变成
 * 生产可观测事实。
 */

import { getRequestAdmission } from "@/lib/capacity/request-admission";
import { logger } from "@/lib/logger";

const DEFAULT_INTERVAL_MS = 30_000;

const metricsState = globalThis as unknown as {
  __CCH_RUNTIME_METRICS_STARTED__?: boolean;
};

export function startRuntimeMetrics(): void {
  if (metricsState.__CCH_RUNTIME_METRICS_STARTED__) return;
  metricsState.__CCH_RUNTIME_METRICS_STARTED__ = true;

  const rawInterval = Number.parseInt(process.env.CCH_RUNTIME_METRICS_INTERVAL_MS ?? "", 10);
  const intervalMs =
    Number.isSafeInteger(rawInterval) && rawInterval >= 1000 ? rawInterval : DEFAULT_INTERVAL_MS;

  const tick = () => {
    const memory = process.memoryUsage();
    const admission = getRequestAdmission().admission.snapshot();
    logger.info("Runtime metrics snapshot", {
      event: "runtime_metrics",
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      admission,
    });
  };

  const timer = setInterval(tick, intervalMs);
  // 不阻止进程正常退出(仅观测,无清理语义)。
  timer.unref?.();
  tick();
}
