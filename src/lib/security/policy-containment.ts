import { sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";
import { invalidateCachedUser } from "./api-key-auth-cache";
import { recordSecurityEventBestEffort } from "./security-event-recorder";
import { POLICY_REJECTION_CODES, type PolicyRejectionCode } from "./security-signals";

// 确认策略拒绝后的 session 封锁时长（cyber 与 bio 共用）
export const POLICY_SESSION_BLOCK_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

// 罢工禁用仅适用于 cyber_policy：30 天内确认达到该次数即禁用用户。
// bio_policy 只封锁与记录，不参与罢工计数（2026-08-21 决策：bio 误伤画像不同，惩罚须证据驱动）。
const STRIKE_ELIGIBLE: ReadonlySet<PolicyRejectionCode> = new Set(["cyber_policy"]);
export const CYBER_POLICY_DISABLE_THRESHOLD = 2;
export const CYBER_POLICY_STRIKE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

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

/**
 * 达到阈值时禁用用户（幂等）。计数包含刚插入的当前事件；
 * 单条 UPDATE 内完成计数与禁用，避免并发事件下的竞态放大。
 * 返回是否执行了禁用。
 */
export async function maybeDisableUserForCyberPolicy(userId: number): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      UPDATE users
      SET is_enabled = false, updated_at = now()
      WHERE id = ${userId}
        AND is_enabled = true
        AND (
          SELECT count(*)
          FROM security_event
          WHERE user_id = ${userId}
            AND type = 'cyber_policy'
            AND created_at >= now() - make_interval(secs => ${CYBER_POLICY_STRIKE_WINDOW_MS / 1000})
            AND created_at > coalesce(
              (SELECT cyber_policy_reset_at FROM users WHERE id = ${userId}),
              '-infinity'::timestamptz
            )
        ) >= ${CYBER_POLICY_DISABLE_THRESHOLD}
      RETURNING id
    `);
    const disabled = Array.from(result).length > 0;
    if (disabled) {
      // 清除 API key 鉴权缓存里的用户快照，否则禁用会延迟到缓存 TTL 才生效
      // （生产 TTL 60s，期间该用户仍能通过鉴权继续打上游）。
      await invalidateCachedUser(userId);
      logger.warn("[CyberContainment] User auto-disabled after cyber policy strikes", {
        userId,
        threshold: CYBER_POLICY_DISABLE_THRESHOLD,
      });
    }
    return disabled;
  } catch (error) {
    logger.error("[CyberContainment] Failed to evaluate user disable", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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
 * 确认策略拒绝后的完整遏制：封锁 session（最快、最关键）→ 记录事件（尽力而为）→
 * 按策略评估罢工禁用（仅 cyber）。
 * 事件持久化失败不影响封锁与禁用；任何一步失败都只记录日志，不改变代理控制流。
 */
export async function containPolicyRejection(
  session: {
    sessionId: string | null;
    messageContext: { id: number; user: { id: number } } | null;
  },
  policy: PolicyRejectionCode
): Promise<void> {
  if (session.sessionId) {
    await blockSessionForPolicyRejection(session.sessionId, policy);
  }

  await recordSecurityEventBestEffort(
    session.messageContext?.user?.id,
    session.messageContext?.id,
    policy
  );

  const userId = session.messageContext?.user?.id;
  if (STRIKE_ELIGIBLE.has(policy) && userId != null) {
    await maybeDisableUserForCyberPolicy(userId);
  }
}
