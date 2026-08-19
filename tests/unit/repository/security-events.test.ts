import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  values: vi.fn(),
  onConflictDoNothing: vi.fn(async () => {}),
  insert: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/drizzle/db", () => ({
  db: {
    insert: mocks.insert,
    select: mocks.select,
  },
}));

import {
  findRecentSecurityEvents,
  findSecurityEventUserSummaries,
  insertSecurityEvent,
} from "@/repository/security-events";

function recentQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    leftJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(async () => rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.leftJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

function summaryQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(async () => rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.groupBy.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  return query;
}

describe("security event repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.values.mockReturnValue({ onConflictDoNothing: mocks.onConflictDoNothing });
  });

  it("inserts idempotently by request and event type", async () => {
    await insertSecurityEvent(7, 42, "cyber_policy");

    expect(mocks.values).toHaveBeenCalledWith({
      userId: 7,
      messageRequestId: 42,
      type: "cyber_policy",
    });
    expect(mocks.onConflictDoNothing).toHaveBeenCalledWith({
      target: expect.any(Array),
    });
  });

  it("returns one lookahead row as hasMore and clamps recent-event pagination", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
    const query = recentQuery(rows);
    mocks.select.mockReturnValue(query);

    const result = await findRecentSecurityEvents({ limit: 500, offset: -10 });

    expect(query.limit).toHaveBeenCalledWith(101);
    expect(query.offset).toHaveBeenCalledWith(0);
    expect(result.items).toHaveLength(100);
    expect(result.hasMore).toBe(true);
  });

  it("returns typed per-user summaries and clamps the administrator list size", async () => {
    const rows = [
      {
        userId: 7,
        userName: "operator",
        userEnabled: true,
        policyBlockCount: 2,
        safetyCheckCount: 3,
        lastEventAt: new Date("2026-08-02T00:00:00Z"),
      },
    ];
    const query = summaryQuery(rows);
    mocks.select.mockReturnValue(query);

    await expect(
      findSecurityEventUserSummaries({
        since: new Date("2026-07-01T00:00:00Z"),
        limit: 1000,
      })
    ).resolves.toEqual(rows);
    expect(query.limit).toHaveBeenCalledWith(200);
  });
});
