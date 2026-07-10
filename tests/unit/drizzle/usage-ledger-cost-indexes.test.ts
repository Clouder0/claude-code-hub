import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { usageLedger } from "@/drizzle/schema";

/**
 * Regression guard for the index-only-scan regression introduced by #1091.
 *
 * `LEDGER_BILLING_CONDITION` filters `usage_ledger` on `endpoint` (it excludes
 * non-billing endpoints such as count_tokens / compact). The hot-path
 * `SUM(cost_usd)` queries -- rate-limit checks and the Quotas page
 * (`sumUserTotalCost` / `sumKeyTotalCost` / `sumProviderTotalCost` /
 * `sumUserQuotaCosts` ...) -- only stay on an Index Only Scan if `endpoint`
 * is covered by these indexes. Without it the planner abandons the covering
 * index and degrades to a Bitmap Heap Scan (one heap fetch per matching row).
 */
describe("usage_ledger cost covering indexes", () => {
  const { indexes } = getTableConfig(usageLedger);

  const indexColumns = (name: string): string[] => {
    const index = indexes.find((entry) => entry.config.name === name);
    if (!index) {
      throw new Error(`index "${name}" not found on usage_ledger`);
    }
    return index.config.columns.map((column) => {
      const columnName = (column as { name?: unknown }).name;
      return typeof columnName === "string" ? columnName : "";
    });
  };

  it.each([
    ["idx_usage_ledger_user_cost_cover", ["user_id", "created_at", "cost_usd", "endpoint"]],
    [
      "idx_usage_ledger_provider_cost_cover",
      ["final_provider_id", "created_at", "cost_usd", "endpoint"],
    ],
    ["idx_usage_ledger_key_cost", ["key", "created_at", "cost_usd", "endpoint"]],
  ])("%s keeps endpoint as a trailing column so SUM(cost_usd) stays index-only", (name, expected) => {
    expect(indexColumns(name)).toEqual(expected);
  });

  it("indexes hedge-loser containment lookups with jsonb_path_ops", () => {
    const index = indexes.find(
      (entry) => entry.config.name === "idx_usage_ledger_hedge_losers_gin"
    );

    expect(index?.config.method).toBe("gin");
    expect(index?.config.columns).toHaveLength(1);
    expect(index?.config.columns[0]).toMatchObject({
      name: "hedge_losers",
      indexConfig: { opClass: "jsonb_path_ops" },
    });
  });

  it("indexes the sparse winner rows that contain hedge losers", () => {
    const index = indexes.find(
      (entry) => entry.config.name === "idx_usage_ledger_winner_hedge_losers"
    );

    expect(index?.config.columns).toMatchObject([
      { name: "final_provider_id" },
      { name: "created_at" },
    ]);
    expect(new PgDialect().sqlToQuery(index!.config.where!).sql).toContain("IS NOT NULL");
  });
});
