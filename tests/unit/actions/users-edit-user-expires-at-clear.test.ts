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

const getCyberCheckStateMock = vi.fn(async () => null);
const reinstateCyberCheckPrincipalMock = vi.fn(async () => true);
const reinstateCyberCheckClientInstanceMock = vi.fn(async () => true);
vi.mock("@/lib/cyber-check/admin", () => ({
  getCyberCheckStateIfConfigured: getCyberCheckStateMock,
  reinstateCyberCheckPrincipalIfConfigured: reinstateCyberCheckPrincipalMock,
  reinstateCyberCheckClientInstanceIfConfigured: reinstateCyberCheckClientInstanceMock,
}));

const invalidateCachedUserMock = vi.fn(async () => {});
vi.mock("@/lib/security/api-key-auth-cache", () => ({
  invalidateCachedUser: invalidateCachedUserMock,
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
    getCyberCheckStateMock.mockResolvedValue(null);
    reinstateCyberCheckPrincipalMock.mockResolvedValue(true);
    reinstateCyberCheckClientInstanceMock.mockResolvedValue(true);
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

  test("ordinary edit re-enable checks Cyber state without resetting its epoch", async () => {
    const { editUser } = await import("@/actions/users");

    const res = await editUser(123, { isEnabled: true });

    expect(res.ok).toBe(true);
    expect(getCyberCheckStateMock).toHaveBeenCalledWith("123");
    expect(reinstateCyberCheckPrincipalMock).not.toHaveBeenCalled();
    expect(updateUserMock).toHaveBeenCalledWith(123, expect.objectContaining({ isEnabled: true }));
  });

  test("an active principal restriction requires the explicit reset flow", async () => {
    getCyberCheckStateMock.mockResolvedValueOnce({
      principal: { current_strikes: 2, restricted: true },
    });
    const { toggleUserEnabled } = await import("@/actions/users");

    const res = await toggleUserEnabled(123, true);

    expect(res).toMatchObject({ ok: false, errorCode: "CYBER_PRINCIPAL_RESET_REQUIRED" });
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(reinstateCyberCheckPrincipalMock).not.toHaveBeenCalled();
  });

  test("an unavailable authority leaves the CCH user disabled", async () => {
    getCyberCheckStateMock.mockRejectedValueOnce(new Error("review service unavailable"));
    const { toggleUserEnabled } = await import("@/actions/users");

    const res = await toggleUserEnabled(123, true);

    expect(res).toMatchObject({ ok: false, errorCode: "CYBER_CHECK_UNAVAILABLE" });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  test("renew-and-enable checks without silently starting a fresh strike epoch", async () => {
    const { renewUser } = await import("@/actions/users");

    const res = await renewUser(123, {
      expiresAt: "2030-01-01T00:00:00.000Z",
      enableUser: true,
    });

    expect(res.ok).toBe(true);
    expect(getCyberCheckStateMock).toHaveBeenCalledWith("123");
    expect(reinstateCyberCheckPrincipalMock).not.toHaveBeenCalled();
    expect(updateUserMock).toHaveBeenCalledWith(123, expect.objectContaining({ isEnabled: true }));
  });

  test("explicit principal reset reaches Cyber Check before enabling the CCH user", async () => {
    const { resetUserPrincipalCyberState } = await import("@/actions/users");

    const res = await resetUserPrincipalCyberState(123, true);

    expect(res).toEqual({ ok: true, data: { enabled: true } });
    expect(reinstateCyberCheckPrincipalMock).toHaveBeenCalledWith("123");
    expect(reinstateCyberCheckPrincipalMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateUserMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(updateUserMock).toHaveBeenCalledWith(123, { isEnabled: true });
    expect(invalidateCachedUserMock).toHaveBeenCalledWith(123);
  });

  test("explicit principal reset failure never enables the CCH user", async () => {
    reinstateCyberCheckPrincipalMock.mockRejectedValueOnce(new Error("central reset failed"));
    const { resetUserPrincipalCyberState } = await import("@/actions/users");

    const res = await resetUserPrincipalCyberState(123, true);

    expect(res).toMatchObject({ ok: false, errorCode: "CYBER_CHECK_UNAVAILABLE" });
    expect(updateUserMock).not.toHaveBeenCalled();
    expect(invalidateCachedUserMock).not.toHaveBeenCalled();
  });

  test("installation reset is scoped to the selected principal and installation", async () => {
    const { resetUserClientInstanceCyberState } = await import("@/actions/users");

    const res = await resetUserClientInstanceCyberState(123, "installation-7");

    expect(res.ok).toBe(true);
    expect(reinstateCyberCheckClientInstanceMock).toHaveBeenCalledWith("123", "installation-7");
    expect(reinstateCyberCheckPrincipalMock).not.toHaveBeenCalled();
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  test("Cyber state and reset actions require effective admin authority", async () => {
    getSessionMock.mockResolvedValue({ user: { id: 123, role: "user" } });
    const { getUserCyberState, resetUserPrincipalCyberState } = await import("@/actions/users");

    await expect(getUserCyberState(123)).resolves.toMatchObject({
      ok: false,
      errorCode: "PERMISSION_DENIED",
    });
    await expect(resetUserPrincipalCyberState(123, true)).resolves.toMatchObject({
      ok: false,
      errorCode: "PERMISSION_DENIED",
    });
    expect(getCyberCheckStateMock).not.toHaveBeenCalled();
    expect(reinstateCyberCheckPrincipalMock).not.toHaveBeenCalled();
  });
});
