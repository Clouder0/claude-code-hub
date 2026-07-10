import { describe, expect, test, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { CasingCache } from "drizzle-orm/casing";

function createThenableQuery<T>(result: T) {
  const query: any = Promise.resolve(result);
  query.from = vi.fn(() => query);
  query.where = vi.fn(() => query);
  query.orderBy = vi.fn(() => query);
  return query;
}

describe("usage log model filter options", () => {
  test("getUsedModels omits empty or blank model names", async () => {
    vi.resetModules();

    const selectDistinctMock = vi.fn(() =>
      createThenableQuery([
        { model: "" },
        { model: "   " },
        { model: "claude-sonnet-4-5" },
        { model: "gpt-4o" },
        { model: null },
      ])
    );

    vi.doMock("@/drizzle/db", () => ({
      db: { selectDistinct: selectDistinctMock },
    }));

    const { getUsedModels } = await import("@/repository/usage-logs");

    await expect(getUsedModels()).resolves.toEqual(["claude-sonnet-4-5", "gpt-4o"]);
  });

  test("all management filter-option queries accept a user scope", async () => {
    vi.resetModules();
    const queries: ReturnType<typeof createThenableQuery>[] = [];
    const selectDistinctMock = vi.fn(() => {
      const query = createThenableQuery([]);
      queries.push(query);
      return query;
    });

    vi.doMock("@/drizzle/db", () => ({
      db: { selectDistinct: selectDistinctMock },
    }));

    const { getUsedEndpoints, getUsedModels, getUsedStatusCodes } = await import(
      "@/repository/usage-logs"
    );
    await getUsedModels(42);
    await getUsedStatusCodes(42);
    await getUsedEndpoints(42);

    expect(queries).toHaveLength(3);
    for (const query of queries) {
      const condition = query.where.mock.calls[0][0] as SQL;
      const compiled = condition.toQuery({
        escapeName: (name) => `"${name}"`,
        escapeParam: (num) => `$${num}`,
        escapeString: (value) => `'${value}'`,
        casing: new CasingCache(),
        paramStartIndex: { value: 1 },
      });
      expect(compiled.sql).toContain("user_id");
      expect(compiled.params).toContain(42);
    }
  });
});
