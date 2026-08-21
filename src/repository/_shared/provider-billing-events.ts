import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { NON_BILLING_ENDPOINTS } from "@/lib/utils/performance-formatter";

export interface ProviderBillingEventQueryOptions {
  providerId?: number;
  userId?: number;
  startTime?: Date;
  startTimeSql?: SQL;
  endTime?: Date;
  ledgerCreatedAtCondition?: SQL;
}

export type ProviderBillingTotalQueryOptions = Omit<
  ProviderBillingEventQueryOptions,
  "providerId"
> & {
  providerId: number;
};

const DECIMAL_TEXT_PATTERN = "^[+]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:[eE][+-]?[0-9]{1,3})?$";
const INTEGER_TEXT_PATTERN = "^[0-9]+$";
const MAX_STORED_COST = "999999999999999.999999999999999";

function joinConditions(conditions: SQL[]): SQL {
  return sql.join(conditions, sql` AND `);
}

// Narrow projection consumed by every aggregate surface (winner branch, loser
// expansion, and outer cost/token/success aggregates). `ledger.*` previously
// dragged cost_breakdown / special_settings jsonb and a dozen unused columns
// through the CTE materialization. Extend this list only after checking every
// embedding surface listed on buildProviderBillingEventsQuery.
const LEDGER_EVENT_ROW_COLUMNS = sql`
  ledger.request_id,
  ledger.created_at,
  ledger.user_id,
  ledger.key,
  ledger.model,
  ledger.original_model,
  ledger.success_rate_outcome,
  ledger.ttfb_ms,
  ledger.duration_ms,
  ledger.cost_usd,
  ledger.input_tokens,
  ledger.output_tokens,
  ledger.cache_creation_input_tokens,
  ledger.cache_read_input_tokens,
  ledger.final_provider_id,
  ledger.hedge_losers
`;

type ProviderMatchKind = "all" | "winner" | "loser";

export function buildRawLoserCandidates(
  source: SQL,
  providerMatchKind: ProviderMatchKind,
  sourceConditions: SQL[] = []
): SQL {
  const matchKind =
    providerMatchKind === "all"
      ? sql`'all'::text`
      : providerMatchKind === "winner"
        ? sql`'winner'::text`
        : sql`'loser'::text`;
  const sourceFilter =
    sourceConditions.length > 0 ? sql`AND ${joinConditions(sourceConditions)}` : sql``;

  return sql`
    SELECT
      ledger.request_id,
      ledger.created_at,
      ledger.user_id,
      ledger.key AS key_value,
      ledger.model,
      ledger.original_model,
      ledger.success_rate_outcome,
      ledger.ttfb_ms,
      ledger.duration_ms,
      ledger.cost_usd AS request_cost_usd,
      ${matchKind} AS provider_match_kind,
      item.value,
      item.ordinality
    FROM ${source}
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(ledger.hedge_losers) = 'array' THEN ledger.hedge_losers
        ELSE '[]'::jsonb
      END
    ) WITH ORDINALITY AS item(value, ordinality)
    WHERE jsonb_typeof(item.value) = 'object'
      AND COALESCE(NULLIF(item.value ->> 'billingStatus', ''), 'settled') = 'settled'
      ${sourceFilter}
  `;
}

