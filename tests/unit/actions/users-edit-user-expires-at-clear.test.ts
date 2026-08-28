import { beforeEach, describe, expect, test, vi } from "vitest";

const getSessionMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: getSessionMock,
  hasAdminAuthority: (session: { user?: { role?: string } } | null | undefined) =>
    session?.user?.role === "admin",
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const getTranslationsMock = vi.fn(async () => (key: string) => key);
const getLocaleMock = vi.fn(async () => "en");
vi.mock("next-intl/server", () => ({
  getTranslations: getTranslationsMock,
  getLocale: getLocaleMock,
}));

const reinstateCyberCheckPrincipalMock = vi.fn(async () => {});
vi.mock("@/lib/cyber-check/admin", () => ({
  reinstateCyberCheckPrincipalIfConfigured: reinstateCyberCheckPrincipalMock,
}));

vi.mock("@/lib/utils/timezone", () => ({
  resolveSystemTimezone: vi.fn(async () => "UTC"),
}));

const updateUserMock = vi.fn();
const findUserByIdMock = vi.fn();
vi.mock("@/repository/user", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repository/user")>();
  return {
    ...actual,
    updateUser: updateUserMock,
    findUserById: findUserByIdMock,
  };
});

const findKeyListMock = vi.fn();
vi.mock("@/repository/key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/repository/key")>();
  return {
    ...actual,
    findKeyList: findKeyListMock,
  };
});

const clear5hResetModeCacheMock = vi.fn();
const clearUserCostCacheMock = vi.fn();
vi.mock("@/lib/redis/cost-cache-cleanup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/redis/cost-cache-cleanup")>();
  return {
    ...actual,
    clear5hResetModeCache: clear5hResetModeCacheMock,
    clearUserCostCache: clearUserCostCacheMock,
  };
});

describe("editUser: expiresAt 清除应写入数据库更新", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockResolvedValue({ user: { id: 1, role: "admin" } });
    updateUserMock.mockResolvedValue({ id: 123 });
    findUserByIdMock.mockResolvedValue({
      id: 123,
      name: "Test User",
      isEnabled: false,
      limit5hResetMode: "fixed",
    });
    findKeyListMock.mockResolvedValue([{ id: 11, key: "sk-child-11" }]);
    clear5hResetModeCacheMock.mockResolvedValue({
      costKeysDeleted: 2,
      leaseKeysDeleted: 2,
      durationMs: 1,
    });
    clearUserCostCacheMock.mockResolvedValue({
      costKeysDeleted: 4,
      activeSessionsDeleted: 0,
      durationMs: 1,
    });
  });

  test("传入 expiresAt=null 应调用 updateUser(..., { expiresAt: null })", async () => {
    const { editUser } = await import("@/actions/users");

    const res = await editUser(123, { expiresAt: null });

    expect(res.ok).toBe(true);
    expect(updateUserMock).toHaveBeenCalledTimes(1);
    expect(updateUserMock).toHaveBeenCalledWith(
      123,
      expect.objectContaining({
        expiresAt: null,
      })
    );
  });

  test("5h reset-mode changes clear only rolling generations", async () => {
    const { editUser } = await import("@/actions/users");

    const res = await editUser(123, { limit5hResetMode: "rolling" });

    expect(res.ok).toBe(true);
    expect(clear5hResetModeCacheMock).toHaveBeenCalledWith({
      entityType: "user",
      entityId: 123,
    });
    expect(clearUserCostCacheMock).not.toHaveBeenCalled();
    expect(findKeyListMock).not.toHaveBeenCalled();
  });

  test("manual edit re-enable resets Cyber Check before making the user active", async () => {
    const { editUser } = await import("@/actions/users");

    const res = await editUser(123, { isEnabled: true });

    expect(res.ok).toBe(true);
    expect(reinstateCyberCheckPrincipalMock).toHaveBeenCalledWith("123");
    expect(updateUserMock).toHaveBeenCalledWith(123, expect.objectContaining({ isEnabled: true }));
    expect(reinstateCyberCheckPrincipalMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateUserMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
  });

  test("a failed central reinstatement leaves the CCH user disabled", async () => {
    reinstateCyberCheckPrincipalMock.mockRejectedValueOnce(new Error("review service unavailable"));
    const { toggleUserEnabled } = await import("@/actions/users");

    const res = await toggleUserEnabled(123, true);

    expect(res).toMatchObject({ ok: false, errorCode: "UPDATE_FAILED" });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  test("renew-and-enable also starts a fresh strike epoch", async () => {
    const { renewUser } = await import("@/actions/users");

    const res = await renewUser(123, {
      expiresAt: "2030-01-01T00:00:00.000Z",
      enableUser: true,
    });

    expect(res.ok).toBe(true);
    expect(reinstateCyberCheckPrincipalMock).toHaveBeenCalledWith("123");
    expect(updateUserMock).toHaveBeenCalledWith(123, expect.objectContaining({ isEnabled: true }));
  });
});
