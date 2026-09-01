import { sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";
import { invalidateCachedUser } from "./api-key-auth-cache";
import { recordSecurityEventBestEffort } from "./security-event-recorder";
import { POLICY_REJECTION_CODES, type PolicyRejectionCode } from "./security-signals";

// 确认策略拒绝后的 session 封锁时长（cyber 与 bio 共用）
export const POLICY_SESSION_BLOCK_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

function sessionBlockKey(sessionId: string, policy: PolicyRejectionCode): string {
  // cyber_policy -> cyber_blocked：与已部署的 cyber 封锁键格式保持一致，
  // bio_policy -> bio_blocked。已存在的生产 Redis 键不受影响。
  const prefix = policy.replace(/_policy$/, "");
  return `session:${sessionId}:${prefix}_blocked`;
}

/**
 * 封锁 session：后续携带该 sessionId 的请求在选供应商之前被拒绝。
 * 这是拒绝边界，不是亲和性变更——session-provider 绑定保持不变，
 * 避免封锁导致滥用扩散到其他供应商。
 */
export async function blockSessionForPolicyRejection(
  sessionId: string,
  policy: PolicyRejectionCode
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;

  try {
    await redis.set(
      sessionBlockKey(sessionId, policy),
      "1",
      "EX",
      Math.ceil(POLICY_SESSION_BLOCK_TTL_MS / 1000)
    );
    logger.warn("[PolicyContainment] Session blocked after policy rejection", {
      sessionId,
      policy,
    });
  } catch (error) {
    logger.error("[PolicyContainment] Failed to block session", {
      sessionId,
      policy,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 返回 session 当前命中的策略封锁码；无封锁返回 null。
 * 单次 MGET 取回全部封锁键——常见路径（未封锁的绝大多数流量）只付一次
 * Redis 往返，不随策略数量增长。结果顺序跟随 POLICY_REJECTION_CODES
 * （cyber 优先）：两个封锁键同时存在时按 cyber 拒绝，与既有 cyber 行为一致。
 */
export async function findSessionBlockPolicy(
  sessionId: string
): Promise<PolicyRejectionCode | null> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return null;

  try {
    const values = await redis.mget(
      ...POLICY_REJECTION_CODES.map((policy) => sessionBlockKey(sessionId, policy))
    );
    for (let index = 0; index < POLICY_REJECTION_CODES.length; index += 1) {
      if (values[index] !== null) {
        return POLICY_REJECTION_CODES[index];
      }
    }
    return null;
  } catch (error) {
    logger.error("[PolicyContainment] Failed to read session block", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Applies Cyber Check's authoritative principal restriction to the CCH user row. */
export async function disableUserForCyberCheckContainment(userId: number): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      UPDATE users
      SET is_enabled = false, updated_at = now()
      WHERE id = ${userId} AND is_enabled = true AND deleted_at IS NULL
      RETURNING id
    `);
    const disabled = Array.from(result).length > 0;
    if (disabled) {
      await invalidateCachedUser(userId);
      logger.warn("[CyberContainment] User disabled by Cyber Check principal restriction", {
        userId,
      });
    }
    return disabled;
  } catch (error) {
    logger.error("[CyberContainment] Failed to apply Cyber Check principal restriction", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * CCH keeps its existing security event as audit only. Bio containment remains local. Cyber
 * containment is local only while the integration is off; in shadow it must not create a future
 * block, and in enforce the central provider-event result owns every cyber restriction and strike.
 */
export async function containPolicyRejection(
  session: {
    sessionId: string | null;
    messageContext: { id: number; user: { id: number } } | null;
  },
  policy: PolicyRejectionCode
): Promise<void> {
  const cyberCheckMode = getEnvConfig().CYBER_CHECK_MODE;
  const shouldBlockSession =
    policy === "bio_policy" || (policy === "cyber_policy" && cyberCheckMode === "off");
  if (shouldBlockSession && session.sessionId) {
    await blockSessionForPolicyRejection(session.sessionId, policy);
  }

  await recordSecurityEventBestEffort(
    session.messageContext?.user?.id,
    session.messageContext?.id,
    policy
  );
}
