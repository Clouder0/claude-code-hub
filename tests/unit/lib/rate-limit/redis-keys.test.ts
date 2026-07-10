import { describe, expect, it } from "vitest";
import { buildProviderTotalCostKey, buildRollingCostKey } from "@/lib/rate-limit/redis-keys";

describe("rate-limit Redis key generations", () => {
  it("isolates rolling cost state from the legacy blue deployment", () => {
    expect(buildRollingCostKey("provider", 42, "5h")).toBe("provider:42:cost_5h_rolling:v2");
    expect(buildRollingCostKey("user", 7, "daily")).toBe("user:7:cost_daily_rolling:v2");
  });

  it("isolates provider total snapshots while preserving their reset boundary", () => {
    expect(buildProviderTotalCostKey(42, 1_700_000_000_000)).toBe(
      "total_cost:provider:42:v2:1700000000000"
    );
    expect(buildProviderTotalCostKey(42)).toBe("total_cost:provider:42:v2:none");
  });
});
