import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  hasAdminAuthority: vi.fn(),
  getSystemSettings: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mocks.getSession,
  hasAdminAuthority: mocks.hasAdminAuthority,
}));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: mocks.getSystemSettings,
}));

const settings = {
  id: 1,
  siteTitle: "Claude Code Hub",
  allowGlobalUsageView: true,
  currencyDisplay: "USD",
  billingModelSource: "redirected",
  passThroughUpstreamErrorMessage: true,
  enableHighConcurrencyMode: true,
  ipExtractionConfig: { headerPriority: ["x-forwarded-for"] },
  createdAt: new Date("2026-04-28T00:00:00.000Z"),
  updatedAt: new Date("2026-04-28T00:00:00.000Z"),
};

describe("GET /api/system-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSystemSettings.mockResolvedValue(settings);
    mocks.hasAdminAuthority.mockReturnValue(false);
  });

  it("returns 401 without a Web session", async () => {
    mocks.getSession.mockResolvedValue(null);

    const { GET } = await import("@/app/api/system-settings/route");
    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.getSystemSettings).not.toHaveBeenCalled();
  });

  it("projects normal Web responses to display-safe fields only", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 2, name: "user", role: "user" } });

    const { GET } = await import("@/app/api/system-settings/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).toEqual({
      siteTitle: "Claude Code Hub",
      currencyDisplay: "USD",
      billingModelSource: "redirected",
    });
    expect(body).not.toHaveProperty("allowGlobalUsageView");
    expect(body).not.toHaveProperty("passThroughUpstreamErrorMessage");
    expect(body).not.toHaveProperty("enableHighConcurrencyMode");
    expect(body).not.toHaveProperty("ipExtractionConfig");
  });

  it("does not trust an admin role without effective admin authority", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 1, name: "admin", role: "admin" } });
    mocks.hasAdminAuthority.mockReturnValue(false);

    const { GET } = await import("@/app/api/system-settings/route");
    const response = await GET();
    const body = await response.json();

    expect(body).toEqual({
      siteTitle: "Claude Code Hub",
      currencyDisplay: "USD",
      billingModelSource: "redirected",
    });
  });

  it("preserves full settings for effective admins", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: 1, name: "admin", role: "admin" } });
    mocks.hasAdminAuthority.mockReturnValue(true);

    const { GET } = await import("@/app/api/system-settings/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).toMatchObject({
      siteTitle: "Claude Code Hub",
      allowGlobalUsageView: true,
      currencyDisplay: "USD",
      billingModelSource: "redirected",
      passThroughUpstreamErrorMessage: true,
      enableHighConcurrencyMode: true,
      ipExtractionConfig: { headerPriority: ["x-forwarded-for"] },
    });
  });
});
