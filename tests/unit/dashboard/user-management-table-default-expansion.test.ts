import { describe, expect, it } from "vitest";
import { shouldDefaultExpandUser } from "@/app/[locale]/dashboard/_components/user/user-management-table-state";

describe("UserManagementTable default expansion", () => {
  it("expands only the normal Web user's own row", () => {
    expect(shouldDefaultExpandUser(7, 7, false)).toBe(true);
    expect(shouldDefaultExpandUser(8, 7, false)).toBe(false);
  });

  it("keeps every row collapsed for admins", () => {
    expect(shouldDefaultExpandUser(7, 7, true)).toBe(false);
  });
});
