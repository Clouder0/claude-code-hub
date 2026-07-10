DO $$
DECLARE
  existing_index oid := to_regclass('idx_usage_ledger_hedge_losers_gin');
  expected_index boolean;
BEGIN
  IF existing_index IS NULL THEN
    PERFORM 1 FROM "usage_ledger" LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'idx_usage_ledger_hedge_losers_gin is missing on a non-empty usage_ledger; create it concurrently before running migrations';
    END IF;

    CREATE INDEX IF NOT EXISTS "idx_usage_ledger_hedge_losers_gin"
      ON "usage_ledger" USING gin ("hedge_losers" jsonb_path_ops);
  ELSE
    SELECT
      idx.indrelid = 'usage_ledger'::regclass
      AND idx.indisvalid
      AND idx.indisready
      AND NOT idx.indisunique
      AND access_method.amname = 'gin'
      AND idx.indnkeyatts = 1
      AND idx.indnatts = 1
      AND pg_get_indexdef(existing_index, 1, true) = 'hedge_losers'
      AND operator_class.opcname = 'jsonb_path_ops'
      AND idx.indpred IS NULL
    INTO expected_index
    FROM pg_index AS idx
    JOIN pg_class AS index_relation ON index_relation.oid = idx.indexrelid
    JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
    JOIN pg_opclass AS operator_class ON operator_class.oid = idx.indclass[0]
    WHERE idx.indexrelid = existing_index;

    IF expected_index IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION
        'idx_usage_ledger_hedge_losers_gin exists but is invalid, not ready, or has an unexpected definition';
    END IF;
  END IF;
END
$$;
