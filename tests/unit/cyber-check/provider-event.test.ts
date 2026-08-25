import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnvConfig: vi.fn(),
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/config/env.schema", () => ({ getEnvConfig: mocks.getEnvConfig }));
vi.mock("@/lib/logger", () => ({ logger: mocks.logger }));

import type { CyberCheckAdmissionCorrelation } from "@/app/v1/_lib/proxy/session";
import { reportProviderPolicyEventBestEffort } from "@/lib/cyber-check/provider-event";

const correlation: CyberCheckAdmissionCorrelation = {
  identity: {
    gateway: "cch-test",
    request_id: "42:digest",
    principal_id: "7",
    credential_id: "9",
    session_id: "session-provider-event-test",
    sequence: 3,
  },
  upstreamProviderId: "17",
};

function env(mode: "off" | "shadow" | "enforce") {
  return {
    CYBER_CHECK_MODE: mode,
    CYBER_CHECK_URL: "http://127.0.0.1:8090",
    CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
    CYBER_CHECK_GATEWAY_ID: "cch-test",
    CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
  };
}

function session(marker: CyberCheckAdmissionCorrelation | null = correlation) {
  return {
    sessionId: "session-provider-event-test",
    getCyberCheckAdmissionCorrelation: () => marker,
  };
}

describe("CCH provider cyber-event reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvConfig.mockReturnValue(env("shadow"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports an exact correlated cyber event", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await reportProviderPolicyEventBestEffort(session(), "cyber_policy");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/provider-events");
    expect(JSON.parse(String(init?.body))).toEqual({
      schema_version: "cyber-check.provider-event.v1",
      identity: correlation.identity,
      upstream_provider_id: "17",
      event: {
        type: "policy_rejection",
        code: "cyber_policy",
      },
    });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      "CyberCheck: authoritative provider cyber event reported",
      expect.objectContaining({
        requestId: "42:digest",
        sessionId: "session-provider-event-test",
        upstreamProviderId: "17",
      })
    );
  });

  it("does not report bio, an uncorrelated rejection, or disabled integration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await reportProviderPolicyEventBestEffort(session(), "bio_policy");
    await reportProviderPolicyEventBestEffort(session(null), "cyber_policy");
    mocks.getEnvConfig.mockReturnValue(env("off"));
    await reportProviderPolicyEventBestEffort(session(), "cyber_policy");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains service failures without logging response content", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "provider_event_conflict", message: "sensitive response details" },
          }),
          { status: 409, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reportProviderPolicyEventBestEffort(session(), "cyber_policy")
    ).resolves.toBeUndefined();

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "CyberCheck: authoritative provider cyber event could not be reported",
      expect.objectContaining({
        errorType: "CyberCheckClientError",
        status: 409,
        serviceCode: "provider_event_conflict",
      })
    );
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      "sensitive response details"
    );
  });
});
