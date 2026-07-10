import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  getSession: vi.fn(),
  hasAdminAuthority: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
  hasAdminAuthority: mocks.hasAdminAuthority,
}));
vi.mock("@/i18n/routing", () => ({ redirect: mocks.redirect }));
vi.mock("@/app/[locale]/dashboard/_components/dashboard-header", () => ({
  DashboardHeader: () => null,
}));
vi.mock("@/app/[locale]/dashboard/_components/dashboard-main", () => ({
  DashboardMain: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/[locale]/dashboard/_components/webhook-migration-dialog", () => ({
  WebhookMigrationDialog: () => null,
}));

describe("targeted authenticated layout guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasAdminAuthority.mockReturnValue(false);
  });

  it("routes an admin-owned read-only key away from the dashboard", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: 1, role: "admin" },
      key: { canLoginWebUi: false },
    });

    const { default: DashboardLayout } = await import("@/app/[locale]/dashboard/layout");
    await DashboardLayout({ children: null, params: Promise.resolve({ locale: "en" }) });

    expect(mocks.connection).toHaveBeenCalled();
    expect(mocks.getSession).toHaveBeenCalledWith({ allowReadOnlyAccess: true });
    expect(mocks.redirect).toHaveBeenCalledWith({ href: "/my-usage", locale: "en" });
  });

  it("keeps an admin-owned read-only key on my-usage", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: 1, role: "admin" },
      key: { canLoginWebUi: false },
    });

    const { default: MyUsageLayout } = await import("@/app/[locale]/my-usage/layout");
    await MyUsageLayout({ children: null, params: Promise.resolve({ locale: "en" }) });

    expect(mocks.getSession).toHaveBeenCalledWith({ allowReadOnlyAccess: true });
    expect(mocks.redirect).not.toHaveBeenCalledWith({ href: "/dashboard", locale: "en" });
  });

  it("routes every Web-capable key from my-usage to the dashboard", async () => {
    mocks.getSession.mockResolvedValue({
      user: { id: 2, role: "user" },
      key: { canLoginWebUi: true },
    });

    const { default: MyUsageLayout } = await import("@/app/[locale]/my-usage/layout");
    await MyUsageLayout({ children: null, params: Promise.resolve({ locale: "en" }) });

    expect(mocks.redirect).toHaveBeenCalledWith({ href: "/dashboard", locale: "en" });
  });
});
