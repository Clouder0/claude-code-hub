import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn(),
  findRecentSecurityEvents: vi.fn(async () => ({ items: [], hasMore: false })),
  findSecurityEventUserSummaries: vi.fn(async () => []),
}));

vi.mock("@/lib/auth", () => ({ getSession: mocks.getSession }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  redirect: mocks.redirect,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/repository/security-events", () => ({
  findRecentSecurityEvents: mocks.findRecentSecurityEvents,
  findSecurityEventUserSummaries: mocks.findSecurityEventUserSummaries,
}));
vi.mock("@/app/[locale]/dashboard/security-events/_components/disable-user-button", () => ({
  DisableUserButton: () => null,
}));

describe("SecurityEventsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated and non-admin sessions without querying events", async () => {
    const { default: SecurityEventsPage } = await import(
      "@/app/[locale]/dashboard/security-events/page"
    );

    mocks.getSession.mockResolvedValueOnce(null).mockResolvedValueOnce({
      user: { id: 2, role: "user" },
    });

    await SecurityEventsPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({}),
    });
    await SecurityEventsPage({
      params: Promise.resolve({ locale: "ja" }),
      searchParams: Promise.resolve({}),
    });

    expect(mocks.redirect).toHaveBeenNthCalledWith(1, {
      href: "/login?from=/dashboard/security-events",
      locale: "en",
    });
    expect(mocks.redirect).toHaveBeenNthCalledWith(2, { href: "/dashboard", locale: "ja" });
    expect(mocks.findRecentSecurityEvents).not.toHaveBeenCalled();
    expect(mocks.findSecurityEventUserSummaries).not.toHaveBeenCalled();
  });

  it("renders for administrators and sanitizes invalid pagination", async () => {
    const { default: SecurityEventsPage } = await import(
      "@/app/[locale]/dashboard/security-events/page"
    );
    mocks.getSession.mockResolvedValue({ user: { id: 1, role: "admin" } });

    const element = await SecurityEventsPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({ page: "not-a-page" }),
    });

    expect(isValidElement(element)).toBe(true);
    expect(mocks.findSecurityEventUserSummaries).toHaveBeenCalledTimes(1);
    expect(mocks.findRecentSecurityEvents).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it("renders a bio_policy event with the bio policy-block label", async () => {
    const { default: SecurityEventsPage } = await import(
      "@/app/[locale]/dashboard/security-events/page"
    );
    mocks.getSession.mockResolvedValue({ user: { id: 1, role: "admin" } });
    mocks.findRecentSecurityEvents.mockResolvedValueOnce({
      items: [
        {
          id: 3,
          type: "bio_policy",
          createdAt: new Date("2026-08-21T00:00:00Z"),
          messageRequestId: 9,
          userId: 5,
          userName: "bio-user",
          userEnabled: true,
          keyId: null,
          keyName: null,
          sessionId: "sess_bio",
          requestSequence: 1,
          providerId: 1,
          providerName: "p1",
        },
      ],
      hasMore: false,
    });

    const element = await SecurityEventsPage({
      params: Promise.resolve({ locale: "en" }),
      searchParams: Promise.resolve({}),
    });

    // 页面返回 RSC 元素树；用静态渲染断言 bio 事件走到 bioPolicy 标签分支。
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(element);
    expect(html).toContain("types.bioPolicy");
    expect(html).toContain("bio-user");
  });
});
