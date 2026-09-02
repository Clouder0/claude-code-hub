import { sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";
import { invalidateCachedUser } from "./api-key-auth-cache";
import { recordSecurityEventBestEffort } from "./security-event-recorder";
import { POLICY_REJECTION_CODES, type PolicyRejectionCode } from "./security-signals";

// 确认策略拒绝后的 session 封锁时长（cyber 与 bio 共用）
export const POLICY_SESSION_BLOCK_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
export const CYBER_INSTALLATION_FIRST_HIT_TTL_SECONDS = 5 * 60;

function sessionBlockKey(sessionId: string, policy: PolicyRejectionCode): string {
  // cyber_policy -> cyber_blocked：与已部署的 cyber 封锁键格式保持一致，
  // bio_policy -> bio_blocked。已存在的生产 Redis 键不受影响。
  const prefix = policy.replace(/_policy$/, "");
  return `session:${sessionId}:${prefix}_blocked`;
}

function scopedKey(scope: "principal" | "client_instance", principalId: string, subjectId: string) {
  return `cyber:${scope}:${encodeURIComponent(principalId)}:${encodeURIComponent(subjectId)}`;
}

function validClientInstanceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\r") &&
    !value.includes("\n") &&
    Buffer.byteLength(value) <= 256
  );
}

export async function blockCyberInstallation(
  principalId: string,
  clientInstanceId: string,
  permanent: boolean
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready" || !validClientInstanceId(clientInstanceId)) return;
  try {
    const key = scopedKey("client_instance", principalId, clientInstanceId);
    if (permanent) await redis.set(key, "1");
    else await redis.set(key, "1", "EX", CYBER_INSTALLATION_FIRST_HIT_TTL_SECONDS);
  } catch (error) {
    logger.error("[PolicyContainment] Failed to block Cyber installation", {
      principalId,
      clientInstanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function blockCyberPrincipal(principalId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;
  try {
    await redis.set(scopedKey("principal", principalId, principalId), "1");
  } catch (error) {
    logger.error("[PolicyContainment] Failed to block Cyber principal", {
      principalId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function releaseCyberInstallation(
  principalId: string,
  clientInstanceId: string
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready" || !validClientInstanceId(clientInstanceId)) return;
  await redis.del(scopedKey("client_instance", principalId, clientInstanceId));
}

export async function releaseCyberPrincipal(principalId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return;
  await redis.del(scopedKey("principal", principalId, principalId));
}

export async function releaseSessionPolicyBlock(
  sessionId: string,
  policy: PolicyRejectionCode
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") throw new Error("Policy execution index is unavailable");
  await redis.del(sessionBlockKey(sessionId, policy));
}

export async function setCyberPrincipalExecutionIndexStrict(
  principalId: string,
  restricted: boolean
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready")
    throw new Error("Principal execution index is unavailable");
  const key = scopedKey("principal", principalId, principalId);
  if (restricted) await redis.set(key, "1");
  else await redis.del(key);
}

export async function setCyberInstallationExecutionIndexStrict(
  principalId: string,
  clientInstanceId: string,
  restricted: boolean,
  expiresAtMs?: number
): Promise<void> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready" || !validClientInstanceId(clientInstanceId)) {
    throw new Error("Cyber installation execution index is unavailable");
  }
  const key = scopedKey("client_instance", principalId, clientInstanceId);
  if (!restricted) {
    await redis.del(key);
  } else if (expiresAtMs === undefined) {
    await redis.set(key, "1");
  } else {
    const remainingSeconds = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));
    await redis.set(key, "1", "EX", remainingSeconds);
  }
}

export async function findCyberScopeBlock(
  principalId: string,
  clientInstanceId?: string
): Promise<"principal" | "client_instance" | null> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") return null;
  const keys = [scopedKey("principal", principalId, principalId)];
  if (validClientInstanceId(clientInstanceId)) {
    keys.push(scopedKey("client_instance", principalId, clientInstanceId));
  }
  try {
    const values = await redis.mget(...keys);
    if (values[0] !== null) return "principal";
    if (values[1] !== null) return "client_instance";
  } catch (error) {
    logger.error("[PolicyContainment] Failed to read Cyber scope block", {
      principalId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
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
    if (policy === "bio_policy") {
      await redis.set(sessionBlockKey(sessionId, policy), "1");
    } else {
      await redis.set(
        sessionBlockKey(sessionId, policy),
        "1",
        "EX",
        Math.ceil(POLICY_SESSION_BLOCK_TTL_MS / 1000)
      );
    }
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
 * Confirmed upstream policy rejections are executable facts. Reviewer observe/shadow only controls
 * predictive admission; it must not disable the existing local session boundary. Automatic cyber
 * strike escalation remains owned by Cyber Check and is applied from its provider-event result.
 */
export async function containPolicyRejection(
  session: {
    sessionId: string | null;
    messageContext: { id: number; user: { id: number } } | null;
    request?: { message?: { client_metadata?: unknown } };
  },
  policy: PolicyRejectionCode
): Promise<void> {
  if (session.sessionId) {
    await blockSessionForPolicyRejection(session.sessionId, policy);
  }

  const userId = session.messageContext?.user?.id;
  const metadata = session.request?.message?.client_metadata;
  const candidate =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)["x-codex-installation-id"]
      : undefined;
  const clientInstanceId = validClientInstanceId(candidate) ? candidate : undefined;
  if (policy === "bio_policy" && userId !== undefined) {
    const principalId = String(userId);
    if (clientInstanceId) await blockCyberInstallation(principalId, clientInstanceId, true);
    await blockCyberPrincipal(principalId);
    await disableUserForCyberCheckContainment(userId);
  }

  await recordSecurityEventBestEffort(
    userId,
    session.messageContext?.id,
    policy,
    policy === "bio_policy" ? { clientInstanceId, centralStatus: "pending" } : undefined
  );
}
