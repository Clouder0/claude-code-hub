import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildProviderBillingEventsQuery,
  buildProviderBillingTotalQuery,
  type ProviderBillingEventQueryOptions,
  type ProviderBillingTotalQueryOptions,
} from "@/repository/_shared/provider-billing-events";

const INTEGER_TEXT_PATTERN = "^[0-9]+$";
const DECIMAL_TEXT_PATTERN = "^[+]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:[eE][+-]?[0-9]{1,3})?$";
const MAX_STORED_COST = "999999999999999.999999999999999";

function compile(options?: ProviderBillingEventQueryOptions) {
  return new PgDialect().sqlToQuery(buildProviderBillingEventsQuery(options));
}

function compileTotal(options: ProviderBillingTotalQueryOptions) {
  return new PgDialect().sqlToQuery(buildProviderBillingTotalQuery(options));
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

describe("buildProviderBillingEventsQuery", () => {
  it("binds endpoint, half-open time-window, user, and provider filters as parameters", () => {
    const startTime = new Date("2026-06-01T00:00:00.000Z");
    const endTime = new Date("2026-07-01T00:00:00.000Z");
    const query = compile({ providerId: 42, userId: 9, startTime, endTime });

    expect(query.params).toEqual([
      "/v1/messages/count_tokens",
      "/v1/responses/compact",
      startTime.toISOString(),
      endTime.toISOString(),
      9,
      42,
      "/v1/messages/count_tokens",
      "/v1/responses/compact",
      startTime.toISOString(),
      endTime.toISOString(),
      9,
      42,
      "/v1/messages/count_tokens",
      "/v1/responses/compact",
      startTime.toISOString(),
      endTime.toISOString(),
      9,
      '[{"providerId":42}]',
      '[{"providerId":"42"}]',
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
      DECIMAL_TEXT_PATTERN,
      MAX_STORED_COST,
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
      42,
    ]);
    expect(query.sql).toContain("ledger.created_at >= $3::timestamptz");
    expect(query.sql).toContain("ledger.created_at >= $9::timestamptz");
    expect(query.sql).toContain("ledger.created_at >= $15::timestamptz");
    expect(query.sql).toContain("ledger.created_at < $4::timestamptz");
    expect(query.sql).toContain("ledger.created_at < $10::timestamptz");
    expect(query.sql).toContain("ledger.created_at < $16::timestamptz");
    expect(query.sql).not.toContain("ledger.created_at <=");
    expect(query.sql).toContain("ledger.user_id = $5");
    expect(query.sql).toContain("ledger.final_provider_id = $6");
    expect(query.sql).toContain("ledger.user_id = $11");
    expect(query.sql).toContain("ledger.final_provider_id = $12");
    expect(query.sql).toContain("ledger.user_id = $17");
    expect(query.sql).toContain("ledger.hedge_losers @> $18::jsonb");
    expect(query.sql).toContain("ledger.hedge_losers @> $19::jsonb");
    expect(query.sql).toContain("WHERE provider_id = $28");
    expect(query.sql).not.toContain(startTime.toISOString());
    expect(query.sql).not.toContain('[{"providerId":42}]');
    expect(query.sql).not.toContain('[{"providerId":"42"}]');
  });

  it("composes caller-owned SQL time predicates and rejects ambiguous start boundaries", () => {
    const startTimeSql = sql`(SELECT last7_start FROM bounds)`;
    const ledgerCreatedAtCondition = sql`ledger.created_at < (SELECT period_end FROM bounds)`;
    const query = compile({ startTimeSql, ledgerCreatedAtCondition, userId: 9 });

    expect(normalizeSql(query.sql)).toContain(
      "ledger.created_at >= (SELECT last7_start FROM bounds) AND ledger.created_at < (SELECT period_end FROM bounds) AND ledger.user_id = $3"
    );
    expect(query.params.slice(0, 3)).toEqual([
      "/v1/messages/count_tokens",
      "/v1/responses/compact",
      9,
    ]);
    expect(() =>
      compile({
        startTime: new Date("2026-06-01T00:00:00.000Z"),
        startTimeSql,
      })
    ).toThrow("Provider billing events accept only one start-time boundary");
  });

  it("keeps only billable ledger rows and guards malformed loser JSON shapes", () => {
    const query = compile();
    const sql = normalizeSql(query.sql);

    expect(sql).toContain("ledger.blocked_by IS NULL");
    expect(sql).toContain("LOWER(REGEXP_REPLACE(ledger.endpoint, '/+$', '')) NOT IN ( $1, $2 )");
    expect(sql).toContain(
      "CASE WHEN jsonb_typeof(ledger.hedge_losers) = 'array' THEN ledger.hedge_losers ELSE '[]'::jsonb END"
    );
    expect(sql).toContain("WHERE jsonb_typeof(item.value) = 'object'");
    expect(query.params.slice(0, 2)).toEqual([
      "/v1/messages/count_tokens",
      "/v1/responses/compact",
    ]);
  });

  it("treats missing legacy billing status as settled and excludes every other status", () => {
    const { sql } = compile();

    expect(normalizeSql(sql)).toContain(
      "COALESCE(NULLIF(item.value ->> 'billingStatus', ''), 'settled') = 'settled'"
    );
  });

  it("guards invalid, out-of-range, and cast-overflow loser numbers before typed use", () => {
    const query = compile();
    const sql = normalizeSql(query.sql);

    expect(query.params.filter((value) => value === INTEGER_TEXT_PATTERN)).toHaveLength(6);
    expect(query.params.filter((value) => value === DECIMAL_TEXT_PATTERN)).toHaveLength(1);

    for (const field of ["providerId", "attemptNumber"]) {
      expect(sql).toContain(`WHEN LENGTH(value ->> '${field}') <= 10`);
      expect(sql).toContain(`AND (value ->> '${field}') ~`);
      expect(sql).toContain(`WHEN (value ->> '${field}')::numeric BETWEEN 1 AND 2147483647`);
      expect(sql).toContain(`THEN (value ->> '${field}')::numeric::integer`);
    }

    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
    ]) {
      expect(sql).toContain(`WHEN LENGTH(value ->> '${field}') <= 19`);
      expect(sql).toContain(`AND (value ->> '${field}') ~`);
      expect(sql).toContain(
        `WHEN (value ->> '${field}')::numeric BETWEEN 0 AND 9223372036854775807`
      );
      expect(sql).toContain(`THEN (value ->> '${field}')::numeric::bigint ELSE 0::bigint`);
    }

    expect(sql).toContain("WHEN LENGTH(value ->> 'costUsd') <= 64");
    expect(sql).toContain("AND (value ->> 'costUsd') ~");
    expect(sql).toMatch(/WHEN \(value ->> 'costUsd'\)::numeric BETWEEN 0 AND \$\d+::numeric/);
    expect(sql).toContain("THEN (value ->> 'costUsd')::numeric");
    expect(sql).toContain("cost_usd IS NOT NULL AND cost_usd >= 0");
    expect(query.params).toContain(MAX_STORED_COST);
  });

  it("deduplicates loser identities by first appearance and emits stable event IDs", () => {
    const { sql: rawSql } = compile();
    const sql = normalizeSql(rawSql);

    expect(sql).toContain(
      "SELECT DISTINCT ON (provider_match_kind, request_id, provider_id, attempt_number)"
    );
    expect(sql).toContain(
      "ORDER BY provider_match_kind, request_id, provider_id, attempt_number, ordinality ASC"
    );
    expect(sql).toContain("ledger.request_id::text || ':winner' AS billing_event_id");
    expect(sql).toContain(
      "request_id::text || ':hedge-loser:' || provider_id::text || ':' || attempt_number::text AS billing_event_id"
    );
  });

  it("subtracts deduplicated settled loser costs from the winner and clamps at zero", () => {
    const sql = normalizeSql(compile().sql);

    expect(sql).toContain(
      "SELECT request_id, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM settled_losers WHERE provider_match_kind IN ('all', 'winner') GROUP BY request_id"
    );
    expect(sql).toContain("LEFT JOIN loser_totals USING (request_id)");
    expect(sql).toContain(
      "GREATEST(COALESCE(ledger.cost_usd, 0) - COALESCE(loser_totals.cost_usd, 0), 0) AS cost_usd"
    );
  });

  it("splits provider winners and losers into indexable branches without double-emitting events", () => {
    const sql = normalizeSql(compile({ providerId: 42 }).sql);

    expect(sql).toContain("SELECT ledger.*, 'winner'::text AS provider_match_kind");
    expect(sql).toContain("AND ledger.final_provider_id = $3");
    expect(sql).toContain("'winner'::text AS provider_match_kind, item.value");
    expect(sql).toContain("AND ledger.final_provider_id = $6");
    expect(sql).toContain("AND ledger.hedge_losers IS NOT NULL UNION ALL");
    expect(sql).toContain("'loser'::text AS provider_match_kind, item.value");
    expect(sql).toContain("ledger.hedge_losers @> $9::jsonb");
    expect(sql).toContain("ledger.hedge_losers @> $10::jsonb");
    expect(sql).toContain("WHERE ledger.provider_match_kind IN ('all', 'winner')");
    expect(sql).toContain("WHERE provider_match_kind IN ('all', 'loser')");
  });

  it("omits optional filters when none are supplied", () => {
    const query = compile();

    expect(query.sql).not.toContain("ledger.created_at >=");
    expect(query.sql).not.toContain("ledger.created_at <");
    expect(query.sql).not.toContain("ledger.final_provider_id =");
    expect(query.sql).not.toContain("ledger.hedge_losers @>");
    expect(query.sql).not.toContain("ledger.user_id =");
    expect(query.sql).toContain("WHERE TRUE");
    expect(query.params).toEqual([
      "/v1/messages/count_tokens",
      "/v1/responses/compact",
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
      DECIMAL_TEXT_PATTERN,
      MAX_STORED_COST,
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
      INTEGER_TEXT_PATTERN,
    ]);
  });
});

