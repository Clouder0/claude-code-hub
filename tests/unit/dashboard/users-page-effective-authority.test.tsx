import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasAdminAuthority: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
  hasAdminAuthority: mocks.hasAdminAuthority,
}));

vi.mock("@/i18n/routing", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/app/[locale]/dashboard/users/users-page-client", () => ({
  UsersPageClient: () => null,
}));

describe("dashboard users page authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes effective authority separately from the stored user role", async () => {
    const storedAdminUser = { id: 7, name: "db-admin", role: "admin" };
    mocks.getSession.mockResolvedValue({
      user: storedAdminUser,
      key: { canLoginWebUi: true },
    });
    mocks.hasAdminAuthority.mockReturnValue(false);

    const { default: UsersPage } = await import("@/app/[locale]/dashboard/users/page");
    const element = (await UsersPage({
      params: Promise.resolve({ locale: "en" }),
    })) as ReactElement<{ currentUser: typeof storedAdminUser; isAdmin: boolean }>;

    expect(element.props.currentUser.role).toBe("admin");
    expect(element.props.isAdmin).toBe(false);
  });
});
