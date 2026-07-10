import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { db } from "@/drizzle/db";
import { messageRequest, providers, providerVendors, usageLedger } from "@/drizzle/schema";
import { backfillUsageLedger } from "@/lib/ledger-backfill";
import { isLedgerOnlyMode } from "@/lib/ledger-fallback";
import { getUserModelBreakdown, getUserProviderBreakdown } from "@/repository/admin-user-insights";
import {
  addMessageRequestHedgeLoserCost,
  findRequestsBySessionId,
  findUsageLogs,
  updateMessageRequestDetails,
  updateMessageRequestUnsupportedBillingSettlement,
} from "@/repository/message";
import { flushMessageRequestWriteBuffer } from "@/repository/message-write-buffer";
import {
  findProviderCostEntriesInTimeRange,
  sumProviderCostInTimeRange,
  sumProviderTotalCost,
  sumUserTotalCost,
} from "@/repository/statistics";
import { findReadonlyUsageLogsBatchForKey } from "@/repository/usage-logs";
import { findDailyProviderLeaderboard } from "@/repository/leaderboard";
import { getProviderStatistics } from "@/repository/provider";
import type { HedgeLoserBilling, StoredCostBreakdown } from "@/types/cost-breakdown";
import type { SpecialSetting } from "@/types/special-settings";

if (!process.env.DSN && process.env.DATABASE_URL) {
  process.env.DSN = process.env.DATABASE_URL;
}

const HAS_DB = Boolean(process.env.DSN);
const run = describe.skipIf(!HAS_DB);

