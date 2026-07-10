import "server-only";

import type Redis from "ioredis";
import { getEnvConfig } from "@/lib/config/env.schema";
import { logger } from "@/lib/logger";
import { getRedisClient } from "@/lib/redis";
import {
  DEFAULT_AUTH_SESSION_TTL_SECONDS,
  DEFAULT_SESSION_TTL,
  type SessionData,
  type SessionStore,
} from "./index";

const SESSION_KEY_PREFIX = "cch:session:";
const MIN_TTL_SECONDS = 1;
const DEFAULT_REDIS_READY_WAIT_MS = 1_500;

type RedisSessionClient = Pick<Redis, "status" | "setex" | "get" | "del" | "on" | "off">;

export interface RedisSessionStoreOptions {
  defaultTtlSeconds?: number;
  redisClient?: RedisSessionClient | null;
  redisReadyWaitMs?: number;
}

function toLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTtlSeconds(value: number | undefined): number {
  if (!Number.isFinite(value) || typeof value !== "number" || value <= 0) {
    return DEFAULT_SESSION_TTL;
  }

  return Math.max(MIN_TTL_SECONDS, Math.floor(value));
}

function resolveDefaultAuthSessionTtlSeconds(): number {
  try {
    return normalizeTtlSeconds(getEnvConfig().AUTH_SESSION_TTL_SECONDS);
  } catch (error) {
    logger.warn("[AuthSessionStore] Failed to resolve auth session TTL, using default", {
      error: toLogError(error),
    });
    return DEFAULT_AUTH_SESSION_TTL_SECONDS;
  }
}

function buildSessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function parseSessionData(raw: string): SessionData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    if (typeof obj.sessionId !== "string") return null;
    if (typeof obj.keyFingerprint !== "string") return null;
    if (typeof obj.userRole !== "string") return null;
    if (typeof obj.userId !== "number" || !Number.isInteger(obj.userId)) return null;
    if (!Number.isFinite(obj.createdAt) || typeof obj.createdAt !== "number") return null;
    if (!Number.isFinite(obj.expiresAt) || typeof obj.expiresAt !== "number") return null;

    // Old payloads used `session` to describe cookie transport, which erased the originating
    // database-key provenance. Only the virtual ADMIN_TOKEN identity is privileged; every stored
    // database-user session is treated as user-api-key, including legacy payloads.
    const credentialType = obj.userId === -1 ? "admin-token" : "user-api-key";

    return {
      sessionId: obj.sessionId,
      keyFingerprint: obj.keyFingerprint,
      credentialType,
      userId: obj.userId as number,
      userRole: obj.userRole,
      createdAt: obj.createdAt,
      expiresAt: obj.expiresAt,
    };
  } catch {
    return null;
  }
}

function resolveRotateTtlSeconds(expiresAt: number): number | null {
  if (!Number.isFinite(expiresAt) || typeof expiresAt !== "number") {
    return DEFAULT_SESSION_TTL;
  }

  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    return null;
  }
  return Math.max(MIN_TTL_SECONDS, Math.ceil(remainingMs / 1000));
}

function waitForRedisReady(redis: RedisSessionClient, timeoutMs: number): Promise<boolean> {
  if (redis.status === "ready") return Promise.resolve(true);
  if (redis.status === "end") return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;

    const settle = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      redis.off("ready", onReady);
      redis.off("end", onUnavailable);
      resolve(ready);
    };

    const onReady = () => settle(true);
    const onUnavailable = () => settle(false);
    const timer = setTimeout(() => settle(false), timeoutMs);

    redis.on("ready", onReady);
    redis.on("end", onUnavailable);

    // Close the gap between the initial status check and listener registration.
    if (redis.status === "ready") settle(true);
    else if (redis.status === "end") settle(false);
  });
}

export class RedisSessionStore implements SessionStore {
  private readonly defaultTtlSeconds: number;
  private readonly redisClient?: RedisSessionClient | null;
  private readonly redisReadyWaitMs: number;

  constructor(options: RedisSessionStoreOptions = {}) {
    this.defaultTtlSeconds =
      options.defaultTtlSeconds === undefined
        ? resolveDefaultAuthSessionTtlSeconds()
        : normalizeTtlSeconds(options.defaultTtlSeconds);
    this.redisClient = options.redisClient;
    this.redisReadyWaitMs =
      Number.isFinite(options.redisReadyWaitMs) && typeof options.redisReadyWaitMs === "number"
        ? Math.max(0, Math.floor(options.redisReadyWaitMs))
        : DEFAULT_REDIS_READY_WAIT_MS;
  }

