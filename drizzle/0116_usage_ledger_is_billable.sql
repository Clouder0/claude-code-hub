-- 0116: usage_ledger.is_billable stored flag (additive; readers flip later).
--
-- LEDGER_BILLING_CONDITION's endpoint clause (LOWER(REGEXP_REPLACE(...)) NOT
-- IN (...)) is non-sargable: it cannot enter any index predicate and forces
-- a per-row regex plus heap fetch on every billing aggregate. is_billable
-- stores the identical decision once at write time so future partial
-- covering indexes (WHERE is_billable) can serve those aggregates index-only.
--
-- Semantics (must stay byte-equivalent to the read-side condition):
--   blocked_by IS NULL
--   AND (endpoint IS NULL
--        OR LOWER(REGEXP_REPLACE(endpoint, '/+$', '')) NOT IN
--            ('/v1/messages/count_tokens', '/v1/responses/compact'))
--
-- blocked_by/endpoint are immutable after insert EXCEPT the warmup
-- transition (blocked_by -> 'warmup'), which clears the flag in the same
-- UPDATE. Historical rows are backfilled online separately; the nullable
-- column plus unchanged readers keep this migration purely additive.
--
-- Idempotent ops-SQL (applied outside AUTO_MIGRATE; journal row backfilled).

ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS is_billable boolean NULL;

COMMENT ON COLUMN usage_ledger.is_billable IS
  'Stored billable decision mirroring the legacy blocked_by+endpoint billing condition; maintained by fn_upsert_usage_ledger, backfilled online';

CREATE OR REPLACE FUNCTION fn_upsert_usage_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_final_provider_id integer;
  v_is_success boolean;
  v_success_rate_outcome varchar;
BEGIN
  v_success_rate_outcome := fn_compute_message_request_success_rate_outcome(
    NEW.blocked_by,
    NEW.status_code,
    NEW.error_message,
    NEW.provider_chain
  );

  IF NEW.blocked_by = 'warmup' THEN
    -- If a ledger row already exists (row was originally non-warmup), mark it as warmup
    -- and sync the latest actual_response_model so audit stays consistent across tables.
    -- Warmup rows are never billable: clear the stored flag in the same transition.
    UPDATE usage_ledger
    SET blocked_by = 'warmup',
        success_rate_outcome = v_success_rate_outcome,
        actual_response_model = NEW.actual_response_model,
        is_billable = false
    WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF LOWER(REGEXP_REPLACE(COALESCE(NEW.endpoint, ''), '/+$', ''))
    IN ('/v1/messages/count_tokens', '/v1/responses/compact') THEN
    DELETE FROM usage_ledger WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  v_final_provider_id := fn_resolve_message_request_final_provider_id(
    NEW.provider_id,
    NEW.provider_chain
  );

  v_is_success := (NEW.error_message IS NULL OR NEW.error_message = '')
                  AND (NEW.status_code IS NULL OR NEW.status_code < 400);

  INSERT INTO usage_ledger (
    request_id, user_id, key, provider_id, final_provider_id,
    model, original_model, actual_response_model, endpoint, api_type, session_id,
    status_code, is_success, success_rate_outcome, blocked_by, is_billable,
    cost_usd, cost_multiplier, group_cost_multiplier,
    cost_breakdown,
    input_tokens, observed_input_tokens, output_tokens,
    cache_write_tokens_reported, cache_write_accounting,
    cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
    cache_ttl_applied, context_1m_applied, swap_cache_ttl_applied,
    special_settings, hedge_losers,
    duration_ms, ttfb_ms, client_ip, created_at
  ) VALUES (
    NEW.id, NEW.user_id, NEW.key, NEW.provider_id, v_final_provider_id,
    NEW.model, NEW.original_model, NEW.actual_response_model, NEW.endpoint, NEW.api_type, NEW.session_id,
    NEW.status_code, v_is_success, v_success_rate_outcome, NEW.blocked_by,
    (NEW.blocked_by IS NULL AND (
       NEW.endpoint IS NULL
       OR LOWER(REGEXP_REPLACE(NEW.endpoint, '/+$', '')) NOT IN
          ('/v1/messages/count_tokens', '/v1/responses/compact')
     )),
    NEW.cost_usd, NEW.cost_multiplier, NEW.group_cost_multiplier,
    NEW.cost_breakdown,
    NEW.input_tokens, NEW.observed_input_tokens, NEW.output_tokens,
    NEW.cache_write_tokens_reported, NEW.cache_write_accounting,
    NEW.cache_creation_input_tokens, NEW.cache_read_input_tokens,
    NEW.cache_creation_5m_input_tokens, NEW.cache_creation_1h_input_tokens,
    NEW.cache_ttl_applied, NEW.context_1m_applied, NEW.swap_cache_ttl_applied,
    NEW.special_settings, NEW.hedge_losers,
    NEW.duration_ms, NEW.ttfb_ms, NEW.client_ip, NEW.created_at
  )
  ON CONFLICT (request_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    key = EXCLUDED.key,
    provider_id = EXCLUDED.provider_id,
    final_provider_id = EXCLUDED.final_provider_id,
    model = EXCLUDED.model,
    original_model = EXCLUDED.original_model,
    actual_response_model = EXCLUDED.actual_response_model,
    endpoint = EXCLUDED.endpoint,
    api_type = EXCLUDED.api_type,
    session_id = EXCLUDED.session_id,
    status_code = EXCLUDED.status_code,
    is_success = EXCLUDED.is_success,
    success_rate_outcome = EXCLUDED.success_rate_outcome,
    blocked_by = EXCLUDED.blocked_by,
    is_billable = EXCLUDED.is_billable,
    cost_usd = EXCLUDED.cost_usd,
    cost_multiplier = EXCLUDED.cost_multiplier,
    group_cost_multiplier = EXCLUDED.group_cost_multiplier,
    cost_breakdown = EXCLUDED.cost_breakdown,
    input_tokens = EXCLUDED.input_tokens,
    observed_input_tokens = EXCLUDED.observed_input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_write_tokens_reported = EXCLUDED.cache_write_tokens_reported,
    cache_write_accounting = EXCLUDED.cache_write_accounting,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
    cache_creation_5m_input_tokens = EXCLUDED.cache_creation_5m_input_tokens,
    cache_creation_1h_input_tokens = EXCLUDED.cache_creation_1h_input_tokens,
    cache_ttl_applied = EXCLUDED.cache_ttl_applied,
    context_1m_applied = EXCLUDED.context_1m_applied,
    swap_cache_ttl_applied = EXCLUDED.swap_cache_ttl_applied,
    special_settings = EXCLUDED.special_settings,
    hedge_losers = EXCLUDED.hedge_losers,
    duration_ms = EXCLUDED.duration_ms,
    ttfb_ms = EXCLUDED.ttfb_ms,
    client_ip = EXCLUDED.client_ip;
    -- created_at deliberately NOT updated on conflict: it represents the
    -- original insert time of the ledger row, which is immutable by design.

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_upsert_usage_ledger failed for request_id=%: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
