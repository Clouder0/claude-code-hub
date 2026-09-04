import type { BodyScanResult } from "./body-scanner";

/**
 * codex /v1/responses 零变换快速路径：摄入谓词、路由计数与门面构造。
 *
 * 门面（facade）是快速路径的 request.message：受控标量 + thinking/metadata/
 * client_metadata 小对象 + `input: []` 门控标记。真实 input 长度经
 * getMessagesLength() 的显式分支取 scan.inputItemCount；需要完整树的消费者
 * 一律通过 rematerializeRequestMessageForRetry() 降解（既有 Layer-1 机制）。
 */

import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";

export type FastBodyRoutingReason =
  | "intake_fast"
  | "intake_stream_not_true"
  | "intake_input_not_array"
  | "intake_scan_rejected"
  | "fast_pass"
  | "fast_edited"
  /** 动态键：non_codex_provider:<type> / underscore_keys / may_mutate_other。 */
  | `degraded_for_attempt:${string}`;

const routingReasonCounts = new Map<string, number>();
let lastAnomalyLogAt = 0;
// 周期性 info 日志的采样间隔（每 N 次 attempt 合成输出一次累计快照）。
const ROUTING_STATS_LOG_INTERVAL = 32;
let routesSinceStatsLog = 0;

function recordRoutingReason(reason: string): void {
  routingReasonCounts.set(reason, (routingReasonCounts.get(reason) ?? 0) + 1);
}

/** 观测快照（测试与运维日志用；不引入 metrics 依赖）。 */
export function getFastBodyPathStats(): ReadonlyMap<string, number> {
  return routingReasonCounts;
}

/** 摄入结局计数（fast 人群内：fast / stream 非 true / input 非数组 / 扫描拒绝）。 */
export function noteFastBodyIntake(reason: FastBodyRoutingReason): void {
  recordRoutingReason(reason);
}

export function isFastBodyPathEnabled(): boolean {
  try {
    return getEnvConfig().CCH_CODEX_FAST_BODY_PATH === "on";
  } catch {
    return false;
  }
}

/** 扫描异常的采样告警：每请求 warn 会被病态流量放大，按分钟节流。 */
export function noteFastBodyAnomaly(anomaly: string | undefined, pathname: string): void {
  recordRoutingReason("intake_scan_rejected");
  const now = Date.now();
  if (now - lastAnomalyLogAt > 60_000) {
    lastAnomalyLogAt = now;
    logger.warn("[FastBodyPath] scan rejected, falling back to legacy parse", {
      anomaly,
      pathname,
    });
  }
}

export function noteFastBodyRouted(edited: boolean): void {
  recordRoutingReason(edited ? "fast_edited" : "fast_pass");
  routesSinceStatsLog += 1;
  if (routesSinceStatsLog >= ROUTING_STATS_LOG_INTERVAL) {
    routesSinceStatsLog = 0;
    logger.info("[FastBodyPath] routing stats", {
      stats: Object.fromEntries(routingReasonCounts),
    });
  }
}

/** 快速路径存活但本 attempt 降解；reason 给出精确成因。 */
export function noteFastBodyAttemptDegraded(reason: string): void {
  recordRoutingReason(`degraded_for_attempt:${reason}`);
}

/**
 * 由扫描结果构造门面。object/array 形状的受控标量不进门面（legacy 消费侧
 * 只认标量形状，非标量形状等价于字段缺失）。
 */
export function buildFastBodyFacadeMessage(scan: BodyScanResult): Record<string, unknown> {
  const facade: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(scan.fields)) {
    if (field.kind === "object" || field.kind === "array") continue;
    if (field.value !== undefined) facade[name] = field.value;
  }
  if (scan.thinkingValue) facade.thinking = scan.thinkingValue;
  if (scan.metadataValue) facade.metadata = scan.metadataValue;
  if (scan.clientMetadataValue) facade.client_metadata = scan.clientMetadataValue;
  // Array.isArray 门控标记（extractClientSessionId 的 codex 分支、completer 的
  // isCodexRequest 判定）。真实长度与内容由 scan 事实/通货字节承载。
  facade.input = [];
  return facade;
}
