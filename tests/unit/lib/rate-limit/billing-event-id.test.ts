import { describe, expect, it } from "vitest";
import {
  TRACK_COST_5H_ROLLING_WINDOW,
  TRACK_COST_DAILY_ROLLING_WINDOW,
} from "@/lib/redis/lua-scripts";

describe.each([
  ["5h", TRACK_COST_5H_ROLLING_WINDOW],
  ["daily", TRACK_COST_DAILY_ROLLING_WINDOW],
])("%s rolling cost member", (_window, script) => {
  it("prefers billingEventId and falls back to requestId", () => {
    expect(script).toContain("local billing_event_id = ARGV[5]");
    expect(script).toContain("local member_id = billing_event_id");
    expect(script).toContain("member_id = request_id");
    expect(script).toContain("member = now_ms .. ':' .. member_id .. ':' .. cost");
  });
});
