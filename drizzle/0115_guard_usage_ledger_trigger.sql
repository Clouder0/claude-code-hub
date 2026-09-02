-- Guard the usage_ledger upsert trigger against ledger-irrelevant UPDATEs.
--
-- Before this migration the trigger fired on EVERY message_request row change
-- with no WHEN clause: a soft-delete (deleted_at only), an updated_at touch, or
-- an error_stack append each rewrote the full 37-column usage_ledger row across
-- its 14 indexes. PostgreSQL WHEN clauses cannot reference TG_OP, so the single
-- INSERT-or-UPDATE trigger is split in two: an unguarded INSERT trigger (the
-- ledger row must exist from birth, including warmup rows and later
-- soft-deleted requests) and an UPDATE trigger guarded on ledger-consumed
-- columns actually changing.
--
-- Column set = every message_request column fn_upsert_usage_ledger() reads from
-- NEW, minus the immutable id/created_at. Deliberately excluded (ledger never
-- reads them): updated_at, deleted_at, error_stack, error_cause, messages_count,
-- user_agent, request_sequence, success_rate_outcome (BEFORE-trigger computed
-- from guarded inputs).
DROP TRIGGER IF EXISTS trg_upsert_usage_ledger ON message_request;--> statement-breakpoint
CREATE TRIGGER trg_upsert_usage_ledger
AFTER INSERT ON message_request
FOR EACH ROW
EXECUTE FUNCTION fn_upsert_usage_ledger();--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_upsert_usage_ledger_on_update ON message_request;--> statement-breakpoint
CREATE TRIGGER trg_upsert_usage_ledger_on_update
AFTER UPDATE ON message_request
FOR EACH ROW
WHEN (
  NEW.user_id IS DISTINCT FROM OLD.user_id
  OR NEW.key IS DISTINCT FROM OLD.key
  OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
  OR NEW.model IS DISTINCT FROM OLD.model
  OR NEW.original_model IS DISTINCT FROM OLD.original_model
  OR NEW.actual_response_model IS DISTINCT FROM OLD.actual_response_model
  OR NEW.endpoint IS DISTINCT FROM OLD.endpoint
  OR NEW.api_type IS DISTINCT FROM OLD.api_type
  OR NEW.session_id IS DISTINCT FROM OLD.session_id
  OR NEW.status_code IS DISTINCT FROM OLD.status_code
  OR NEW.blocked_by IS DISTINCT FROM OLD.blocked_by
  OR NEW.error_message IS DISTINCT FROM OLD.error_message
  OR NEW.provider_chain IS DISTINCT FROM OLD.provider_chain
  OR NEW.cost_usd IS DISTINCT FROM OLD.cost_usd
  OR NEW.cost_multiplier IS DISTINCT FROM OLD.cost_multiplier
  OR NEW.group_cost_multiplier IS DISTINCT FROM OLD.group_cost_multiplier
  OR NEW.cost_breakdown IS DISTINCT FROM OLD.cost_breakdown
  OR NEW.input_tokens IS DISTINCT FROM OLD.input_tokens
  OR NEW.observed_input_tokens IS DISTINCT FROM OLD.observed_input_tokens
  OR NEW.output_tokens IS DISTINCT FROM OLD.output_tokens
  OR NEW.cache_write_tokens_reported IS DISTINCT FROM OLD.cache_write_tokens_reported
  OR NEW.cache_write_accounting IS DISTINCT FROM OLD.cache_write_accounting
  OR NEW.cache_creation_input_tokens IS DISTINCT FROM OLD.cache_creation_input_tokens
  OR NEW.cache_read_input_tokens IS DISTINCT FROM OLD.cache_read_input_tokens
  OR NEW.cache_creation_5m_input_tokens IS DISTINCT FROM OLD.cache_creation_5m_input_tokens
  OR NEW.cache_creation_1h_input_tokens IS DISTINCT FROM OLD.cache_creation_1h_input_tokens
  OR NEW.cache_ttl_applied IS DISTINCT FROM OLD.cache_ttl_applied
  OR NEW.context_1m_applied IS DISTINCT FROM OLD.context_1m_applied
  OR NEW.swap_cache_ttl_applied IS DISTINCT FROM OLD.swap_cache_ttl_applied
  OR NEW.special_settings IS DISTINCT FROM OLD.special_settings
  OR NEW.hedge_losers IS DISTINCT FROM OLD.hedge_losers
  OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
  OR NEW.ttfb_ms IS DISTINCT FROM OLD.ttfb_ms
  OR NEW.client_ip IS DISTINCT FROM OLD.client_ip
)
EXECUTE FUNCTION fn_upsert_usage_ledger();
