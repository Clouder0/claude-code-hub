"use server";

import { and, avg, count, desc, eq, gte, lt, type SQL, sql, sum } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { providers, usageLedger } from "@/drizzle/schema";
import { Decimal, toCostDecimal } from "@/lib/utils/currency";
import { resolveSystemTimezone } from "@/lib/utils/timezone";
import { LEDGER_BILLING_CONDITION } from "./_shared/ledger-conditions";
import { buildProviderBillingEventsQuery } from "./_shared/provider-billing-events";
import { getSystemSettings } from "./system-config";

export interface UserInsightsOverviewMetrics {
  requestCount: number;
  totalCost: number;
  avgResponseTime: number;
  errorRate: number;
}

export interface AdminUserModelBreakdownItem {
  model: string | null;
  requests: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Get model-level usage breakdown for a specific user.
 * Groups by the billingModelSource-resolved model field and orders by cost DESC.
 */
export interface AdminUserProviderBreakdownItem {
  providerId: number;
  providerName: string | null;
  requests: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

async function buildSystemTimezoneDateConditions(startDate?: string, endDate?: string) {
  const timezone = await resolveSystemTimezone();
  const conditions = [];

  if (startDate) {
    conditions.push(gte(usageLedger.createdAt, sql`(${startDate}::date AT TIME ZONE ${timezone})`));
  }

  if (endDate) {
    conditions.push(
      lt(
        usageLedger.createdAt,
        sql`((${endDate}::date + INTERVAL '1 day') AT TIME ZONE ${timezone})`
      )
    );
  }

  return conditions;
}

function buildLedgerEventDateConditions(
  startDate: string | undefined,
  endDate: string | undefined,
  timezone: string
): SQL[] {
  const conditions: SQL[] = [];

  if (startDate) {
    conditions.push(sql`ledger.created_at >= (${startDate}::date AT TIME ZONE ${timezone})`);
  }
  if (endDate) {
    conditions.push(
      sql`ledger.created_at < ((${endDate}::date + INTERVAL '1 day') AT TIME ZONE ${timezone})`
    );
  }

  return conditions;
}

/**
 * Get overview metrics for a specific user within a date range.
 */
export async function getUserOverviewMetrics(
  userId: number,
  startDate?: string,
  endDate?: string
): Promise<UserInsightsOverviewMetrics> {
  const conditions = [
    LEDGER_BILLING_CONDITION,
    eq(usageLedger.userId, userId),
    ...(await buildSystemTimezoneDateConditions(startDate, endDate)),
  ];

  const [result] = await db
    .select({
      requestCount: count(),
      totalCost: sum(usageLedger.costUsd),
      avgDuration: avg(usageLedger.durationMs),
      errorCount: sql<number>`count(*) FILTER (WHERE NOT ${usageLedger.isSuccess})`,
    })
    .from(usageLedger)
    .where(and(...conditions));

  const costDecimal = toCostDecimal(result?.totalCost) ?? new Decimal(0);
  const totalCost = costDecimal.toDecimalPlaces(6).toNumber();
  const requestCount = Number(result?.requestCount || 0);
  const errorCount = Number(result?.errorCount || 0);
  const avgResponseTime = result?.avgDuration ? Math.round(Number(result.avgDuration)) : 0;
  const errorRate =
    requestCount > 0 ? parseFloat(((errorCount / requestCount) * 100).toFixed(2)) : 0;

  return {
    requestCount,
    totalCost,
    avgResponseTime,
    errorRate,
  };
}

/**
 * Get model-level usage breakdown for a specific user.
 * Groups by the billingModelSource-resolved model field and orders by cost DESC.
 */
export async function getUserModelBreakdown(
  userId: number,
  startDate?: string,
  endDate?: string,
  filters?: { keyId?: number; providerId?: number }
): Promise<AdminUserModelBreakdownItem[]> {
  const systemSettings = await getSystemSettings();
  const billingModelSource = systemSettings.billingModelSource;

  const rawModelField =
    billingModelSource === "original"
      ? sql<string>`COALESCE(${usageLedger.originalModel}, ${usageLedger.model})`
      : sql<string>`COALESCE(${usageLedger.model}, ${usageLedger.originalModel})`;
  const modelField = sql<string>`NULLIF(TRIM(${rawModelField}), '')`;

  if (filters?.providerId) {
    const timezone = await resolveSystemTimezone();
    // The date window is enforced once, inside the event CTE (both winner and
    // hedge-loser events inherit the ledger row's created_at); filtering the
    // outer query on provider_billing_event.created_at duplicated it.
    const ledgerDateConditions = buildLedgerEventDateConditions(startDate, endDate, timezone);
    const eventModelField =
      billingModelSource === "original"
        ? sql<string>`NULLIF(TRIM(COALESCE(provider_billing_event.original_model, provider_billing_event.model)), '')`
        : sql<string>`NULLIF(TRIM(COALESCE(provider_billing_event.model, provider_billing_event.original_model)), '')`;
    const eventConditions = [
      sql`provider_billing_event.user_id = ${userId}`,
      sql`provider_billing_event.provider_id = ${filters.providerId}`,
    ];
    if (filters.keyId) {
      eventConditions.push(
        sql`provider_billing_event.key_value = (SELECT k."key" FROM "keys" k WHERE k."id" = ${filters.keyId})`
      );
    }

    return await db
      .select({
        model: eventModelField,
        requests: sql<number>`count(*)::int`,
        cost: sql<number>`COALESCE(sum(provider_billing_event.cost_usd)::double precision, 0)`,
        inputTokens: sql<number>`COALESCE(sum(provider_billing_event.input_tokens)::double precision, 0)`,
        outputTokens: sql<number>`COALESCE(sum(provider_billing_event.output_tokens)::double precision, 0)`,
        cacheCreationTokens: sql<number>`COALESCE(sum(provider_billing_event.cache_creation_input_tokens)::double precision, 0)`,
        cacheReadTokens: sql<number>`COALESCE(sum(provider_billing_event.cache_read_input_tokens)::double precision, 0)`,
      })
      .from(
        sql`(${buildProviderBillingEventsQuery({
          providerId: filters.providerId,
          userId,
          ledgerCreatedAtCondition:
            ledgerDateConditions.length > 0
              ? sql.join(ledgerDateConditions, sql` AND `)
              : undefined,
        })}) AS provider_billing_event`
      )
      .where(and(...eventConditions))
      .groupBy(eventModelField)
      .orderBy(desc(sql`sum(provider_billing_event.cost_usd)`));
  }

  const conditions = [
    LEDGER_BILLING_CONDITION,
    eq(usageLedger.userId, userId),
    ...(await buildSystemTimezoneDateConditions(startDate, endDate)),
  ];

  if (filters?.keyId) {
    conditions.push(
      sql`${usageLedger.key} = (SELECT k."key" FROM "keys" k WHERE k."id" = ${filters.keyId})`
    );
  }

  if (filters?.providerId) {
    conditions.push(eq(usageLedger.finalProviderId, filters.providerId));
  }

  const rows = await db
    .select({
      model: modelField,
      requests: sql<number>`count(*)::int`,
      cost: sql<number>`COALESCE(sum(${usageLedger.costUsd})::double precision, 0)`,
      inputTokens: sql<number>`COALESCE(sum(${usageLedger.inputTokens})::double precision, 0)`,
      outputTokens: sql<number>`COALESCE(sum(${usageLedger.outputTokens})::double precision, 0)`,
      cacheCreationTokens: sql<number>`COALESCE(sum(${usageLedger.cacheCreationInputTokens})::double precision, 0)`,
      cacheReadTokens: sql<number>`COALESCE(sum(${usageLedger.cacheReadInputTokens})::double precision, 0)`,
    })
    .from(usageLedger)
    .where(and(...conditions))
    .groupBy(modelField)
    .orderBy(desc(sql`sum(${usageLedger.costUsd})`));

  return rows;
}

/**
 * Get provider-level usage breakdown for a specific user.
 * Expands request totals into winner/hedge-loser billing events and groups by provider.
 */
export async function getUserProviderBreakdown(
  userId: number,
  startDate?: string,
  endDate?: string,
  filters?: { keyId?: number; model?: string }
): Promise<AdminUserProviderBreakdownItem[]> {
  const timezone = await resolveSystemTimezone();
  // Same as getUserModelBreakdown: the CTE already carries the date window on
  // ledger rows; the outer event-level predicates were duplicates.
  const ledgerDateConditions = buildLedgerEventDateConditions(startDate, endDate, timezone);
  const conditions = [sql`provider_billing_event.user_id = ${userId}`];

  if (filters?.keyId) {
    conditions.push(
      sql`provider_billing_event.key_value = (SELECT k."key" FROM "keys" k WHERE k."id" = ${filters.keyId})`
    );
  }

  if (filters?.model) {
    conditions.push(
      sql`(provider_billing_event.model ILIKE ${filters.model} OR provider_billing_event.original_model ILIKE ${filters.model})`
    );
  }

  const rows = await db
    .select({
      providerId: providers.id,
      providerName: providers.name,
      requests: sql<number>`count(*)::int`,
      cost: sql<number>`COALESCE(sum(provider_billing_event.cost_usd)::double precision, 0)`,
      inputTokens: sql<number>`COALESCE(sum(provider_billing_event.input_tokens)::double precision, 0)`,
      outputTokens: sql<number>`COALESCE(sum(provider_billing_event.output_tokens)::double precision, 0)`,
      cacheCreationTokens: sql<number>`COALESCE(sum(provider_billing_event.cache_creation_input_tokens)::double precision, 0)`,
      cacheReadTokens: sql<number>`COALESCE(sum(provider_billing_event.cache_read_input_tokens)::double precision, 0)`,
    })
    .from(
      sql`(${buildProviderBillingEventsQuery({
        userId,
        ledgerCreatedAtCondition:
          ledgerDateConditions.length > 0 ? sql.join(ledgerDateConditions, sql` AND `) : undefined,
      })}) AS provider_billing_event`
    )
    .innerJoin(providers, sql`provider_billing_event.provider_id = ${providers.id}`)
    .where(and(...conditions))
    .groupBy(providers.id, providers.name)
    .orderBy(desc(sql`sum(provider_billing_event.cost_usd)`));

  return rows;
}
