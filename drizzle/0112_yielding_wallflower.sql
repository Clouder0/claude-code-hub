DO $$
DECLARE
  existing_index oid := to_regclass('idx_usage_ledger_winner_hedge_losers');
  expected_index boolean;
BEGIN
  IF existing_index IS NULL THEN
    PERFORM 1 FROM "usage_ledger" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'idx_usage_ledger_winner_hedge_losers is missing on a non-empty usage_ledger; create it concurrently before running migrations';
    END IF;

    CREATE INDEX IF NOT EXISTS "idx_usage_ledger_winner_hedge_losers"
      ON "usage_ledger" USING btree ("final_provider_id", "created_at")
      WHERE "blocked_by" IS NULL AND "hedge_losers" IS NOT NULL;
  ELSE
    SELECT
      idx.indrelid = 'usage_ledger'::regclass
      AND idx.indisvalid
      AND idx.indisready
      AND NOT idx.indisunique
      AND access_method.amname = 'btree'
      AND idx.indnkeyatts = 2
      AND idx.indnatts = 2
      AND pg_get_indexdef(existing_index, 1, true) = 'final_provider_id'
      AND pg_get_indexdef(existing_index, 2, true) = 'created_at'
      AND pg_get_expr(idx.indpred, idx.indrelid) =
        '((blocked_by IS NULL) AND (hedge_losers IS NOT NULL))'
    INTO expected_index
    FROM pg_index AS idx
    JOIN pg_class AS index_relation ON index_relation.oid = idx.indexrelid
    JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
    WHERE idx.indexrelid = existing_index;

    IF expected_index IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'idx_usage_ledger_winner_hedge_losers exists but is invalid, not ready, or has an unexpected definition';
    END IF;
  END IF;
END
$$;
