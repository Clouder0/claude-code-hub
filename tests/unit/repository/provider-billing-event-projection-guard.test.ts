import { is, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Projection guard for buildProviderBillingEventsQuery embeddings.
 *
 * The ledger_rows CTE materializes a narrow column projection instead of
 * `ledger.*`. That projection is a runtime-only contract: drizzle cannot
 * type-check SQL fragments, so a consumer referencing an event column that the
 * CTE no longer outputs would only fail at query time. This test compiles the
 * SQL of every embedding surface (without touching a database) and asserts
 * that every referenced `provider_billing_event.<column>` stays inside the
 * event CTE output contract below.
 */

// Output contract of the provider_billing_events CTE (the final UNION select).
// Keep in sync with buildSettledLoserCtes / the winner-branch select.
const EVENT_OUTPUT_COLUMNS = new Set([
  "billing_event_id",
  "request_id",
  "provider_id",
  "attempt_number",
  "created_at",
  "user_id",
  "key_value",
  "model",
  "original_model",
  "success_rate_outcome",
  "ttfb_ms",
  "duration_ms",
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "kind",
]);

const captures: Record<string, unknown[][]> = {};

function createCapturingDb() {
  const chain = Promise.resolve([]) as Promise<unknown> & Record<string, unknown>;
  for (const method of ["from", "innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      (captures[method] ??= []).push(args);
      return chain;
    };
  }

  return {
    select: (...args: unknown[]) => {
      (captures.select ??= []).push(args);
      return chain;
    },
    execute: async (query: unknown) => {
      (captures.execute ??= []).push([query]);
      return [];
    },
  };
}

vi.mock("@/drizzle/db", () => ({ db: createCapturingDb() }));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: vi.fn(async () => "UTC") }));
vi.mock("@/repository/system-config", () => ({
  getSystemSettings: vi.fn(async () => ({ billingModelSource: "redirected" })),
}));

function compileFragment(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (!is(value, SQL)) return null;
  try {
    return new PgDialect().sqlToQuery(value).sql;
  } catch {
    return null;
  }
}

function compiledSurfaceSql(): string {
  const fragments: string[] = [];
  for (const args of Object.values(captures)) {
    for (const arg of args.flat()) {
      const sql = compileFragment(arg);
      if (sql) fragments.push(sql);
    }
  }
  return fragments.join("\n");
}

function referencedEventColumns(sqlText: string): Set<string> {
  const columns = new Set<string>();
  for (const match of sqlText.matchAll(/provider_billing_event\.([a-z_]+)/g)) {
    columns.add(match[1]);
  }
  return columns;
}

beforeEach(() => {
  for (const key of Object.keys(captures)) delete captures[key];
});

describe("provider billing event projection guard", () => {
  it("provider leaderboard (with model stats) only references contracted event columns", async () => {
    const { findWeeklyProviderLeaderboard } = await import("@/repository/leaderboard");
    await findWeeklyProviderLeaderboard(undefined, true);

    const referenced = referencedEventColumns(compiledSurfaceSql());
    expect(referenced.size).toBeGreaterThan(0);
    for (const column of referenced) {
      expect(EVENT_OUTPUT_COLUMNS).toContain(column);
    }
  });

  it("provider cost entries (rolling-window recovery) only reference contracted event columns", async () => {
    const { findProviderCostEntriesInTimeRange } = await import("@/repository/statistics");
    await findProviderCostEntriesInTimeRange(1, new Date("2026-01-01"), new Date("2026-02-01"));

    const sqlText = compiledSurfaceSql();
    // This surface reads the event CTE through the provider_cost_events alias
    // with unqualified names; pin the columns it projects to the contract.
    expect(sqlText).toContain("FROM provider_cost_events");
    for (const column of ["request_id", "billing_event_id", "created_at", "cost_usd"]) {
      expect(EVENT_OUTPUT_COLUMNS).toContain(column);
      expect(sqlText).toContain(column);
    }
    for (const column of referencedEventColumns(sqlText)) {
      expect(EVENT_OUTPUT_COLUMNS).toContain(column);
    }
  });

  it("admin user model breakdown (providerId branch) drops the outer event-level date predicates", async () => {
    const { getUserModelBreakdown } = await import("@/repository/admin-user-insights");
    await getUserModelBreakdown(9, "2026-01-01", undefined, { providerId: 2 });

    const sqlText = compiledSurfaceSql();
    const referenced = referencedEventColumns(sqlText);
    for (const column of referenced) {
      expect(EVENT_OUTPUT_COLUMNS).toContain(column);
    }
    // The date window lives once, inside the CTE on ledger rows. The outer
    // query must not re-filter on provider_billing_event.created_at.
    expect(sqlText).toMatch(/ledger\.created_at >=/);
    expect(sqlText).not.toMatch(/provider_billing_event\.created_at/);
  });

  it("admin user provider breakdown drops the outer event-level date predicates", async () => {
    const { getUserProviderBreakdown } = await import("@/repository/admin-user-insights");
    await getUserProviderBreakdown(9, "2026-01-01", undefined, { keyId: 3 });

    const sqlText = compiledSurfaceSql();
    for (const column of referencedEventColumns(sqlText)) {
      expect(EVENT_OUTPUT_COLUMNS).toContain(column);
    }
    expect(sqlText).toMatch(/ledger\.created_at >=/);
    expect(sqlText).not.toMatch(/provider_billing_event\.created_at/);
  });

  it("the CTE projection itself stays narrow and matches the exported column list", async () => {
    const { buildProviderBillingEventsQuery } = await import(
      "@/repository/_shared/provider-billing-events"
    );
    const { LEDGER_EVENT_ROW_COLUMN_NAMES } = await import(
      "@/repository/_shared/provider-billing-events"
    );

    const sqlText = new PgDialect()
      .sqlToQuery(buildProviderBillingEventsQuery({ providerId: 42 }))
      .sql.replace(/\s+/g, " ");

    expect(sqlText).not.toContain("ledger.*");
    expect(sqlText).toContain("SELECT ledger.request_id, ledger.created_at, ledger.user_id");
    expect(sqlText).toContain(
      "ledger.cache_read_input_tokens, ledger.final_provider_id, ledger.hedge_losers"
    );
    expect(sqlText).not.toContain("cost_breakdown");
    expect(sqlText).not.toContain("special_settings");
  });
});