const KEY_PREFIX = `it-usage-ledger-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ID_SEED = Math.floor(Date.now() / 1000) % 1_000_000;

const GPT56_COST_BREAKDOWN: StoredCostBreakdown = {
  input: "0",
  output: "0.000150000000000",
  cache_creation: "0.056350000000000",
  cache_creation_default: "0.056350000000000",
  cache_read: "0",
  base_total: "0.056500000000000",
  provider_multiplier: 1,
  group_multiplier: 1,
  total: "0.056500000000000",
};

const GPT56_SPECIAL_SETTINGS: SpecialSetting[] = [
  {
    type: "long_context_pricing",
    scope: "billing",
    hit: false,
    pricingScope: "request",
    thresholdTokens: 272_000,
  },
];

const GPT56_HEDGE_LOSERS: HedgeLoserBilling[] = [
  {
    providerId: 4242,
    providerName: "priority-loser",
    attemptNumber: 2,
    costUsd: "0.012500000000000",
    inputTokens: 0,
    observedInputTokens: 2000,
    outputTokens: 0,
    cacheCreationInputTokens: 2000,
    cacheWriteTokensReported: 0,
    cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
    cacheReadInputTokens: 0,
  },
];

const GPT56_HEDGE_TOTAL = "0.069000000000000";

let idCursor = 0;
let keyCursor = 0;

function nextUserId() {
  idCursor += 1;
  return 700_000_000 + ID_SEED * 10 + idCursor;
}

function nextProviderId() {
  idCursor += 1;
  return 800_000_000 + ID_SEED * 10 + idCursor;
}

function nextKey(tag: string) {
  keyCursor += 1;
  return `${KEY_PREFIX}-${tag}-${keyCursor}`;
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

type InsertRequestInput = {
  key: string;
  userId: number;
  providerId: number;
  sessionId?: string | null;
  requestSequence?: number | null;
  model?: string | null;
  originalModel?: string | null;
  endpoint?: string | null;
  apiType?: string | null;
  statusCode?: number | null;
  blockedBy?: string | null;
  errorMessage?: string | null;
  costUsd?: string | null;
  costMultiplier?: string | null;
  inputTokens?: number | null;
  observedInputTokens?: number | null;
  outputTokens?: number | null;
  cacheWriteTokensReported?: number | null;
  cacheWriteAccounting?: "reported_positive" | "inferred_input_minus_cache_read_v1" | "none" | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  costBreakdown?: StoredCostBreakdown | null;
  specialSettings?: SpecialSetting[] | null;
  hedgeLosers?: HedgeLoserBilling[] | null;
  providerChain?: Array<{ id: number; name: string; reason?: string }> | null;
  createdAt?: Date;
};

async function insertMessageRequestRow(input: InsertRequestInput) {
  const [row] = await db
    .insert(messageRequest)
    .values({
      key: input.key,
      userId: input.userId,
      providerId: input.providerId,
      sessionId: input.sessionId,
      requestSequence: input.requestSequence,
      model: input.model,
      originalModel: input.originalModel,
      endpoint: input.endpoint,
      apiType: input.apiType,
      statusCode: input.statusCode,
      blockedBy: input.blockedBy,
      errorMessage: input.errorMessage,
      costUsd: input.costUsd,
      costMultiplier: input.costMultiplier,
      inputTokens: input.inputTokens,
      observedInputTokens: input.observedInputTokens,
      outputTokens: input.outputTokens,
      cacheWriteTokensReported: input.cacheWriteTokensReported,
      cacheWriteAccounting: input.cacheWriteAccounting,
      cacheCreationInputTokens: input.cacheCreationInputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      costBreakdown: input.costBreakdown,
      specialSettings: input.specialSettings,
      hedgeLosers: input.hedgeLosers,
      providerChain: input.providerChain,
      createdAt: input.createdAt,
    })
    .returning({ id: messageRequest.id });

  if (!row) {
    throw new Error("failed to insert message_request test row");
  }

  return row.id;
}

async function selectLedgerRowByRequestId(requestId: number) {
  const [row] = await db
    .select({
      id: usageLedger.id,
      requestId: usageLedger.requestId,
      userId: usageLedger.userId,
      key: usageLedger.key,
      providerId: usageLedger.providerId,
      finalProviderId: usageLedger.finalProviderId,
      model: usageLedger.model,
      originalModel: usageLedger.originalModel,
      endpoint: usageLedger.endpoint,
      apiType: usageLedger.apiType,
      statusCode: usageLedger.statusCode,
      isSuccess: usageLedger.isSuccess,
      successRateOutcome: usageLedger.successRateOutcome,
      blockedBy: usageLedger.blockedBy,
      costUsd: usageLedger.costUsd,
      costMultiplier: usageLedger.costMultiplier,
      inputTokens: usageLedger.inputTokens,
      observedInputTokens: usageLedger.observedInputTokens,
      outputTokens: usageLedger.outputTokens,
      cacheWriteTokensReported: usageLedger.cacheWriteTokensReported,
      cacheWriteAccounting: usageLedger.cacheWriteAccounting,
      cacheCreationInputTokens: usageLedger.cacheCreationInputTokens,
      cacheReadInputTokens: usageLedger.cacheReadInputTokens,
      costBreakdown: usageLedger.costBreakdown,
      specialSettings: usageLedger.specialSettings,
      hedgeLosers: usageLedger.hedgeLosers,
      createdAt: usageLedger.createdAt,
    })
    .from(usageLedger)
    .where(eq(usageLedger.requestId, requestId))
    .limit(1);

  return row ?? null;
}

async function cleanupTestRows() {
  const keyLike = `${KEY_PREFIX}%`;
  await db.delete(messageRequest).where(sql`${messageRequest.key} LIKE ${keyLike}`);
  await db.delete(usageLedger).where(sql`${usageLedger.key} LIKE ${keyLike}`);
  await db.delete(providers).where(sql`${providers.name} LIKE ${keyLike}`);
  await db
    .delete(providerVendors)
    .where(sql`${providerVendors.websiteDomain} LIKE ${`${KEY_PREFIX}%`}`);
}

run("usage ledger integration", () => {
  beforeAll(async () => {
    await cleanupTestRows();
  });

  afterAll(async () => {
    await cleanupTestRows();
  });

  describe("migration safety", () => {
    test("0109-0110 add nullable audit columns without repricing historical rows", async () => {
      const migrationSources = await Promise.all(
        ["0109_left_shooting_star.sql", "0110_brief_synch.sql"].map((fileName) =>
          readFile(resolve(process.cwd(), "drizzle", fileName), "utf8")
        )
      );
      const schemaName = `it_gpt56_migration_${Date.now()}_${Math.random().toString(16).slice(2)}`;

      await db.execute(sql`CREATE SCHEMA ${sql.identifier(schemaName)}`);
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schemaName)}, pg_catalog`);
          await tx.execute(
            sql.raw(`
            CREATE TABLE message_request (
              id serial PRIMARY KEY,
              cost_usd numeric(21, 15)
            )
          `)
          );
          await tx.execute(
            sql.raw(`
            CREATE TABLE usage_ledger (
              id serial PRIMARY KEY,
              cost_usd numeric(21, 15)
            )
          `)
          );
          await tx.execute(
            sql.raw(`
            INSERT INTO message_request (cost_usd)
            VALUES (1.230000000000000), (4.560000000000000)
          `)
          );
          await tx.execute(
            sql.raw(`
            INSERT INTO usage_ledger (cost_usd)
            VALUES (1.230000000000000), (4.560000000000000)
          `)
          );

          const [before] = await tx.execute(
            sql.raw(`
            SELECT
              (SELECT SUM(cost_usd)::text FROM message_request) AS message_cost,
              (SELECT SUM(cost_usd)::text FROM usage_ledger) AS ledger_cost
            `)
          );
          expect(before).toMatchObject({
            message_cost: "5.790000000000000",
            ledger_cost: "5.790000000000000",
          });

          for (const migrationSource of migrationSources) {
            for (const statement of migrationSource.split("--> statement-breakpoint")) {
              const trimmed = statement.trim();
              if (trimmed) {
                await tx.execute(sql.raw(trimmed));
              }
            }
          }

          const [after] = await tx.execute(
            sql.raw(`
            SELECT
              (SELECT SUM(cost_usd)::text FROM message_request) AS message_cost,
              (SELECT SUM(cost_usd)::text FROM usage_ledger) AS ledger_cost,
              (SELECT COUNT(*)::integer FROM message_request
                WHERE observed_input_tokens IS NULL
                  AND cache_write_tokens_reported IS NULL
                  AND cache_write_accounting IS NULL) AS message_null_audit_rows,
              (SELECT COUNT(*)::integer FROM usage_ledger
                WHERE observed_input_tokens IS NULL
                  AND cache_write_tokens_reported IS NULL
                  AND cache_write_accounting IS NULL
                  AND cost_breakdown IS NULL
                  AND special_settings IS NULL
                  AND hedge_losers IS NULL) AS ledger_null_audit_rows
          `)
          );

          expect(after).toMatchObject({
            message_cost: before?.message_cost,
            ledger_cost: before?.ledger_cost,
            message_null_audit_rows: 2,
            ledger_null_audit_rows: 2,
          });
        });
      } finally {
        await db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaName)} CASCADE`);
      }
    });
  });

  describe("trigger", () => {
    test("inserts usage_ledger row after inserting message_request", async () => {
      const key = nextKey("trigger-insert");
      const userId = nextUserId();
      const providerId = nextProviderId();
      const createdAt = new Date("2026-02-19T03:00:00.000Z");

      const requestId = await insertMessageRequestRow({
        key,
        userId,
        providerId,
        model: "model-a",
        originalModel: "model-a-original",
        endpoint: "/v1/messages",
        apiType: "response",
        statusCode: 200,
        costUsd: "1.250000000000000",
        costMultiplier: "1.1000",
        inputTokens: 12,
        outputTokens: 34,
        createdAt,
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).not.toBeNull();
      expect(ledgerRow?.requestId).toBe(requestId);
      expect(ledgerRow?.key).toBe(key);
      expect(ledgerRow?.userId).toBe(userId);
      expect(ledgerRow?.providerId).toBe(providerId);
      expect(ledgerRow?.finalProviderId).toBe(providerId);
      expect(ledgerRow?.model).toBe("model-a");
      expect(ledgerRow?.originalModel).toBe("model-a-original");
      expect(ledgerRow?.endpoint).toBe("/v1/messages");
      expect(ledgerRow?.apiType).toBe("response");
      expect(ledgerRow?.statusCode).toBe(200);
      expect(ledgerRow?.isSuccess).toBe(true);
      expect(ledgerRow?.successRateOutcome).toBe("success");
      expect(toNumber(ledgerRow?.costUsd)).toBeCloseTo(1.25, 10);
      expect(ledgerRow?.inputTokens).toBe(12);
      expect(ledgerRow?.outputTokens).toBe(34);
      expect(ledgerRow?.createdAt).toEqual(createdAt);
    });

    test("updates usage_ledger row on message_request update (UPSERT)", async () => {
      const key = nextKey("trigger-update");
      const userId = nextUserId();
      const providerId = nextProviderId();

      const requestId = await insertMessageRequestRow({
        key,
        userId,
        providerId,
        model: "model-before",
        costUsd: "0",
      });

      await db
        .update(messageRequest)
        .set({
          model: "model-after",
          costUsd: "3.500000000000000",
          inputTokens: 101,
          outputTokens: 202,
          statusCode: 201,
        })
        .where(eq(messageRequest.id, requestId));

      const rows = await db
        .select({
          id: usageLedger.id,
          model: usageLedger.model,
          costUsd: usageLedger.costUsd,
          inputTokens: usageLedger.inputTokens,
          outputTokens: usageLedger.outputTokens,
          statusCode: usageLedger.statusCode,
        })
        .from(usageLedger)
        .where(eq(usageLedger.requestId, requestId));

      expect(rows).toHaveLength(1);
      expect(rows[0]?.model).toBe("model-after");
      expect(toNumber(rows[0]?.costUsd)).toBeCloseTo(3.5, 10);
      expect(rows[0]?.inputTokens).toBe(101);
      expect(rows[0]?.outputTokens).toBe(202);
      expect(rows[0]?.statusCode).toBe(201);
    });

    test("copies GPT-5.6 usage provenance and pricing audit data on insert", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-gpt56-audit"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        model: "gpt-5.6-sol",
        statusCode: 200,
        costUsd: GPT56_HEDGE_TOTAL,
        inputTokens: 0,
        observedInputTokens: 9016,
        outputTokens: 5,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        cacheCreationInputTokens: 9016,
        cacheReadInputTokens: 0,
        costBreakdown: GPT56_COST_BREAKDOWN,
        specialSettings: GPT56_SPECIAL_SETTINGS,
        hedgeLosers: GPT56_HEDGE_LOSERS,
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).toMatchObject({
        inputTokens: 0,
        observedInputTokens: 9016,
        outputTokens: 5,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        cacheCreationInputTokens: 9016,
        cacheReadInputTokens: 0,
        costBreakdown: GPT56_COST_BREAKDOWN,
        specialSettings: GPT56_SPECIAL_SETTINGS,
        hedgeLosers: GPT56_HEDGE_LOSERS,
      });
      expect(ledgerRow?.costUsd).toBe(GPT56_HEDGE_TOTAL);
    });

    test("distinguishes a missing reported write from an explicit zero after update", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-null-vs-zero"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 200,
        costUsd: "1.230000000000000",
      });

      const before = await selectLedgerRowByRequestId(requestId);
      expect(before?.cacheWriteTokensReported).toBeNull();
      expect(before?.cacheWriteAccounting).toBeNull();

      await db
        .update(messageRequest)
        .set({
          observedInputTokens: 9016,
          cacheWriteTokensReported: 0,
          cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        })
        .where(eq(messageRequest.id, requestId));

      const after = await selectLedgerRowByRequestId(requestId);
      expect(after?.cacheWriteTokensReported).toBe(0);
      expect(after?.cacheWriteAccounting).toBe("inferred_input_minus_cache_read_v1");
      expect(after?.costUsd).toBe("1.230000000000000");
    });

    test("direct hedge-loser settlement remains idempotent and durable in the ledger", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-hedge-loser-update"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 200,
        costUsd: GPT56_COST_BREAKDOWN.total,
        costBreakdown: GPT56_COST_BREAKDOWN,
      });
      const loser = GPT56_HEDGE_LOSERS[0];
      if (!loser) {
        throw new Error("expected hedge loser fixture");
      }

      const firstTotal = await addMessageRequestHedgeLoserCost(requestId, loser.costUsd, loser);
      const duplicateTotal = await addMessageRequestHedgeLoserCost(requestId, loser.costUsd, loser);

      expect(firstTotal).toBe(GPT56_HEDGE_TOTAL);
      expect(duplicateTotal).toBe(GPT56_HEDGE_TOTAL);

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.costUsd).toBe(GPT56_HEDGE_TOTAL);
      expect(ledgerRow?.costBreakdown).toEqual(GPT56_COST_BREAKDOWN);
      expect(ledgerRow?.hedgeLosers).toEqual(GPT56_HEDGE_LOSERS);
    });

    test("unsupported hedge-loser audit is durable without changing settled cost", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-hedge-loser-unsupported"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 200,
        costUsd: GPT56_COST_BREAKDOWN.total,
        costBreakdown: GPT56_COST_BREAKDOWN,
      });
      const unsupportedLoser: HedgeLoserBilling = {
        providerId: 4343,
        providerName: "priority-long-context-loser",
        attemptNumber: 3,
        costUsd: "0",
        billingStatus: "unsupported",
        billingReason: "gpt56_priority_long_context_unsupported",
        missingPricingFields: [],
        pricingContext: {
          source: "cloud_official",
          model: "gpt-5.6-sol",
          provider: "openai",
          supplement: {
            id: "openai-gpt56-2026-06-30",
            source: "https://developers.openai.com/api/docs/pricing",
            applied_fields: ["input_cost_per_token_priority"],
            conflicting_fields: ["cache_creation_input_token_cost"],
          },
        },
        observedInputTokens: 272001,
        cacheCreationInputTokens: 272001,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        requestedServiceTier: "priority",
        actualServiceTier: "priority",
        serviceTierResolvedFrom: "actual",
        effectivePriority: true,
      };

      const firstTotal = await addMessageRequestHedgeLoserCost(requestId, "0", unsupportedLoser);
      const duplicateTotal = await addMessageRequestHedgeLoserCost(
        requestId,
        "0",
        unsupportedLoser
      );

      expect(firstTotal).toBe(GPT56_COST_BREAKDOWN.total);
      expect(duplicateTotal).toBe(GPT56_COST_BREAKDOWN.total);

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.costUsd).toBe(GPT56_COST_BREAKDOWN.total);
      expect(ledgerRow?.costBreakdown).toEqual(GPT56_COST_BREAKDOWN);
      expect(ledgerRow?.hedgeLosers).toEqual([unsupportedLoser]);
    });

    test("unsupported winner audit is durable without manufacturing a ledger charge", async () => {
      const providerId = nextProviderId();
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-winner-unsupported"),
        userId: nextUserId(),
        providerId,
        statusCode: 200,
        costUsd: null,
      });
      const unsupportedSettings: SpecialSetting[] = [
        {
          type: "billing_settlement",
          scope: "billing",
          hit: true,
          status: "unsupported",
          reason: "gpt56_priority_long_context_unsupported",
          observedInputTokens: 272_001,
          missingFields: [],
        },
      ];

      await updateMessageRequestUnsupportedBillingSettlement(requestId, {
        providerId,
        model: "gpt-5.6-sol",
        costMultiplier: 1,
        groupCostMultiplier: 1,
        providerChain: [{ id: providerId, name: "priority", reason: "request_success" }],
        specialSettings: unsupportedSettings,
        context1mApplied: false,
        swapCacheTtlApplied: false,
        inputTokens: 272_001,
        observedInputTokens: 272_001,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      });

      const [requestRow] = await db
        .select({
          costUsd: messageRequest.costUsd,
          observedInputTokens: messageRequest.observedInputTokens,
          specialSettings: messageRequest.specialSettings,
        })
        .from(messageRequest)
        .where(eq(messageRequest.id, requestId));

      expect(requestRow).toMatchObject({
        costUsd: null,
        observedInputTokens: 272_001,
        specialSettings: unsupportedSettings,
      });
      expect(await selectLedgerRowByRequestId(requestId)).toMatchObject({
        costUsd: null,
        observedInputTokens: 272_001,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
        specialSettings: unsupportedSettings,
      });
    });

    test("unsupported winner and loser preserve NULL cost regardless of settlement order", async () => {
      for (const order of ["loser-first", "winner-first"] as const) {
        const providerId = nextProviderId();
        const requestId = await insertMessageRequestRow({
          key: nextKey(`trigger-all-unsupported-${order}`),
          userId: nextUserId(),
          providerId,
          statusCode: 200,
          costUsd: null,
        });
        const unsupportedLoser: HedgeLoserBilling = {
          providerId: nextProviderId(),
          providerName: "unsupported-priority-loser",
          attemptNumber: 2,
          costUsd: "0",
          billingStatus: "unsupported",
          billingReason: "gpt56_priority_long_context_unsupported",
          missingPricingFields: [],
          observedInputTokens: 272_001,
          requestedServiceTier: "priority",
          actualServiceTier: "priority",
          serviceTierResolvedFrom: "actual",
          effectivePriority: true,
        };
        const unsupportedSettings: SpecialSetting[] = [
          {
            type: "billing_settlement",
            scope: "billing",
            hit: true,
            status: "unsupported",
            reason: "gpt56_priority_long_context_unsupported",
            observedInputTokens: 272_001,
            missingFields: [],
          },
        ];
        const settleWinner = () =>
          updateMessageRequestUnsupportedBillingSettlement(requestId, {
            providerId,
            model: "gpt-5.6-sol",
            costMultiplier: 1,
            groupCostMultiplier: 1,
            providerChain: [{ id: providerId, name: "priority", reason: "hedge_winner" }],
            specialSettings: unsupportedSettings,
            context1mApplied: false,
            swapCacheTtlApplied: false,
            inputTokens: 272_001,
            observedInputTokens: 272_001,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteTokensReported: 0,
            cacheWriteAccounting: "none",
          });
        const settleLoser = () => addMessageRequestHedgeLoserCost(requestId, "0", unsupportedLoser);

        if (order === "loser-first") {
          await expect(settleLoser()).resolves.toBeNull();
          await settleWinner();
        } else {
          await settleWinner();
          await expect(settleLoser()).resolves.toBeNull();
        }
        await expect(settleLoser()).resolves.toBeNull();

        const [requestRow] = await db
          .select({
            costUsd: messageRequest.costUsd,
            hedgeLosers: messageRequest.hedgeLosers,
            specialSettings: messageRequest.specialSettings,
          })
          .from(messageRequest)
          .where(eq(messageRequest.id, requestId));
        expect(requestRow).toEqual({
          costUsd: null,
          hedgeLosers: [unsupportedLoser],
          specialSettings: unsupportedSettings,
        });
        expect(await selectLedgerRowByRequestId(requestId)).toMatchObject({
          costUsd: null,
          hedgeLosers: [unsupportedLoser],
          specialSettings: unsupportedSettings,
        });
      }
    });

    test("unsupported winner audit preserves an already-settled hedge loser total", async () => {
      const providerId = nextProviderId();
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-winner-unsupported-with-loser"),
        userId: nextUserId(),
        providerId,
        statusCode: 200,
        costUsd: GPT56_HEDGE_TOTAL,
        costBreakdown: GPT56_COST_BREAKDOWN,
        hedgeLosers: GPT56_HEDGE_LOSERS,
      });
      const unsupportedSettings: SpecialSetting[] = [
        {
          type: "billing_settlement",
          scope: "billing",
          hit: true,
          status: "unsupported",
          reason: "gpt56_priority_long_context_unsupported",
          observedInputTokens: 272_001,
          missingFields: [],
        },
      ];

      await updateMessageRequestUnsupportedBillingSettlement(requestId, {
        providerId,
        model: "gpt-5.6-sol",
        costMultiplier: 1,
        groupCostMultiplier: 1,
        providerChain: [{ id: providerId, name: "priority", reason: "hedge_winner" }],
        specialSettings: unsupportedSettings,
        context1mApplied: false,
        swapCacheTtlApplied: false,
        inputTokens: 272_001,
        observedInputTokens: 272_001,
        outputTokens: 5,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "none",
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).toMatchObject({
        costUsd: GPT56_HEDGE_TOTAL,
        costBreakdown: GPT56_COST_BREAKDOWN,
        hedgeLosers: GPT56_HEDGE_LOSERS,
        specialSettings: unsupportedSettings,
      });
    });

    test.skipIf(process.env.MESSAGE_REQUEST_WRITE_MODE !== "async")(
      "async terminal details preserve the direct unsupported settlement",
      async () => {
        const providerId = nextProviderId();
        const requestId = await insertMessageRequestRow({
          key: nextKey("async-winner-unsupported"),
          userId: nextUserId(),
          providerId,
          statusCode: null,
          costUsd: null,
        });
        const unsupportedSettings: SpecialSetting[] = [
          {
            type: "billing_settlement",
            scope: "billing",
            hit: true,
            status: "unsupported",
            reason: "gpt56_priority_long_context_unsupported",
            observedInputTokens: 272_001,
            missingFields: [],
          },
        ];
        const settlement = {
          providerId,
          model: "gpt-5.6-sol",
          costMultiplier: 1,
          groupCostMultiplier: 1,
          providerChain: [{ id: providerId, name: "priority", reason: "request_success" }],
          specialSettings: unsupportedSettings,
          context1mApplied: false,
          swapCacheTtlApplied: false,
          inputTokens: 272_001,
          observedInputTokens: 272_001,
          outputTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteTokensReported: 0,
          cacheWriteAccounting: "none" as const,
        };

        await updateMessageRequestUnsupportedBillingSettlement(requestId, settlement);
        await updateMessageRequestDetails(requestId, {
          statusCode: 200,
          inputTokens: settlement.inputTokens,
          observedInputTokens: settlement.observedInputTokens,
          outputTokens: settlement.outputTokens,
          cacheCreationInputTokens: settlement.cacheCreationInputTokens,
          cacheReadInputTokens: settlement.cacheReadInputTokens,
          cacheWriteTokensReported: settlement.cacheWriteTokensReported,
          cacheWriteAccounting: settlement.cacheWriteAccounting,
          providerChain: settlement.providerChain,
          model: settlement.model,
          providerId: settlement.providerId,
          // Simulate a stale in-flight snapshot captured before the direct settlement.
          specialSettings: [],
        });
        await flushMessageRequestWriteBuffer();

        const [requestRow] = await db
          .select({
            statusCode: messageRequest.statusCode,
            costUsd: messageRequest.costUsd,
            observedInputTokens: messageRequest.observedInputTokens,
            specialSettings: messageRequest.specialSettings,
          })
          .from(messageRequest)
          .where(eq(messageRequest.id, requestId));
        expect(requestRow).toMatchObject({
          statusCode: 200,
          costUsd: null,
          observedInputTokens: 272_001,
          specialSettings: unsupportedSettings,
        });
        expect(await selectLedgerRowByRequestId(requestId)).toMatchObject({
          statusCode: 200,
          costUsd: null,
          observedInputTokens: 272_001,
          specialSettings: unsupportedSettings,
        });
      }
    );

    test.skipIf(process.env.MESSAGE_REQUEST_WRITE_MODE !== "async")(
      "async write buffer propagates GPT-5.6 provenance through the ledger trigger",
      async () => {
        const requestId = await insertMessageRequestRow({
          key: nextKey("async-buffer-gpt56-audit"),
          userId: nextUserId(),
          providerId: nextProviderId(),
          statusCode: 200,
          costUsd: "0.750000000000000",
        });

        await updateMessageRequestDetails(requestId, {
          observedInputTokens: 9016,
          cacheWriteTokensReported: 0,
          cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
          inputTokens: 0,
          cacheCreationInputTokens: 9016,
          cacheReadInputTokens: 0,
        });
        await flushMessageRequestWriteBuffer();

        const ledgerRow = await selectLedgerRowByRequestId(requestId);
        expect(ledgerRow).toMatchObject({
          observedInputTokens: 9016,
          cacheWriteTokensReported: 0,
          cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
          inputTokens: 0,
          cacheCreationInputTokens: 9016,
          cacheReadInputTokens: 0,
        });
        expect(ledgerRow?.costUsd).toBe("0.750000000000000");
      }
    );

    test("does not insert usage_ledger row for warmup requests", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-warmup"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        blockedBy: "warmup",
        costUsd: "8.900000000000000",
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).toBeNull();
    });

    test("uses the last successful provider instead of a trailing hedge loser", async () => {
      const providerId = nextProviderId();
      const firstSuccessId = providerId + 111;
      const finalSuccessId = providerId + 222;
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-provider-chain"),
        userId: nextUserId(),
        providerId,
        providerChain: [
          { id: providerId, name: "origin", reason: "initial_selection" },
          { id: firstSuccessId, name: "first", reason: "request_success" },
          { id: finalSuccessId, name: "winner", reason: "retry_success" },
          { id: providerId, name: "loser", reason: "hedge_loser_billed" },
        ],
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).not.toBeNull();
      expect(ledgerRow?.finalProviderId).toBe(finalSuccessId);
    });

    test("falls back to the request provider when the chain has no valid success node", async () => {
      const providerId = nextProviderId();
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-provider-chain-fallback"),
        userId: nextUserId(),
        providerId,
        providerChain: [
          { id: providerId + 1, name: "initial", reason: "initial_selection" },
          { id: 9_999_999_999, name: "overflow", reason: "request_success" },
          { id: providerId + 2, name: "failed", reason: "retry_failed" },
        ],
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.finalProviderId).toBe(providerId);
    });

    test("sets is_success=false when error_message exists", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-error"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        errorMessage: "upstream failed",
        statusCode: 500,
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.isSuccess).toBe(false);
      expect(ledgerRow?.successRateOutcome).toBe("failure");
    });

    test("sets is_success=true when error_message is absent", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-success"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 200,
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.isSuccess).toBe(true);
      expect(ledgerRow?.successRateOutcome).toBe("success");
    });

    test("marks non-upstream failures as excluded for success-rate outcome", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("trigger-excluded"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 499,
        errorMessage: "request aborted by client",
      });

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.successRateOutcome).toBe("excluded");
    });
  });

  describe("backfill", () => {
    test(
      "backfill copies non-warmup message_request rows when ledger rows are missing",
      {
        timeout: 60_000,
      },
      async () => {
        const userId = nextUserId();
        const providerId = nextProviderId();
        const keepA = await insertMessageRequestRow({
          key: nextKey("backfill-a"),
          userId,
          providerId,
          costUsd: "1.100000000000000",
        });
        const keepB = await insertMessageRequestRow({
          key: nextKey("backfill-b"),
          userId,
          providerId,
          costUsd: "2.200000000000000",
        });
        const warmup = await insertMessageRequestRow({
          key: nextKey("backfill-warmup"),
          userId,
          providerId,
          blockedBy: "warmup",
        });

        await db.delete(usageLedger).where(inArray(usageLedger.requestId, [keepA, keepB, warmup]));

        const summary = await backfillUsageLedger();
        expect(summary.totalProcessed).toBeGreaterThanOrEqual(2);

        const rows = await db
          .select({ requestId: usageLedger.requestId })
          .from(usageLedger)
          .where(inArray(usageLedger.requestId, [keepA, keepB, warmup]));
        const requestIds = rows.map((row) => row.requestId);

        expect(requestIds).toContain(keepA);
        expect(requestIds).toContain(keepB);
        expect(requestIds).not.toContain(warmup);
      }
    );

    test("backfill is idempotent when running twice", { timeout: 60_000 }, async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("backfill-idempotent"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        costUsd: "6.600000000000000",
      });

      await db.delete(usageLedger).where(eq(usageLedger.requestId, requestId));

      await backfillUsageLedger();
      const countAfterFirst = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageLedger)
        .where(eq(usageLedger.requestId, requestId));

      await backfillUsageLedger();
      const countAfterSecond = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(usageLedger)
        .where(eq(usageLedger.requestId, requestId));

      expect(countAfterFirst[0]?.count ?? 0).toBe(1);
      expect(countAfterSecond[0]?.count ?? 0).toBe(1);
    });

    test("backfill keeps HTTP failures unsuccessful when error_message is absent", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("backfill-status-failure"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        statusCode: 500,
        errorMessage: null,
      });

      await db.delete(usageLedger).where(eq(usageLedger.requestId, requestId));
      await backfillUsageLedger();

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow?.isSuccess).toBe(false);
      expect(ledgerRow?.successRateOutcome).toBe("failure");
    });

    test("backfill copies provenance and audit JSON without changing stored cost", async () => {
      const requestId = await insertMessageRequestRow({
        key: nextKey("backfill-gpt56-audit"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        model: "gpt-5.6-sol",
        statusCode: 200,
        costUsd: GPT56_HEDGE_TOTAL,
        inputTokens: 0,
        observedInputTokens: 9016,
        outputTokens: 5,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        cacheCreationInputTokens: 9016,
        cacheReadInputTokens: 0,
        costBreakdown: GPT56_COST_BREAKDOWN,
        specialSettings: GPT56_SPECIAL_SETTINGS,
        hedgeLosers: GPT56_HEDGE_LOSERS,
      });

      await db.delete(usageLedger).where(eq(usageLedger.requestId, requestId));
      await backfillUsageLedger();

      const ledgerRow = await selectLedgerRowByRequestId(requestId);
      expect(ledgerRow).toMatchObject({
        observedInputTokens: 9016,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        costBreakdown: GPT56_COST_BREAKDOWN,
        specialSettings: GPT56_SPECIAL_SETTINGS,
        hedgeLosers: GPT56_HEDGE_LOSERS,
      });
      expect(ledgerRow?.costUsd).toBe(GPT56_HEDGE_TOTAL);
    });

    test(
      "backfill repairs existing ledger rows whose success_rate_outcome is null",
      {
        timeout: 60_000,
      },
      async () => {
        const requestId = await insertMessageRequestRow({
          key: nextKey("backfill-null-outcome"),
          userId: nextUserId(),
          providerId: nextProviderId(),
          statusCode: 499,
          errorMessage: "request aborted by client",
        });

        await db
          .update(usageLedger)
          .set({ successRateOutcome: null })
          .where(eq(usageLedger.requestId, requestId));

        const summary = await backfillUsageLedger();
        expect(summary.alreadyExisted).toBeGreaterThanOrEqual(1);

        const ledgerRow = await selectLedgerRowByRequestId(requestId);
        expect(ledgerRow?.successRateOutcome).toBe("excluded");
      }
    );

    test(
      "backfill repairs final provider without changing the existing ledger cost",
      { timeout: 60_000 },
      async () => {
        const providerId = nextProviderId();
        const winnerProviderId = providerId + 321;
        const trailingLoserId = providerId + 654;
        const requestId = await insertMessageRequestRow({
          key: nextKey("backfill-provider-attribution"),
          userId: nextUserId(),
          providerId,
          statusCode: 200,
          costUsd: "1.230000000000000",
          providerChain: [
            { id: winnerProviderId, name: "winner", reason: "hedge_winner" },
            { id: trailingLoserId, name: "loser", reason: "hedge_loser_billed" },
          ],
        });

        await db
          .update(usageLedger)
          .set({
            finalProviderId: trailingLoserId,
            costUsd: "9.876000000000000",
          })
          .where(eq(usageLedger.requestId, requestId));

        const summary = await backfillUsageLedger();
        expect(summary.alreadyExisted).toBeGreaterThanOrEqual(1);

        const repaired = await selectLedgerRowByRequestId(requestId);
        expect(repaired?.finalProviderId).toBe(winnerProviderId);
        expect(repaired?.costUsd).toBe("9.876000000000000");

        await backfillUsageLedger();
        const afterSecondRun = await selectLedgerRowByRequestId(requestId);
        expect(afterSecondRun?.finalProviderId).toBe(winnerProviderId);
        expect(afterSecondRun?.costUsd).toBe("9.876000000000000");
      }
    );
  });

  describe("read path consistency", () => {
    test("session request lists do not present unsupported settlement as a billed zero", async () => {
      const sessionId = `it-session-${ID_SEED}-${keyCursor + 1}`;
      await insertMessageRequestRow({
        key: nextKey("session-unsupported-cost-row"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        sessionId,
        requestSequence: 1,
        statusCode: 200,
        costUsd: "0.000000000000000",
        specialSettings: [
          {
            type: "billing_settlement",
            scope: "billing",
            hit: true,
            status: "unsupported",
            reason: "gpt56_priority_long_context_unsupported",
            observedInputTokens: 272_001,
            missingFields: [],
          },
        ],
      });

      const result = await findRequestsBySessionId(sessionId);

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]?.costUsd).toBeNull();
    });

    test("sumUserTotalCost matches expected cost from trigger-written ledger data", async () => {
      const userId = nextUserId();
      const providerId = nextProviderId();

      await insertMessageRequestRow({
        key: nextKey("read-match-a"),
        userId,
        providerId,
        costUsd: "1.110000000000000",
      });
      await insertMessageRequestRow({
        key: nextKey("read-match-b"),
        userId,
        providerId,
        costUsd: "2.220000000000000",
      });

      const total = await sumUserTotalCost(userId, Number.POSITIVE_INFINITY);
      expect(total).toBeCloseTo(3.33, 10);
    });

    test("ledger totals remain stable after deleting message_request rows", async () => {
      const userId = nextUserId();
      const providerId = nextProviderId();

      const requestA = await insertMessageRequestRow({
        key: nextKey("read-delete-a"),
        userId,
        providerId,
        costUsd: "4.440000000000000",
      });
      const requestB = await insertMessageRequestRow({
        key: nextKey("read-delete-b"),
        userId,
        providerId,
        costUsd: "5.550000000000000",
      });

      const beforeUserCost = await sumUserTotalCost(userId, Number.POSITIVE_INFINITY);
      const beforeProviderCost = await sumProviderTotalCost(providerId);

      await db
        .delete(messageRequest)
        .where(
          and(eq(messageRequest.userId, userId), inArray(messageRequest.id, [requestA, requestB]))
        );

      const afterUserCost = await sumUserTotalCost(userId, Number.POSITIVE_INFINITY);
      const afterProviderCost = await sumProviderTotalCost(providerId);

      expect(afterUserCost).toBeCloseTo(beforeUserCost, 10);
      expect(afterProviderCost).toBeCloseTo(beforeProviderCost, 10);
    });

    test("provider cost queries expand one hedged request into stable winner and loser events", async () => {
      const userId = nextUserId();
      const winnerProviderId = nextProviderId();
      const loserProviderId = nextProviderId();
      const createdAt = new Date(Date.now() - 60_000);
      const requestId = await insertMessageRequestRow({
        key: nextKey("provider-billing-events"),
        userId,
        providerId: winnerProviderId,
        statusCode: 200,
        costUsd: "0.400000000000000",
        providerChain: [{ id: winnerProviderId, name: "winner", reason: "hedge_winner" }],
        hedgeLosers: [
          {
            providerId: loserProviderId,
            providerName: "loser",
            attemptNumber: 2,
            costUsd: "0.100000000000000",
            billingStatus: "settled",
          },
          {
            providerId: loserProviderId,
            providerName: "loser",
            attemptNumber: 3,
            costUsd: "0.100000000000000",
            billingStatus: "settled",
          },
        ],
        createdAt,
      });
      const startTime = new Date(createdAt.getTime() - 1_000);
      const endTime = new Date(createdAt.getTime() + 1_000);

      expect(await sumProviderTotalCost(winnerProviderId)).toBeCloseTo(0.2, 15);
      expect(await sumProviderTotalCost(loserProviderId)).toBeCloseTo(0.2, 15);
      expect(await sumProviderCostInTimeRange(winnerProviderId, startTime, endTime)).toBeCloseTo(
        0.2,
        15
      );
      expect(await sumProviderCostInTimeRange(loserProviderId, startTime, endTime)).toBeCloseTo(
        0.2,
        15
      );

      expect(
        await findProviderCostEntriesInTimeRange(winnerProviderId, startTime, endTime)
      ).toEqual([
        {
          id: requestId,
          billingEventId: `${requestId}:winner`,
          createdAt,
          costUsd: 0.2,
        },
      ]);
      expect(await findProviderCostEntriesInTimeRange(loserProviderId, startTime, endTime)).toEqual(
        [
          {
            id: requestId,
            billingEventId: `${requestId}:hedge-loser:${loserProviderId}:2`,
            createdAt,
            costUsd: 0.1,
          },
          {
            id: requestId,
            billingEventId: `${requestId}:hedge-loser:${loserProviderId}:3`,
            createdAt,
            costUsd: 0.1,
          },
        ]
      );

      await db.delete(messageRequest).where(eq(messageRequest.id, requestId));
      expect(
        await findProviderCostEntriesInTimeRange(loserProviderId, startTime, endTime)
      ).toHaveLength(2);
    });

    test("provider billing events tolerate legacy, duplicate, unsupported, and malformed loser data", async () => {
      const winnerProviderId = nextProviderId();
      const loserProviderId = nextProviderId();
      const unsupportedProviderId = nextProviderId();
      const malformedJsonProviderId = nextProviderId();
      const overflowCostProviderId = nextProviderId();
      const numericStringProviderId = nextProviderId();
      const createdAt = new Date(Date.now() - 30_000);
      const requestId = await insertMessageRequestRow({
        key: nextKey("provider-billing-event-edges"),
        userId: nextUserId(),
        providerId: winnerProviderId,
        statusCode: 200,
        costUsd: "0.400000000000000",
        providerChain: [{ id: winnerProviderId, name: "winner", reason: "request_success" }],
        hedgeLosers: [
          {
            providerId: loserProviderId,
            providerName: "legacy-loser",
            attemptNumber: 2,
            costUsd: "1e-1",
          },
          {
            providerId: loserProviderId,
            providerName: "duplicate-loser",
            attemptNumber: 2,
            costUsd: "0.200000000000000",
            billingStatus: "settled",
          },
          {
            providerId: unsupportedProviderId,
            providerName: "unsupported-loser",
            attemptNumber: 3,
            costUsd: "0.050000000000000",
            billingStatus: "unsupported",
          },
          {
            providerId: "not-an-id",
            providerName: "malformed-loser",
            attemptNumber: 4,
            costUsd: "not-a-cost",
            billingStatus: "settled",
          },
          {
            providerId: overflowCostProviderId,
            providerName: "overflow-cost-loser",
            attemptNumber: 5,
            costUsd: "1e999999",
            billingStatus: "settled",
          },
          {
            providerId: String(numericStringProviderId),
            providerName: "legacy-string-id-loser",
            attemptNumber: "6",
            costUsd: "0.050000000000000",
            billingStatus: "settled",
          },
        ] as unknown as HedgeLoserBilling[],
        createdAt,
      });
      const startTime = new Date(createdAt.getTime() - 1);
      const endTime = new Date(createdAt.getTime() + 1);

      expect(await sumProviderTotalCost(winnerProviderId)).toBeCloseTo(0.25, 15);
      expect(await sumProviderTotalCost(loserProviderId)).toBeCloseTo(0.1, 15);
      expect(await sumProviderTotalCost(unsupportedProviderId)).toBe(0);
      expect(await sumProviderTotalCost(overflowCostProviderId)).toBe(0);
      expect(await sumProviderTotalCost(numericStringProviderId)).toBeCloseTo(0.05, 15);
      expect(await sumProviderTotalCost(winnerProviderId, new Date(createdAt.getTime() + 1))).toBe(
        0
      );
      expect(await sumProviderCostInTimeRange(winnerProviderId, startTime, createdAt)).toBe(0);
      expect(await sumProviderCostInTimeRange(winnerProviderId, createdAt, endTime)).toBeCloseTo(
        0.25,
        15
      );

      const loserEntries = await findProviderCostEntriesInTimeRange(
        loserProviderId,
        startTime,
        endTime
      );
      expect(loserEntries).toEqual([
        {
          id: requestId,
          billingEventId: `${requestId}:hedge-loser:${loserProviderId}:2`,
          createdAt,
          costUsd: 0.1,
        },
      ]);

      const malformedRequestId = await insertMessageRequestRow({
        key: nextKey("provider-billing-event-non-array"),
        userId: nextUserId(),
        providerId: malformedJsonProviderId,
        statusCode: 200,
        costUsd: "0.200000000000000",
        createdAt,
      });
      await db.execute(sql`
        UPDATE usage_ledger
        SET hedge_losers = '{}'::jsonb
        WHERE request_id = ${malformedRequestId}
      `);
      expect(await sumProviderTotalCost(malformedJsonProviderId)).toBeCloseTo(0.2, 15);
    });

    test("provider leaderboard attributes cost and tokens to winner and loser billing events", async () => {
      const winnerProviderId = nextProviderId();
      const loserProviderId = nextProviderId();
      const userId = nextUserId();
      const [vendor] = await db
        .insert(providerVendors)
        .values({
          websiteDomain: `${KEY_PREFIX}-leaderboard.example`,
          displayName: "billing-event-test",
        })
        .returning({ id: providerVendors.id });
      if (!vendor) throw new Error("failed to insert provider vendor test row");

      await db.insert(providers).values([
        {
          id: winnerProviderId,
          name: `${KEY_PREFIX}-winner`,
          url: "https://winner.example/v1",
          key: "sk-winner",
          providerVendorId: vendor.id,
          providerType: "openai-compatible",
        },
        {
          id: loserProviderId,
          name: `${KEY_PREFIX}-loser`,
          url: "https://loser.example/v1",
          key: "sk-loser",
          providerVendorId: vendor.id,
          providerType: "openai-compatible",
        },
      ]);

      await insertMessageRequestRow({
        key: nextKey("provider-leaderboard-events"),
        userId,
        providerId: winnerProviderId,
        model: "gpt-5.6-sol",
        statusCode: 200,
        costUsd: "0.400000000000000",
        inputTokens: 80,
        outputTokens: 10,
        cacheCreationInputTokens: 20,
        cacheReadInputTokens: 0,
        providerChain: [{ id: winnerProviderId, name: "winner", reason: "hedge_winner" }],
        hedgeLosers: [
          {
            providerId: loserProviderId,
            providerName: "loser",
            attemptNumber: 2,
            costUsd: "0.100000000000000",
            billingStatus: "settled",
            inputTokens: 25,
            outputTokens: 5,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
        ],
        createdAt: new Date(),
      });

      const leaderboard = await findDailyProviderLeaderboard(undefined, true);
      const winner = leaderboard.find((entry) => entry.providerId === winnerProviderId);
      const loser = leaderboard.find((entry) => entry.providerId === loserProviderId);

      expect(winner).toMatchObject({
        totalRequests: 1,
        totalCost: 0.3,
        totalTokens: 110,
      });
      expect(winner?.modelStats).toEqual([
        expect.objectContaining({
          model: "gpt-5.6-sol",
          totalRequests: 1,
          totalCost: 0.3,
          totalTokens: 110,
        }),
      ]);
      expect(loser).toMatchObject({
        totalRequests: 1,
        totalCost: 0.1,
        totalTokens: 30,
        successRate: null,
        avgTtfbMs: 0,
        avgTokensPerSecond: 0,
      });
      expect(loser?.modelStats).toEqual([
        expect.objectContaining({
          model: "gpt-5.6-sol",
          totalRequests: 1,
          totalCost: 0.1,
          totalTokens: 30,
        }),
      ]);

      const providerStatistics = await getProviderStatistics();
      expect(providerStatistics.find((entry) => entry.id === winnerProviderId)).toMatchObject({
        today_cost: "0.300000000000000",
        today_calls: 1,
      });
      expect(providerStatistics.find((entry) => entry.id === loserProviderId)).toMatchObject({
        today_cost: "0.100000000000000",
        today_calls: 1,
      });

      const providerBreakdown = await getUserProviderBreakdown(userId);
      expect(
        providerBreakdown.find((entry) => entry.providerId === winnerProviderId)
      ).toMatchObject({
        requests: 1,
        cost: 0.3,
        inputTokens: 80,
        outputTokens: 10,
        cacheCreationTokens: 20,
      });
      expect(providerBreakdown.find((entry) => entry.providerId === loserProviderId)).toMatchObject(
        {
          requests: 1,
          cost: 0.1,
          inputTokens: 25,
          outputTokens: 5,
          cacheCreationTokens: 0,
        }
      );

      const loserModelBreakdown = await getUserModelBreakdown(userId, undefined, undefined, {
        providerId: loserProviderId,
      });
      expect(loserModelBreakdown).toEqual([
        expect.objectContaining({
          model: "gpt-5.6-sol",
          requests: 1,
          cost: 0.1,
          inputTokens: 25,
          outputTokens: 5,
        }),
      ]);
    });
  });

  describe("ledger-only mode", () => {
    test("isLedgerOnlyMode returns boolean", async () => {
      const result = await isLedgerOnlyMode();
      expect(typeof result).toBe("boolean");
    });

    test("log listing has ledger fallback path", async () => {
      const key = nextKey("ledger-only-logs");
      const userId = nextUserId();
      const providerId = nextProviderId();
      const requestId = await insertMessageRequestRow({
        key,
        userId,
        providerId,
        costUsd: "7.770000000000000",
      });

      await db.delete(messageRequest).where(eq(messageRequest.id, requestId));

      const [remaining] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(messageRequest);

      if ((remaining?.count ?? 0) > 0) {
        const source = await readFile(resolve(process.cwd(), "src/repository/message.ts"), "utf8");
        expect(source).toContain("if (!(await isLedgerOnlyMode()))");
        expect(source).toContain(".from(usageLedger)");
        return;
      }

      vi.resetModules();
      const { findUsageLogs: findUsageLogsFresh } = await import("@/repository/message");
      const result = await findUsageLogsFresh({
        userId,
        page: 1,
        pageSize: 20,
      });

      expect(result.logs.some((row) => row.id === requestId)).toBe(true);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });

    test("ledger-only listing retains GPT-5.6 billing provenance after request-log cleanup", async () => {
      const key = nextKey("ledger-only-gpt56-audit");
      const requestId = await insertMessageRequestRow({
        key,
        userId: nextUserId(),
        providerId: nextProviderId(),
        model: "gpt-5.6-sol",
        statusCode: 200,
        costUsd: GPT56_HEDGE_TOTAL,
        inputTokens: 0,
        observedInputTokens: 9016,
        outputTokens: 5,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        cacheCreationInputTokens: 9016,
        cacheReadInputTokens: 0,
        costBreakdown: GPT56_COST_BREAKDOWN,
        specialSettings: GPT56_SPECIAL_SETTINGS,
        hedgeLosers: GPT56_HEDGE_LOSERS,
      });

      await db.delete(messageRequest).where(eq(messageRequest.id, requestId));

      const result = await findReadonlyUsageLogsBatchForKey({ keyString: key, limit: 10 });
      const row = result.logs.find((candidate) => candidate.id === requestId);

      expect(row).toMatchObject({
        observedInputTokens: 9016,
        cacheWriteTokensReported: 0,
        cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        costBreakdown: GPT56_COST_BREAKDOWN,
        specialSettings: GPT56_SPECIAL_SETTINGS,
        hedgeLosers: GPT56_HEDGE_LOSERS,
      });
      expect(Number(row?.costUsd)).toBeCloseTo(
        Number(row?.costBreakdown?.total ?? 0) +
          (row?.hedgeLosers ?? []).reduce((sum, loser) => sum + Number(loser.costUsd), 0),
        15
      );
    });
  });

  test("findUsageLogs remains callable for compatibility", async () => {
    const key = nextKey("compat-call");
    const userId = nextUserId();
    const providerId = nextProviderId();

    await insertMessageRequestRow({
      key,
      userId,
      providerId,
      costUsd: "0.010000000000000",
    });

    const result = await findUsageLogs({ userId, page: 1, pageSize: 5 });
    expect(Array.isArray(result.logs)).toBe(true);
  });
});