export function buildSettledLoserCtes(rawLoserCandidates: SQL): SQL {
  return sql`
    raw_loser_candidates AS (
      ${rawLoserCandidates}
    ),
    parsed_loser_candidates AS (
      SELECT
        request_id,
        created_at,
        user_id,
        key_value,
        model,
        original_model,
        success_rate_outcome,
        ttfb_ms,
        duration_ms,
        request_cost_usd,
        provider_match_kind,
        ordinality,
        CASE
          WHEN LENGTH(value ->> 'providerId') <= 10
            AND (value ->> 'providerId') ~ ${INTEGER_TEXT_PATTERN}
          THEN CASE
            WHEN (value ->> 'providerId')::numeric BETWEEN 1 AND 2147483647
            THEN (value ->> 'providerId')::numeric::integer
          END
        END AS provider_id,
        CASE
          WHEN LENGTH(value ->> 'attemptNumber') <= 10
            AND (value ->> 'attemptNumber') ~ ${INTEGER_TEXT_PATTERN}
          THEN CASE
            WHEN (value ->> 'attemptNumber')::numeric BETWEEN 1 AND 2147483647
            THEN (value ->> 'attemptNumber')::numeric::integer
          END
        END AS attempt_number,
        CASE
          WHEN LENGTH(value ->> 'costUsd') <= 64
            AND (value ->> 'costUsd') ~ ${DECIMAL_TEXT_PATTERN}
          THEN CASE
            WHEN (value ->> 'costUsd')::numeric BETWEEN 0 AND ${MAX_STORED_COST}::numeric
            THEN (value ->> 'costUsd')::numeric
          END
        END AS cost_usd,
        CASE
          WHEN LENGTH(value ->> 'inputTokens') <= 19
            AND (value ->> 'inputTokens') ~ ${INTEGER_TEXT_PATTERN}
          THEN CASE
            WHEN (value ->> 'inputTokens')::numeric BETWEEN 0 AND 9223372036854775807
            THEN (value ->> 'inputTokens')::numeric::bigint
            ELSE 0::bigint
          END
          ELSE 0::bigint
        END AS input_tokens,
        CASE
          WHEN LENGTH(value ->> 'outputTokens') <= 19
            AND (value ->> 'outputTokens') ~ ${INTEGER_TEXT_PATTERN}
          THEN CASE
            WHEN (value ->> 'outputTokens')::numeric BETWEEN 0 AND 9223372036854775807
            THEN (value ->> 'outputTokens')::numeric::bigint
            ELSE 0::bigint
          END
          ELSE 0::bigint
        END AS output_tokens,
        CASE
          WHEN LENGTH(value ->> 'cacheCreationInputTokens') <= 19
            AND (value ->> 'cacheCreationInputTokens') ~ ${INTEGER_TEXT_PATTERN}
          THEN CASE
            WHEN (value ->> 'cacheCreationInputTokens')::numeric BETWEEN 0 AND 9223372036854775807
            THEN (value ->> 'cacheCreationInputTokens')::numeric::bigint
            ELSE 0::bigint
          END
          ELSE 0::bigint
        END AS cache_creation_input_tokens,
        CASE
          WHEN LENGTH(value ->> 'cacheReadInputTokens') <= 19
            AND (value ->> 'cacheReadInputTokens') ~ ${INTEGER_TEXT_PATTERN}
          THEN CASE
            WHEN (value ->> 'cacheReadInputTokens')::numeric BETWEEN 0 AND 9223372036854775807
            THEN (value ->> 'cacheReadInputTokens')::numeric::bigint
            ELSE 0::bigint
          END
          ELSE 0::bigint
        END AS cache_read_input_tokens
      FROM raw_loser_candidates
    ),
    settled_losers AS (
      SELECT DISTINCT ON (provider_match_kind, request_id, provider_id, attempt_number)
        request_id,
        created_at,
        user_id,
        key_value,
        model,
        original_model,
        success_rate_outcome,
        ttfb_ms,
        duration_ms,
        request_cost_usd,
        provider_match_kind,
        provider_id,
        attempt_number,
        cost_usd,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens
      FROM parsed_loser_candidates
      WHERE provider_id IS NOT NULL
        AND attempt_number IS NOT NULL
        AND cost_usd IS NOT NULL
        AND cost_usd >= 0
      ORDER BY provider_match_kind, request_id, provider_id, attempt_number, ordinality ASC
    )
  `;
}

