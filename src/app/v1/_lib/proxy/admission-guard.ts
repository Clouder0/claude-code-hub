/**
 * 在途保留字节准入守卫(intake → 阶梯之前)。
 *
 * 与 auth-guard 同一模式:在 provider 选择之前拒绝,因此不占用 attempt、
 * 不触发电机断路器。只计量释放语义已验证的人群(session 的释放候选标记),
 * 保证计费人群与 releaseRequestBodyAfterCommit 的退费路径一一对应。
 * 水位满时返回 429 + Retry-After(客户端/codex CLI 自带退避重试,HAProxy
 * 会在 A/B 两侧间自然再均衡);水位未配置(禁用)时恒通过。
 */

import { getRequestAdmission, type RequestAdmission } from "@/lib/capacity/request-admission";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

const RETRY_AFTER_SECONDS = 3;

export function tryAcquireRequestWorkingSetOrRespond(
  session: ProxySession,
  admission: RequestAdmission = getRequestAdmission().admission
): Response | null {
  // 可选调用:部分调用方/测试桩以最小面构造 session——无候选标记支持即视为
  // 不在计量人群,直通(与禁用态同形)。
  if (session.isRequestBodyReleaseCandidate?.() !== true) {
    return null;
  }
  const bodyBytes = session.receivedBodyBytes ?? 0;
  const lease = admission.tryAcquire(bodyBytes);
  if (!lease) {
    // 禁用态由 admission 内部发放零计费租约,不会走到这里。
    return ProxyResponses.buildError(
      429,
      "Too many large requests in flight. Please retry shortly.",
      "rate_limit_error",
      undefined,
      undefined,
      { headers: { "Retry-After": String(RETRY_AFTER_SECONDS) } }
    );
  }
  session.attachWorkingSetLease?.(lease);
  return null;
}
