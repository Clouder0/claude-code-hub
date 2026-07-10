import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.DSN = "";

vi.mock("@/drizzle/db", () => ({
  db: {
    execute: vi.fn(),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, sql: actual.sql };
});

const { backfillUsageLedger } = await import("@/lib/ledger-backfill");

const serviceSource = readFileSync(
  resolve(process.cwd(), "src/lib/ledger-backfill/service.ts"),
  "utf-8"
);

describe("backfillUsageLedger", () => {
  it("exports backfillUsageLedger function", () => {
    expect(typeof backfillUsageLedger).toBe("function");
  });

  it("uses ON CONFLICT in backfill SQL", () => {
    expect(serviceSource).toContain("ON CONFLICT");
  });

  it("uses ON CONFLICT DO UPDATE in backfill SQL", () => {
    expect(serviceSource).toContain("DO UPDATE");
  });

  it("computes success_rate_outcome during backfill", () => {
    expect(serviceSource).toContain("success_rate_outcome");
    expect(serviceSource).toContain("fn_compute_message_request_success_rate_outcome");
  });

  it("repairs final-provider attribution without repricing existing ledger rows", () => {
    expect(serviceSource).toContain("fn_resolve_message_request_final_provider_id");
    expect(serviceSource).toContain(
      "ul.final_provider_id IS DISTINCT FROM resolved.final_provider_id"
    );

    const conflictClause = serviceSource.match(
      /ON CONFLICT \(request_id\) DO UPDATE SET([\s\S]*?)RETURNING request_id/
    )?.[1];
    expect(conflictClause).toContain("final_provider_id = EXCLUDED.final_provider_id");
    expect(conflictClause).not.toContain("cost_usd");
  });

  it("backfills GPT-5.6 usage provenance and pricing audit fields", () => {
    expect(serviceSource).toContain("mr.observed_input_tokens");
    expect(serviceSource).toContain("mr.cache_write_tokens_reported");
    expect(serviceSource).toContain("mr.cache_write_accounting");
    expect(serviceSource).toContain("mr.cost_breakdown");
    expect(serviceSource).toContain("mr.special_settings");
    expect(serviceSource).toContain("mr.hedge_losers");
  });
});