function buildLedgerRowConditions(options: ProviderBillingEventQueryOptions): SQL[] {
  if (options.startTime && options.startTimeSql) {
    throw new Error("Provider billing events accept only one start-time boundary");
  }

  const conditions: SQL[] = [
    sql`ledger.blocked_by IS NULL`,
    sql`(
      ledger.endpoint IS NULL
      OR LOWER(REGEXP_REPLACE(ledger.endpoint, '/+$', '')) NOT IN (
        ${sql.join(
          NON_BILLING_ENDPOINTS.map((endpoint) => sql`${endpoint}`),
          sql`, `
        )}
      )
    )`,
  ];

  if (options.startTime) {
    conditions.push(sql`ledger.created_at >= ${options.startTime.toISOString()}::timestamptz`);
  }
  if (options.startTimeSql) {
    conditions.push(sql`ledger.created_at >= ${options.startTimeSql}`);
  }
  if (options.endTime) {
    conditions.push(sql`ledger.created_at < ${options.endTime.toISOString()}::timestamptz`);
  }
  if (options.ledgerCreatedAtCondition) {
    conditions.push(options.ledgerCreatedAtCondition);
  }
  if (options.userId !== undefined) {
    conditions.push(sql`ledger.user_id = ${options.userId}`);
  }

  return conditions;
}

/**
 * Expand immutable request ledger rows into independently attributable provider costs.
 * The returned query owns its CTEs and can be embedded as a derived table by every cost surface.
 */
export function buildProviderBillingEventsQuery(
  options: ProviderBillingEventQueryOptions = {}
): SQL {
  const rowConditions = buildLedgerRowConditions(options);
  const numericProviderNeedle =
    options.providerId === undefined
      ? undefined
      : JSON.stringify([{ providerId: options.providerId }]);
  const stringProviderNeedle =
    options.providerId === undefined
      ? undefined
      : JSON.stringify([{ providerId: String(options.providerId) }]);

  const ledgerRows = (() => {
    if (options.providerId === undefined) {
      return sql`
        SELECT ${LEDGER_EVENT_ROW_COLUMNS}, 'all'::text AS provider_match_kind
        FROM usage_ledger AS ledger
        WHERE ${joinConditions(rowConditions)}
      `;
    }

    return sql`
      SELECT ${LEDGER_EVENT_ROW_COLUMNS}, 'winner'::text AS provider_match_kind
      FROM usage_ledger AS ledger
      WHERE ${joinConditions(rowConditions)}
        AND ledger.final_provider_id = ${options.providerId}
    `;
  })();

  const rawLoserCandidates = (() => {
    if (
      options.providerId === undefined ||
      numericProviderNeedle === undefined ||
      stringProviderNeedle === undefined
    ) {
      return buildRawLoserCandidates(sql`ledger_rows AS ledger`, "all");
    }

    // Winner totals need every settled loser on winner rows, while loser events only need rows
    // containing the requested provider. Keeping these sources independent lets PostgreSQL use a
    // sparse winner-with-losers btree and the hedge-loser GIN index without materializing the
    // provider's full ledger history.
    return sql`
      ${buildRawLoserCandidates(sql`usage_ledger AS ledger`, "winner", [
        ...rowConditions,
        sql`ledger.final_provider_id = ${options.providerId}`,
        sql`ledger.hedge_losers IS NOT NULL`,
      ])}

      UNION ALL

      ${buildRawLoserCandidates(sql`usage_ledger AS ledger`, "loser", [
        ...rowConditions,
        sql`jsonb_typeof(ledger.hedge_losers) = 'array'`,
        sql`(
          ledger.hedge_losers @> ${numericProviderNeedle}::jsonb
          OR ledger.hedge_losers @> ${stringProviderNeedle}::jsonb
        )`,
      ])}
    `;
  })();

  const eventProviderCondition =
    options.providerId === undefined ? sql`TRUE` : sql`provider_id = ${options.providerId}`;

  return sql`
    WITH ledger_rows AS (
      ${ledgerRows}
    ),
    ${buildSettledLoserCtes(rawLoserCandidates)},
    loser_totals AS (
      SELECT request_id, COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM settled_losers
      WHERE provider_match_kind IN ('all', 'winner')
      GROUP BY request_id
    ),
    provider_billing_events AS (
      SELECT
        ledger.request_id::text || ':winner' AS billing_event_id,
        ledger.request_id,
        ledger.final_provider_id AS provider_id,
        NULL::integer AS attempt_number,
        ledger.created_at,
        ledger.user_id,
        ledger.key AS key_value,
        ledger.model,
        ledger.original_model,
        ledger.success_rate_outcome,
        ledger.ttfb_ms,
        ledger.duration_ms,
        GREATEST(COALESCE(ledger.cost_usd, 0) - COALESCE(loser_totals.cost_usd, 0), 0)
          AS cost_usd,
        COALESCE(ledger.input_tokens, 0) AS input_tokens,
        COALESCE(ledger.output_tokens, 0) AS output_tokens,
        COALESCE(ledger.cache_creation_input_tokens, 0) AS cache_creation_input_tokens,
        COALESCE(ledger.cache_read_input_tokens, 0) AS cache_read_input_tokens,
        'winner'::text AS kind
      FROM ledger_rows AS ledger
      LEFT JOIN loser_totals USING (request_id)
      WHERE ledger.provider_match_kind IN ('all', 'winner')

      UNION ALL

      SELECT
        request_id::text || ':hedge-loser:' || provider_id::text || ':' || attempt_number::text
          AS billing_event_id,
        request_id,
        provider_id,
        attempt_number,
        created_at,
        user_id,
        key_value,
        model,
        original_model,
        NULL::varchar AS success_rate_outcome,
        NULL::integer AS ttfb_ms,
        NULL::integer AS duration_ms,
        cost_usd,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        'hedge_loser'::text AS kind
      FROM settled_losers
      WHERE provider_match_kind IN ('all', 'loser')
    )
    SELECT *
    FROM provider_billing_events
    WHERE ${eventProviderCondition}
  `;
}

