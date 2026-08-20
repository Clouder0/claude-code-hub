import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findSessionBlockPolicy: vi.fn(async () => null),
  providerEnsure: vi.fn(async () => null),
  messageEnsureContext: vi.fn(async () => {}),
}));

vi.mock("@/lib/security/policy-containment", () => ({
  findSessionBlockPolicy: mocks.findSessionBlockPolicy,
}));

// All other guard steps pass through so the policyBlock step is the only decision point.
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
  ProxyProviderResolver: { ensure: mocks.providerEnsure },
}));
vi.mock("@/app/v1/_lib/proxy/provider-request-filter", () => ({
  ProxyProviderRequestFilter: { ensure: async () => {} },
}));
vi.mock("@/app/v1/_lib/proxy/message-service", () => ({
  ProxyMessageService: { ensureContext: mocks.messageEnsureContext },
}));

describe("GuardPipeline policyBlock step", () => {
  test("rejects a cyber-blocked session with the structured cyber_policy error before provider selection", async () => {
    mocks.findSessionBlockPolicy.mockResolvedValueOnce("cyber_policy");

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
    expect(mocks.findSessionBlockPolicy).toHaveBeenCalledWith("sess_blocked");
  });

  test("rejects a bio-blocked session with the structured bio_policy error", async () => {
    mocks.findSessionBlockPolicy.mockResolvedValueOnce("bio_policy");

    const { GuardPipelineBuilder, RequestType } = await import(
      "@/app/v1/_lib/proxy/guard-pipeline"
    );
    const pipeline = GuardPipelineBuilder.fromRequestType(RequestType.CHAT);

    const session = {
      isProbeRequest: () => false,
      sessionId: "sess_bio_blocked",
    } as never;

    const response = await pipeline.run(session);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.error.code).toBe("bio_policy");
  });

  test.each([
    "cyber_policy",
    "bio_policy",
  ] as const)("a %s-blocked session on the raw safe session pipeline is also rejected", async (policy) => {
    mocks.findSessionBlockPolicy.mockResolvedValueOnce(policy);

    const { GuardPipelineBuilder, RequestType } = await import(
      "@/app/v1/_lib/proxy/guard-pipeline"
    );
    const pipeline = GuardPipelineBuilder.fromRequestType(RequestType.COUNT_TOKENS);

    const session = {
      isProbeRequest: () => false,
      sessionId: "sess_raw",
    } as never;

    const response = await pipeline.run(session);
    expect(response).not.toBeNull();
    const body = await response?.json();
    expect(body.error.code).toBe(policy);
  });

  test.each([
    "cyber_policy",
    "bio_policy",
  ] as const)("a %s-blocked alpha search stops before provider selection and billing context", async (policy) => {
    mocks.findSessionBlockPolicy.mockResolvedValueOnce(policy);
    mocks.providerEnsure.mockClear();
    mocks.messageEnsureContext.mockClear();

    const { GuardPipelineBuilder } = await import("@/app/v1/_lib/proxy/guard-pipeline");
    const { resolveEndpointPolicy } = await import("@/app/v1/_lib/proxy/endpoint-policy");
    const pipeline = GuardPipelineBuilder.fromEndpointPolicy(
      resolveEndpointPolicy("/v1/alpha/search")
    );

    const session = {
      isProbeRequest: () => false,
      sessionId: "sess_alpha_blocked",
    } as never;

    const response = await pipeline.run(session);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(400);
    const body = await response?.json();
    expect(body.error.code).toBe(policy);
    expect(mocks.providerEnsure).not.toHaveBeenCalled();
    expect(mocks.messageEnsureContext).not.toHaveBeenCalled();
  });

  test("passes an unblocked session through", async () => {
    mocks.findSessionBlockPolicy.mockResolvedValueOnce(null);

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
    expect(mocks.findSessionBlockPolicy).not.toHaveBeenCalled();
  });
});
