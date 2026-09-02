import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockGetCurrentProviderStatusWithCache = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
}));

vi.mock("@/lib/redis/availability-cache", () => ({
  getCurrentProviderStatusWithCache: mockGetCurrentProviderStatusWithCache,
}));

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/availability/current");
}

describe("GET /api/availability/current", () => {
  let GET: (request: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: 1, role: "admin" },
    });
    mockGetCurrentProviderStatusWithCache.mockResolvedValue([
      {
        providerId: 1,
        providerName: "Provider A",
        status: "green",
        availability: 1,
        requestCount: 10,
        lastRequestAt: "2026-04-13T08:59:00.000Z",
      },
    ]);

    const mod = await import("@/app/api/availability/current/route");
    GET = mod.GET;
  });

  it("未认证时返回 401 且不触发查询", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(mockGetCurrentProviderStatusWithCache).not.toHaveBeenCalled();
  });

  it("非 admin 会话返回 401", async () => {
    mockGetSession.mockResolvedValueOnce({ user: { id: 2, role: "user" } });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(mockGetCurrentProviderStatusWithCache).not.toHaveBeenCalled();
  });

  it("admin 请求走缓存层并返回聚合结果", async () => {
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockGetCurrentProviderStatusWithCache).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body[0]).toMatchObject({
      providerId: 1,
      status: "green",
      availability: 1,
    });
  });

  it("缓存层抛错时返回 500", async () => {
    mockGetCurrentProviderStatusWithCache.mockRejectedValueOnce(new Error("db down"));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
  });
});
