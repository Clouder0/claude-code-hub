import { beforeEach, describe, expect, it, vi } from "vitest";

const gateMock = vi.hoisted(() => vi.fn());

vi.mock("@/repository/_shared/provider-billing-events", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/repository/_shared/provider-billing-events")>();
  return {
    ...actual,
    anyHedgeLoserRowsExist: gateMock,
  };
});

const createChainMock = (resolvedData: unknown[]) => ({
  from: vi.fn().mockReturnThis(),
  innerJoin: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockResolvedValue(resolvedData),
});

let selectCallIndex = 0;
let chainMocks: ReturnType<typeof createChainMock>[] = [];
const mockSelect = vi.fn(() => {
  const chain = chainMocks[selectCallIndex] ?? createChainMock([]);
  selectCallIndex++;
  return chain;
});

const mocks = vi.hoisted(() => ({
  resolveSystemTimezone: vi.fn(),
  getSystemSettings: vi.fn(),
}));

vi.mock("@/drizzle/db", () => ({ db: { select: (...args: unknown[]) => mockSelect(...args) } }));
vi.mock("@/drizzle/schema", () => ({
  usageLedger: {
    providerId: "providerId",
    finalProviderId: "finalProviderId",
    userId: "userId",
    costUsd: "costUsd",
    inputTokens: "inputTokens",
    outputTokens: "outputTokens",
    cacheCreationInputTokens: "cacheCreationInputTokens",
    cacheReadInputTokens: "cacheReadInputTokens",
    isSuccess: "isSuccess",
    successRateOutcome: "successRateOutcome",
    blockedBy: "blockedBy",
    createdAt: "createdAt",
    ttfbMs: "ttfbMs",
    durationMs: "durationMs",
    model: "model",
    originalModel: "originalModel",
    isBillable: "isBillable",
  },
  messageRequest: {},
  providers: { id: "id", name: "name", deletedAt: "deletedAt", providerType: "providerType" },
  users: {},
}));
vi.mock("@/lib/utils/timezone", () => ({ resolveSystemTimezone: mocks.resolveSystemTimezone }));
vi.mock("@/repository/system-config", () => ({ getSystemSettings: mocks.getSystemSettings }));

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

function compileFromArg(): string {
  const fromArgs = chainMocks[0]?.from as unknown as ReturnType<typeof vi.fn>;
  expect(fromArgs).toHaveBeenCalled();
  const frag = fromArgs.mock.calls[0][0];
  expect(frag).toBeInstanceOf(SQL);
  return new PgDialect().sqlToQuery(frag as SQL).sql.replace(/\s+/g, " ");
}

describe("provider leaderboard hedge gate", () => {
  beforeEach(() => {
    vi.resetModules();
    selectCallIndex = 0;
    chainMocks = [createChainMock([])];
    mockSelect.mockClear();
    mocks.resolveSystemTimezone.mockResolvedValue("UTC");
    mocks.getSystemSettings.mockResolvedValue({ billingModelSource: "redirected" });
  });

  it("gate=false (no losers ever) routes to the thin ledger subquery", async () => {
    gateMock.mockResolvedValue(false);
    const { findWeeklyProviderLeaderboard } = await import("@/repository/leaderboard");
    await findWeeklyProviderLeaderboard(undefined, true);

    expect(gateMock).toHaveBeenCalledTimes(1);
    const sqlText = compileFromArg();
    expect(sqlText).toContain("FROM usage_ledger AS ledger");
    expect(sqlText).toContain("final_provider_id AS provider_id");
    expect(sqlText).toContain("is_billable");
    expect(sqlText).not.toContain("hedge_losers");
    expect(sqlText).not.toContain("jsonb_array_elements");
    expect(sqlText).not.toContain("WITH ledger_rows");
  });

  it("gate=true (a loser exists) keeps the full attribution CTE", async () => {
    gateMock.mockResolvedValue(true);
    const { findWeeklyProviderLeaderboard } = await import("@/repository/leaderboard");
    await findWeeklyProviderLeaderboard(undefined, true);

    expect(gateMock).toHaveBeenCalledTimes(1);
    const sqlText = compileFromArg();
    expect(sqlText).toContain("WITH ledger_rows");
    expect(sqlText).toContain("jsonb_array_elements");
    expect(sqlText).toContain("settled_losers");
  });
});
