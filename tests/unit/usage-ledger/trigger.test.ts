import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "src/lib/ledger-backfill/trigger.sql"), "utf-8");
const migration0109Sql = readFileSync(
  resolve(process.cwd(), "drizzle/0109_left_shooting_star.sql"),
  "utf-8"
);
const migrationSql = readFileSync(resolve(process.cwd(), "drizzle/0110_brief_synch.sql"), "utf-8");
const migration0116Sql = readFileSync(
  resolve(process.cwd(), "drizzle/0116_usage_ledger_is_billable.sql"),
  "utf-8"
);

function extractFinalProviderResolver(source: string): string {
  const match = source.match(
    /CREATE OR REPLACE FUNCTION fn_resolve_message_request_final_provider_id\([\s\S]*?\$\$ LANGUAGE sql IMMUTABLE;/
  );
  if (!match) {
    throw new Error("fn_resolve_message_request_final_provider_id not found");
  }
  return match[0];
}

function extractUpsertFunction(source: string): string {
  const match = source.match(
    /CREATE OR REPLACE FUNCTION fn_upsert_usage_ledger\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/
  );
  if (!match) {
    throw new Error("fn_upsert_usage_ledger not found");
  }
  return match[0];
}

describe("fn_upsert_usage_ledger trigger SQL", () => {
  it("defines shared request outcome helpers", () => {
    expect(sql).toContain("fn_compute_message_request_success_rate_outcome");
    expect(sql).toContain("fn_is_message_request_finalized");
  });

  it("contains warmup exclusion check", () => {
    expect(sql).toContain("blocked_by = 'warmup'");
  });

  it("contains ON CONFLICT UPSERT", () => {
    expect(sql).toContain("ON CONFLICT (request_id) DO UPDATE");
  });

  it("contains EXCEPTION error handling", () => {
    expect(sql).toContain("EXCEPTION WHEN OTHERS");
  });

  it("pre-validates provider_chain before extraction", () => {
    expect(sql).toContain("jsonb_typeof");
  });

  it("resolves the final provider from the last successful routing-chain node", () => {
    const resolver = extractFinalProviderResolver(sql);
    expect(resolver).toContain("WITH ORDINALITY");
    expect(resolver).toContain("ORDER BY item.ordinality DESC");
    expect(resolver).toContain("'hedge_winner'");
    expect(resolver).toContain("'request_success'");
    expect(resolver).toContain("'retry_success'");
    expect(resolver).toContain("fallback_provider_id");
    expect(extractUpsertFunction(sql)).toMatch(
      /fn_resolve_message_request_final_provider_id\(\s*NEW\.provider_id,\s*NEW\.provider_chain\s*\)/
    );
    expect(extractUpsertFunction(sql)).not.toContain("NEW.provider_chain -> -1");
  });

  it("computes is_success from error_message", () => {
    expect(sql).toContain("error_message IS NULL");
  });

  it("persists success_rate_outcome into usage_ledger", () => {
    expect(sql).toContain("success_rate_outcome");
  });

  it("copies GPT-5.6 usage provenance and pricing audit JSON into usage_ledger", () => {
    expect(sql).toContain("observed_input_tokens");
    expect(sql).toContain("cache_write_tokens_reported");
    expect(sql).toContain("cache_write_accounting");
    expect(sql).toContain("cost_breakdown");
    expect(sql).toContain("special_settings");
    expect(sql).toContain("hedge_losers");
  });

  it("creates trigger binding", () => {
    expect(sql).toContain("CREATE TRIGGER trg_upsert_usage_ledger");
  });

  it("keeps the generated migration trigger function byte-for-byte aligned", () => {
    expect(extractUpsertFunction(migration0116Sql)).toBe(extractUpsertFunction(sql));
  });

  it("keeps the final-provider resolver aligned across canonical SQL and both migrations", () => {
    const canonical = extractFinalProviderResolver(sql);
    expect(extractFinalProviderResolver(migration0109Sql)).toBe(canonical);
    expect(extractFinalProviderResolver(migrationSql)).toBe(canonical);
  });
});
