import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSessionCyberBlocked: vi.fn(async () => false),
}));

vi.mock("@/lib/security/cyber-containment", () => ({
  isSessionCyberBlocked: mocks.isSessionCyberBlocked,
}));

// All other guard steps pass through so the cyberBlock step is the only decision point.
vi.mock("@/app/v1/_lib/proxy/auth-guard", () => ({
  ProxyAuthenticator: { ensure: async () => null },
}));
vi.mock("@/app/v1/_lib/proxy/client-guard", () => ({
  ProxyClientGuard: { ensure: async () => null },
}));
vi.mock("@/app/v1/_lib/proxy/model-guard", () => ({
  ProxyModelGuard: { ensure: async () => null },
}));
vi.mock("@/app/v1/_lib/proxy/version-guard", () => ({
  ProxyVersionGuard: { ensure: async () => null },
}));
vi.mock("@/app/v1/_lib/proxy/session-guard", () => ({
  ProxySessionGuard: { ensure: async () => {} },
}));
vi.mock("@/app/v1/_lib/proxy/warmup-guard", () => ({
  ProxyWarmupGuard: { ensure: async () => null },
}));
vi.mock("@/app/v1/_lib/proxy/request-filter", () => ({
  ProxyRequestFilter: { ensure: async () => {} },
}));
vi.mock("@/app/v1/_lib/proxy/sensitive-word-guard", () => ({
  ProxySensitiveWordGuard: { ensure: async () => null },
}));
vi.mock("@/app/v1/_lib/proxy/rate-limit-guard", () => ({
  ProxyRateLimitGuard: { ensure: async () => {} },
}));
vi.mock("@/app/v1/_lib/proxy/provider-selector", () => ({
  ProxyProviderResolver: { ensure: async () => null },
}));
vi.mock("@/app/v1/_lib/proxy/provider-request-filter", () => ({
  ProxyProviderRequestFilter: { ensure: async () => {} },
}));
vi.mock("@/app/v1/_lib/proxy/message-service", () => ({
  ProxyMessageService: { ensureContext: async () => {} },
}));

describe("GuardPipeline cyberBlock step", () => {
  test("rejects a blocked session with the structured cyber_policy error before provider selection", async () => {
    mocks.isSessionCyberBlocked.mockResolvedValueOnce(true);

    const { GuardPipelineBuilder, RequestType } = await import(
      "@/app/v1/_lib/proxy/guard-pipeline"
    );
    const pipeline = GuardPipelineBuilder.fromRequestType(RequestType.CHAT);

    const session = {
      isProbeRequest: () => false,
      sessionId: "sess_blocked",
    } as never;

    const response = await pipeline.run(session);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.error.code).toBe("cyber_policy");
    expect(mocks.isSessionCyberBlocked).toHaveBeenCalledWith("sess_blocked");
  });

  test("passes an unblocked session through", async () => {
    mocks.isSessionCyberBlocked.mockResolvedValueOnce(false);

    const { GuardPipelineBuilder, RequestType } = await import(
      "@/app/v1/_lib/proxy/guard-pipeline"
    );
    const pipeline = GuardPipelineBuilder.fromRequestType(RequestType.CHAT);

    const session = {
      isProbeRequest: () => false,
      sessionId: "sess_ok",
    } as never;

    const response = await pipeline.run(session);
    expect(response).toBeNull();
  });

  test("skips the check when the session has no id", async () => {
    const { GuardPipelineBuilder, RequestType } = await import(
      "@/app/v1/_lib/proxy/guard-pipeline"
    );
    const pipeline = GuardPipelineBuilder.fromRequestType(RequestType.CHAT);

    const session = {
      isProbeRequest: () => false,
      sessionId: null,
    } as never;

    const response = await pipeline.run(session);
    expect(response).toBeNull();
    expect(mocks.isSessionCyberBlocked).not.toHaveBeenCalled();
  });
});