  private resolveRedisClient(): RedisSessionClient | null {
    if (this.redisClient !== undefined) {
      return this.redisClient;
    }

    return getRedisClient({ allowWhenRateLimitDisabled: true }) as RedisSessionClient | null;
  }

  private async getReadyRedis(options?: {
    waitForReady?: boolean;
  }): Promise<RedisSessionClient | null> {
    const redis = this.resolveRedisClient();
    if (!redis || redis.status !== "ready") {
      if (!redis || !options?.waitForReady || this.redisReadyWaitMs <= 0) return null;
      const becameReady = await waitForRedisReady(redis, this.redisReadyWaitMs);
      return becameReady && redis.status === "ready" ? redis : null;
    }

    return redis;
  }

  async create(
    data: Omit<SessionData, "sessionId" | "createdAt" | "expiresAt">,
    ttlSeconds = this.defaultTtlSeconds
  ): Promise<SessionData> {
    const ttl = normalizeTtlSeconds(ttlSeconds);
    const createdAt = Date.now();
    const sessionData: SessionData = {
      sessionId: `sid_${globalThis.crypto.randomUUID()}`,
      keyFingerprint: data.keyFingerprint,
      credentialType: data.userId === -1 ? "admin-token" : "user-api-key",
      userId: data.userId,
      userRole: data.userRole,
      createdAt,
      expiresAt: createdAt + ttl * 1000,
    };

    const redis = await this.getReadyRedis({ waitForReady: true });
    if (!redis) {
      throw new Error("Redis not ready: session not persisted");
    }

    try {
      await redis.setex(buildSessionKey(sessionData.sessionId), ttl, JSON.stringify(sessionData));
    } catch (error) {
      logger.error("[AuthSessionStore] Failed to create session", {
        error: toLogError(error),
        sessionId: sessionData.sessionId,
      });
      throw error;
    }

    return sessionData;
  }

  async read(sessionId: string): Promise<SessionData | null> {
    const redis = await this.getReadyRedis({ waitForReady: true });
    if (!redis) {
      return null;
    }

    try {
      const value = await redis.get(buildSessionKey(sessionId));
      if (!value) {
        return null;
      }

      const parsed = parseSessionData(value);
      if (!parsed) {
        logger.warn("[AuthSessionStore] Invalid session payload", { sessionId });
        return null;
      }

      return parsed;
    } catch (error) {
      logger.error("[AuthSessionStore] Failed to read session", {
        error: toLogError(error),
        sessionId,
      });
      return null;
    }
  }

  async revoke(sessionId: string): Promise<boolean> {
    const redis = await this.getReadyRedis({ waitForReady: true });
    if (!redis) {
      logger.warn("[AuthSessionStore] Redis not ready during revoke", { sessionId });
      return false;
    }

    try {
      const deleted = await redis.del(buildSessionKey(sessionId));
      return deleted > 0;
    } catch (error) {
      logger.error("[AuthSessionStore] Failed to revoke session", {
        error: toLogError(error),
        sessionId,
      });
      return false;
    }
  }

  async rotate(oldSessionId: string): Promise<SessionData | null> {
    const oldSession = await this.read(oldSessionId);
    if (!oldSession) {
      return null;
    }

    const ttlSeconds = resolveRotateTtlSeconds(oldSession.expiresAt);
    if (ttlSeconds === null) {
      logger.warn("[AuthSessionStore] Cannot rotate expired session", {
        sessionId: oldSessionId,
        expiresAt: oldSession.expiresAt,
      });
      return null;
    }
    let nextSession: SessionData;
    try {
      nextSession = await this.create(
        {
          keyFingerprint: oldSession.keyFingerprint,
          credentialType: oldSession.credentialType,
          userId: oldSession.userId,
          userRole: oldSession.userRole,
        },
        ttlSeconds
      );
    } catch (error) {
      logger.error("[AuthSessionStore] Failed to create rotated session", {
        error: toLogError(error),
        oldSessionId,
      });
      return null;
    }

    const revoked = await this.revoke(oldSessionId);
    if (!revoked) {
      logger.warn(
        "[AuthSessionStore] Failed to revoke old session during rotate; old session will expire naturally",
        {
          oldSessionId,
          newSessionId: nextSession.sessionId,
        }
      );
    }

    return nextSession;
  }
}