describe("buildProviderBillingTotalQuery", () => {
  it("keeps the winner sum separate from sparse winner-loser and provider-loser sources", () => {
    const query = compileTotal({ providerId: 42 });
    const sql = normalizeSql(query.sql);

    expect(sql).toContain(
      "SELECT COALESCE(SUM(GREATEST(COALESCE(ledger.cost_usd, 0), 0)), 0) AS cost_usd FROM usage_ledger AS ledger"
    );
    expect(sql).toContain("AND ledger.final_provider_id = $3");
    expect(sql).toContain("AND ledger.final_provider_id = $6");
    expect(sql).toContain("AND ledger.hedge_losers IS NOT NULL UNION ALL");
    expect(sql).toContain("ledger.hedge_losers @> $9::jsonb");
    expect(sql).toContain("ledger.hedge_losers @> $10::jsonb");
    expect(sql).toContain("AND provider_id = $19");
  });

  it("clamps loser deductions per winner request before adding provider-loser cost", () => {
    const sql = normalizeSql(compileTotal({ providerId: 42 }).sql);

    expect(sql).toContain("MAX(request_cost_usd) AS request_cost_usd");
    expect(sql).toContain("SUM(cost_usd) AS loser_cost_usd");
    expect(sql).toContain("LEAST( GREATEST(COALESCE(request_cost_usd, 0), 0), loser_cost_usd )");
    expect(sql).toContain(
      "GREATEST(winner_total.cost_usd - winner_loser_adjustment.cost_usd, 0) + provider_loser_total.cost_usd AS total"
    );
  });
});
