import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/drizzle/db";

if (!process.env.DATABASE_URL && process.env.DSN) {
  process.env.DATABASE_URL = process.env.DSN;
}

function requireSingleRow<T>(result: Iterable<unknown>): T {
  const row = Array.from(result)[0] as T | undefined;
  if (!row) {
    throw new Error("expected query to return one row");
  }
  return row;
}

describe.skipIf(!process.env.DATABASE_URL)("Ledger data consistency", () => {
  it("warmup rows never appear in usage_ledger", async () => {
    const result = await db.execute(sql`
      SELECT COUNT(*)::integer AS warmup_count
      FROM usage_ledger
      WHERE blocked_by = 'warmup'
    `);

    const row = requireSingleRow<{ warmup_count: number }>(result);
    expect(row.warmup_count).toBe(0);
  });

  it("all non-warmup message_request rows have ledger entries", async () => {
    const result = await db.execute(sql`
      SELECT
        (
          SELECT COUNT(*)::integer
          FROM message_request
          WHERE blocked_by IS DISTINCT FROM 'warmup'
        ) AS message_request_count,
        (
          SELECT COUNT(*)::integer
          FROM usage_ledger
        ) AS usage_ledger_count
    `);

    const row = requireSingleRow<{
      message_request_count: number;
      usage_ledger_count: number;
    }>(result);

    expect(row.usage_ledger_count).toBe(row.message_request_count);
  });

  it("cost aggregation matches between tables", async () => {
    const result = await db.execute(sql`
      WITH bounds AS (
        SELECT
          COALESCE(MIN(created_at), CURRENT_TIMESTAMP) AS start_at,
          COALESCE(MAX(created_at) + INTERVAL '1 millisecond', CURRENT_TIMESTAMP) AS end_at
        FROM message_request
        WHERE blocked_by IS DISTINCT FROM 'warmup'
      ),
      message_sum AS (
        SELECT COALESCE(SUM(mr.cost_usd), 0) AS total_cost
        FROM message_request mr
        CROSS JOIN bounds b
        WHERE mr.blocked_by IS DISTINCT FROM 'warmup'
          AND mr.created_at >= b.start_at
          AND mr.created_at < b.end_at
      ),
      ledger_sum AS (
        SELECT COALESCE(SUM(ul.cost_usd), 0) AS total_cost
        FROM usage_ledger ul
        CROSS JOIN bounds b
        WHERE ul.created_at >= b.start_at
          AND ul.created_at < b.end_at
      )
      SELECT
        message_sum.total_cost::text AS message_total_cost,
        ledger_sum.total_cost::text AS ledger_total_cost,
        (message_sum.total_cost = ledger_sum.total_cost) AS is_equal
      FROM message_sum, ledger_sum
    `);

    const row = requireSingleRow<{
      message_total_cost: string;
      ledger_total_cost: string;
      is_equal: boolean;
    }>(result);

    expect(row.is_equal).toBe(true);
  });

  it("GPT-5.6 billing provenance matches between request rows and ledger rows", async () => {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::integer AS checked_count,
        COUNT(*) FILTER (
          WHERE mr.observed_input_tokens IS DISTINCT FROM ul.observed_input_tokens
            OR mr.cache_write_tokens_reported IS DISTINCT FROM ul.cache_write_tokens_reported
            OR mr.cache_write_accounting IS DISTINCT FROM ul.cache_write_accounting
            OR mr.cost_breakdown IS DISTINCT FROM ul.cost_breakdown
            OR mr.special_settings IS DISTINCT FROM ul.special_settings
            OR mr.hedge_losers IS DISTINCT FROM ul.hedge_losers
        )::integer AS mismatch_count,
        COUNT(*) FILTER (
          WHERE mr.observed_input_tokens IS DISTINCT FROM ul.observed_input_tokens
        )::integer AS observed_input_mismatch_count,
        COUNT(*) FILTER (
          WHERE mr.cache_write_tokens_reported IS DISTINCT FROM ul.cache_write_tokens_reported
        )::integer AS reported_write_mismatch_count,
        COUNT(*) FILTER (
          WHERE mr.cache_write_accounting IS DISTINCT FROM ul.cache_write_accounting
        )::integer AS write_accounting_mismatch_count,
        COUNT(*) FILTER (
          WHERE mr.cost_breakdown IS DISTINCT FROM ul.cost_breakdown
        )::integer AS cost_breakdown_mismatch_count,
        COUNT(*) FILTER (
          WHERE mr.special_settings IS DISTINCT FROM ul.special_settings
        )::integer AS special_settings_mismatch_count,
        COUNT(*) FILTER (
          WHERE mr.hedge_losers IS DISTINCT FROM ul.hedge_losers
        )::integer AS hedge_losers_mismatch_count
      FROM message_request mr
      JOIN usage_ledger ul ON ul.request_id = mr.id
      WHERE mr.blocked_by IS DISTINCT FROM 'warmup'
    `);

    const row = requireSingleRow<{
      checked_count: number;
      mismatch_count: number;
      observed_input_mismatch_count: number;
      reported_write_mismatch_count: number;
      write_accounting_mismatch_count: number;
      cost_breakdown_mismatch_count: number;
      special_settings_mismatch_count: number;
      hedge_losers_mismatch_count: number;
    }>(result);

    expect(row).toMatchObject({
      mismatch_count: 0,
      observed_input_mismatch_count: 0,
      reported_write_mismatch_count: 0,
      write_accounting_mismatch_count: 0,
      cost_breakdown_mismatch_count: 0,
      special_settings_mismatch_count: 0,
      hedge_losers_mismatch_count: 0,
    });
  });

  it("provider attribution uses the final successful routing-chain node", async () => {
    const result = await db.execute(sql`
      WITH candidates AS (
        SELECT
          mr.id,
          mr.provider_id,
          fn_resolve_message_request_final_provider_id(
            mr.provider_id,
            mr.provider_chain
          ) AS expected_final_provider_id
        FROM message_request mr
        WHERE mr.blocked_by IS DISTINCT FROM 'warmup'
      )
      SELECT
        COUNT(*)::integer AS candidate_count,
        COUNT(*) FILTER (
          WHERE ul.final_provider_id IS DISTINCT FROM c.expected_final_provider_id
        )::integer AS wrong_final_provider_count,
        COUNT(*) FILTER (
          WHERE c.expected_final_provider_id = c.provider_id
            AND ul.final_provider_id IS DISTINCT FROM c.provider_id
        )::integer AS wrong_fallback_provider_count
      FROM candidates c
      JOIN usage_ledger ul ON ul.request_id = c.id
    `);

    const row = requireSingleRow<{
      candidate_count: number;
      wrong_final_provider_count: number;
      wrong_fallback_provider_count: number;
    }>(result);

    expect(row.wrong_final_provider_count).toBe(0);
    expect(row.wrong_fallback_provider_count).toBe(0);
  });

  it("is_success matches both error state and HTTP status", async () => {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::integer AS checked_count,
        COUNT(*) FILTER (
          WHERE ul.is_success IS DISTINCT FROM (
            (mr.error_message IS NULL OR mr.error_message = '')
            AND (mr.status_code IS NULL OR mr.status_code < 400)
          )
        )::integer AS mismatch_count
      FROM message_request mr
      JOIN usage_ledger ul ON ul.request_id = mr.id
      WHERE mr.blocked_by IS DISTINCT FROM 'warmup'
    `);

    const row = requireSingleRow<{ checked_count: number; mismatch_count: number }>(result);
    expect(row.mismatch_count).toBe(0);
  });
});
