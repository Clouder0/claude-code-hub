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
  | "disabled"
  | "wrong_endpoint"
  | "intake_scan_rejected"
  | "input_not_array"
  | "fast_pass"
  | "fast_edited"
  | "degraded_for_attempt";

const routingReasonCounts = new Map<FastBodyRoutingReason, number>();
let lastAnomalyLogAt = 0;

function recordRoutingReason(reason: FastBodyRoutingReason): void {
  routingReasonCounts.set(reason, (routingReasonCounts.get(reason) ?? 0) + 1);
}

/** 观测快照（测试与运维日志用；不引入 metrics 依赖）。 */
export function getFastBodyPathStats(): ReadonlyMap<FastBodyRoutingReason, number> {
  return routingReasonCounts;
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
