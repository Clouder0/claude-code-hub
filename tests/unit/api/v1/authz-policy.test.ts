import { afterEach, describe, expect, test, vi } from "vitest";

function createContext(method = "GET") {
  const request = new Request("http://localhost/api/v1/test", { method });
  return {
    req: {
      method,
      url: request.url,
      raw: request,
      header: (name: string) => request.headers.get(name) ?? undefined,
    },
  };
}

describe("v1 authz policy", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.doUnmock("@/lib/auth");
    vi.resetModules();
  });

  test("public routes do not require credentials", async () => {
    const { resolveAuth } = await import("@/lib/api/v1/_shared/auth-middleware");
    const result = await resolveAuth(createContext() as never, "public");

    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({
      session: null,
      token: null,
      source: "none",
      credentialType: "none",
      allowReadOnlyAccess: true,
      adminAuthority: false,
    });
  });

  test("read web and admin routes reject missing credentials with problem json", async () => {
    const { resolveAuth } = await import("@/lib/api/v1/_shared/auth-middleware");
    for (const tier of ["read", "web", "admin"] as const) {
      const result = await resolveAuth(createContext() as never, tier);

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
      expect((result as Response).headers.get("content-type")).toContain(
        "application/problem+json"
      );
      await expect((result as Response).json()).resolves.toMatchObject({
        status: 401,
        errorCode: "auth.missing",
      });
    }
  });

  test("web tier requires strict web-login-capable auth", async () => {
    const validateAuthTokenMock = vi.fn().mockResolvedValue({
      user: { id: 42, role: "user", isEnabled: true },
      key: { id: 7, userId: 42, key: "user-token", canLoginWebUi: true },
    });

    vi.doMock("@/lib/auth", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/auth")>();
      return { ...actual, validateAuthToken: validateAuthTokenMock };
    });

    const request = new Request("http://localhost/api/v1/test", {
      headers: { Authorization: "Bearer user-token" },
    });
    const context = {
      req: {
        method: "GET",
        url: request.url,
        raw: request,
        header: (name: string) => request.headers.get(name) ?? undefined,
      },
    };

    const { resolveAuth } = await import("@/lib/api/v1/_shared/auth-middleware");
    const result = await resolveAuth(context as never, "web");

    expect(result).not.toBeInstanceOf(Response);
    expect(validateAuthTokenMock).toHaveBeenCalledWith("user-token", {
      allowReadOnlyAccess: false,
    });
    expect(result).toMatchObject({
      allowReadOnlyAccess: false,
      adminAuthority: false,
      credentialType: "user-api-key",
    });
  });
});
