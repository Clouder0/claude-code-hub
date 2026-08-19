import { sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";
import { invalidateCachedUser } from "./api-key-auth-cache";
import { recordSecurityEventBestEffort } from "./security-event-recorder";

// 确认 cyber_policy 后的 session 封锁时长
export const CYBER_SESSION_BLOCK_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

// 自动禁用阈值：30 天内确认 cyber_policy 达到该次数即禁用用户
export const CYBER_POLICY_DISABLE_THRESHOLD = 2;
export const CYBER_POLICY_STRIKE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function sessionBlockKey(sessionId: string): string {
  return `session:${sessionId}:cyber_blocked`;
}

/**
 * 封锁 session：后续携带该 sessionId 的请求在选供应商之前被拒绝。
 * 这是拒绝边界，不是亲和性变更——session-provider 绑定保持不变，
 * 避免封锁导致滥用扩散到其他供应商。
 */
export async function blockSessionForCyberPolicy(sessionId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;

  try {
    await redis.set(
      sessionBlockKey(sessionId),
      "1",
      "EX",
      Math.ceil(CYBER_SESSION_BLOCK_TTL_MS / 1000)
    );
    logger.warn("[CyberContainment] Session blocked after cyber policy", { sessionId });
  } catch (error) {
    logger.error("[CyberContainment] Failed to block session", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function isSessionCyberBlocked(sessionId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return false;

  try {
    return (await redis.get(sessionBlockKey(sessionId))) !== null;
  } catch (error) {
    logger.error("[CyberContainment] Failed to read session block", {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
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

/**
 * 确认 cyber_policy 后的完整遏制：封锁 session（最快、最关键）→ 记录事件（尽力而为）→ 达到阈值则禁用用户。
 * 事件持久化失败不影响封锁与禁用；任何一步失败都只记录日志，不改变代理控制流。
 */
export async function containCyberPolicy(session: {
  sessionId: string | null;
  messageContext: { id: number; user: { id: number } } | null;
}): Promise<void> {
  if (session.sessionId) {
    await blockSessionForCyberPolicy(session.sessionId);
  }

  await recordSecurityEventBestEffort(
    session.messageContext?.user?.id,
    session.messageContext?.id,
    "cyber_policy"
  );

  const userId = session.messageContext?.user?.id;
  if (userId != null) {
    await maybeDisableUserForCyberPolicy(userId);
  }
}