/**
 * Aggregate a provider's winner and hedge-loser costs without materializing detailed event rows.
 * Winner totals stay index-only; JSON expansion is restricted to the sparse rows selected by the
 * winner-with-losers partial index and the provider-specific hedge-loser GIN lookup.
 */
export function buildProviderBillingTotalQuery(options: ProviderBillingTotalQueryOptions): SQL {
  const rowConditions = buildLedgerRowConditions(options);
  const numericProviderNeedle = JSON.stringify([{ providerId: options.providerId }]);
  const stringProviderNeedle = JSON.stringify([{ providerId: String(options.providerId) }]);
  const rawLoserCandidates = sql`
    ${buildRawLoserCandidates(sql`usage_ledger AS ledger`, "winner", [
      ...rowConditions,
      sql`ledger.final_provider_id = ${options.providerId}`,
      sql`ledger.hedge_losers IS NOT NULL`,
    ])}

    UNION ALL

    ${buildRawLoserCandidates(sql`usage_ledger AS ledger`, "loser", [
      ...rowConditions,
      sql`jsonb_typeof(ledger.hedge_losers) = 'array'`,
      sql`(
        ledger.hedge_losers @> ${numericProviderNeedle}::jsonb
        OR ledger.hedge_losers @> ${stringProviderNeedle}::jsonb
      )`,
    ])}
  `;

  return sql`
    WITH winner_total AS (
      SELECT COALESCE(SUM(GREATEST(COALESCE(ledger.cost_usd, 0), 0)), 0) AS cost_usd
      FROM usage_ledger AS ledger
      WHERE ${joinConditions(rowConditions)}
        AND ledger.final_provider_id = ${options.providerId}
    ),
    ${buildSettledLoserCtes(rawLoserCandidates)},
    winner_loser_adjustment AS (
      SELECT COALESCE(
        SUM(
          LEAST(
            GREATEST(COALESCE(request_cost_usd, 0), 0),
            loser_cost_usd
          )
        ),
        0
      ) AS cost_usd
      FROM (
        SELECT
          request_id,
          MAX(request_cost_usd) AS request_cost_usd,
          SUM(cost_usd) AS loser_cost_usd
        FROM settled_losers
        WHERE provider_match_kind = 'winner'
        GROUP BY request_id
      ) AS winner_loser_totals
    ),
    provider_loser_total AS (
      SELECT COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM settled_losers
      WHERE provider_match_kind = 'loser'
        AND provider_id = ${options.providerId}
    )
    SELECT
      GREATEST(winner_total.cost_usd - winner_loser_adjustment.cost_usd, 0)
        + provider_loser_total.cost_usd AS total
    FROM winner_total, winner_loser_adjustment, provider_loser_total
  `;
}
