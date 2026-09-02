import { beforeEach, describe, expect, it, vi } from "vitest";

const gateMock = vi.hoisted(() => vi.fn());

vi.mock("server-only", () => ({}));
vi.mock("@/repository/_shared/provider-billing-events", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/repository/_shared/provider-billing-events")>();
  return {
    ...actual,
    anyHedgeLoserRowsExist: gateMock,
  };
});

const mocks = vi.hoisted(() => ({ resolveSystemTimezone: vi.fn() }));
const executeMock = vi.hoisted(() => vi.fn());

vi.mock("@/drizzle/db", () => ({ db: { execute: executeMock } }));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: mocks.resolveSystemTimezone }));

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

function compiledSql(): string {
  expect(executeMock).toHaveBeenCalledTimes(1);
  const frag = executeMock.mock.calls[0][0];
  expect(frag).toBeInstanceOf(SQL);
  return new PgDialect().sqlToQuery(frag as SQL).sql.replace(/\s+/g, " ");
}

describe("provider statistics hedge gate", () => {
  beforeEach(() => {
    vi.resetModules();
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    mocks.resolveSystemTimezone.mockResolvedValue("UTC");
  });

  it("gate=false (no losers ever) routes to the per-provider LATERAL fast path", async () => {
    gateMock.mockResolvedValue(false);
    const { getProviderStatistics } = await import("@/repository/provider");
    await getProviderStatistics();

    expect(gateMock).toHaveBeenCalledTimes(1);
    const sqlText = compiledSql();
    expect(sqlText).toContain("LEFT JOIN LATERAL");
    expect(sqlText).toContain("final_provider_id = p.id");
    expect(sqlText).toContain("is_billable");
    expect(sqlText).toContain("ORDER BY created_at DESC, request_id DESC");
    expect(sqlText).not.toContain("hedge_losers");
    expect(sqlText).not.toContain("settled_losers");
    expect(sqlText).not.toContain("REGEXP_REPLACE");
    expect(sqlText).not.toContain("jsonb_array_elements");
  });

  it("gate=true (a loser exists) keeps the full attribution query", async () => {
    gateMock.mockResolvedValue(true);
    const { getProviderStatistics } = await import("@/repository/provider");
    await getProviderStatistics();

    expect(gateMock).toHaveBeenCalledTimes(1);
    const sqlText = compiledSql();
    expect(sqlText).toContain("settled_losers");
    expect(sqlText).toContain("hedge_losers");
    expect(sqlText).toContain("REGEXP_REPLACE");
    expect(sqlText).toContain(
      "GREATEST(COALESCE(ledger.cost_usd, 0) - COALESCE(loser_totals.cost_usd, 0), 0)"
    );
    expect(sqlText).toContain("ORDER BY p.id ASC");
  });
});
