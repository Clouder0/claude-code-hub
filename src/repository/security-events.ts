"use server";

import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { keys, messageRequest, providers, securityEvents, users } from "@/drizzle/schema";
import type { SecurityEventType } from "@/lib/security/security-signals";

export type RecentSecurityEvent = {
  id: number;
  type: SecurityEventType;
  createdAt: Date;
  messageRequestId: number | null;
  clientInstanceId: string | null;
  centralStatus: "pending" | "confirmed" | "unconfirmed";
  userId: number;
  userName: string;
  userEnabled: boolean;
  keyId: number | null;
  keyName: string | null;
  sessionId: string | null;
  requestSequence: number | null;
  providerId: number | null;
  providerName: string | null;
};

export type SecurityEventUserSummary = {
  userId: number;
  userName: string;
  userEnabled: boolean;
  policyBlockCount: number;
  safetyCheckCount: number;
  lastEventAt: Date;
};

export async function insertSecurityEvent(
  userId: number,
  messageRequestId: number | null,
  type: SecurityEventType,
  options?: {
    clientInstanceId?: string;
    centralStatus?: "pending" | "confirmed" | "unconfirmed";
    centralError?: string;
  }
): Promise<void> {
  await db
    .insert(securityEvents)
    .values(
      options
        ? {
            userId,
            messageRequestId,
            type,
            clientInstanceId: options.clientInstanceId,
            centralStatus: options.centralStatus ?? "confirmed",
            centralError: options.centralError,
            confirmedAt: options.centralStatus === "confirmed" ? new Date() : undefined,
          }
        : { userId, messageRequestId, type }
    )
    .onConflictDoNothing({
      target: [securityEvents.messageRequestId, securityEvents.type],
    });
}

export async function updateSecurityEventCentralStatus(
  messageRequestId: number,
  type: SecurityEventType,
  status: "confirmed" | "unconfirmed",
  centralError?: string
): Promise<void> {
  await db
    .update(securityEvents)
    .set({
      centralStatus: status,
      centralError: centralError?.slice(0, 128) ?? null,
      confirmedAt: status === "confirmed" ? new Date() : null,
    })
    .where(
      and(eq(securityEvents.messageRequestId, messageRequestId), eq(securityEvents.type, type))
    );
}

export async function findRecentSecurityEvents(options?: {
  limit?: number;
  offset?: number;
}): Promise<{ items: RecentSecurityEvent[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 100);
  const offset = Math.max(options?.offset ?? 0, 0);
  const rows = await db
    .select({
      id: securityEvents.id,
      type: securityEvents.type,
      createdAt: securityEvents.createdAt,
      messageRequestId: securityEvents.messageRequestId,
      clientInstanceId: securityEvents.clientInstanceId,
      centralStatus: securityEvents.centralStatus,
      userId: users.id,
      userName: users.name,
      userEnabled: users.isEnabled,
      keyId: keys.id,
      keyName: keys.name,
      sessionId: messageRequest.sessionId,
      requestSequence: messageRequest.requestSequence,
      providerId: messageRequest.providerId,
      providerName: providers.name,
    })
    .from(securityEvents)
    .innerJoin(users, eq(securityEvents.userId, users.id))
    .leftJoin(messageRequest, eq(securityEvents.messageRequestId, messageRequest.id))
    .leftJoin(
      keys,
      and(
        eq(messageRequest.key, keys.key),
        eq(messageRequest.userId, keys.userId),
        isNull(keys.deletedAt)
      )
    )
    .leftJoin(providers, eq(messageRequest.providerId, providers.id))
    .where(isNull(users.deletedAt))
    .orderBy(desc(securityEvents.createdAt), desc(securityEvents.id))
    .limit(limit + 1)
    .offset(offset);

  return {
    items: rows.slice(0, limit),
    hasMore: rows.length > limit,
  };
}

export async function findSecurityEventUserSummaries(options?: {
  since?: Date;
  limit?: number;
}): Promise<SecurityEventUserSummary[]> {
  const since = options?.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);

  return db
    .select({
      userId: users.id,
      userName: users.name,
      userEnabled: users.isEnabled,
      // 确认的策略拦截（cyber/bio）合计为 policyBlockCount；额外检查单列。
      policyBlockCount: sql<number>`count(*) FILTER (WHERE ${securityEvents.type} IN ('cyber_policy', 'bio_policy'))::int`,
      safetyCheckCount: sql<number>`count(*) FILTER (WHERE ${securityEvents.type} = 'cyber_safety_check')::int`,
      lastEventAt: sql<Date>`max(${securityEvents.createdAt})`,
    })
    .from(securityEvents)
    .innerJoin(users, eq(securityEvents.userId, users.id))
    .where(and(gte(securityEvents.createdAt, since), isNull(users.deletedAt)))
    .groupBy(users.id, users.name, users.isEnabled)
    .orderBy(desc(sql`max(${securityEvents.createdAt})`))
    .limit(limit);
}
