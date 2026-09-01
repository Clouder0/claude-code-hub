import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disableUserForCyberCheckContainment: vi.fn(async () => true),
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
vi.mock("@/lib/security/policy-containment", () => ({
  disableUserForCyberCheckContainment: mocks.disableUserForCyberCheckContainment,
}));

import type {
  CyberCheckAdmissionCorrelation,
  CyberCheckObservationHandle,
} from "@/app/v1/_lib/proxy/session";
import { reportProviderPolicyEventBestEffort } from "@/lib/cyber-check/provider-event";

const correlation: CyberCheckAdmissionCorrelation = {
  identity: {
    request_id: "42:digest",
    principal_id: "7",
    client_instance_id: "installation-1",
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
    CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
    CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
  };
}

function recordedObservation(): CyberCheckObservationHandle {
  return {
    completion: Promise.resolve({ status: "recorded", correlation }),
  };
}

function session(observation: CyberCheckObservationHandle | null = recordedObservation()) {
  return {
    sessionId: "session-provider-event-test",
    getCyberCheckObservation: () => observation,
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

  it("returns immediately in shadow, then reports the exact correlated cyber event", async () => {
    let settleObservation!: (value: {
      status: "recorded";
      correlation: CyberCheckAdmissionCorrelation;
    }) => void;
    const observation: CyberCheckObservationHandle = {
      completion: new Promise((resolve) => {
        settleObservation = resolve;
      }),
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            principal_strikes: 1,
            session_restricted: true,
            client_instance_restricted: true,
            principal_restricted: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reportProviderPolicyEventBestEffort(session(observation), "cyber_policy")
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    settleObservation({ status: "recorded", correlation });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/provider-events");
    expect(JSON.parse(String(init?.body))).toEqual({
      schema_version: "cyber-check.provider-event.v1",
      identity: correlation.identity,
      enforcement_mode: "shadow",
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
        principalStrikes: 1,
        clientInstanceRestricted: true,
        principalRestricted: false,
        mode: "shadow",
      })
    );
    expect(mocks.disableUserForCyberCheckContainment).not.toHaveBeenCalled();
  });

  it("does not apply a principal restriction returned while the gateway is shadowing", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            principal_strikes: 2,
            session_restricted: true,
            client_instance_restricted: true,
            principal_restricted: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reportProviderPolicyEventBestEffort(session(), "cyber_policy")
    ).resolves.toBeNull();
    await vi.waitFor(() =>
      expect(mocks.logger.info).toHaveBeenCalledWith(
        "CyberCheck: authoritative provider cyber event reported",
        expect.anything()
      )
    );

    expect(mocks.disableUserForCyberCheckContainment).not.toHaveBeenCalled();
  });

  it("disables the complete CCH user after an enforce-mode principal restriction", async () => {
    mocks.getEnvConfig.mockReturnValue(env("enforce"));
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            principal_strikes: 2,
            session_restricted: true,
            client_instance_restricted: true,
            principal_restricted: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await reportProviderPolicyEventBestEffort(session(), "cyber_policy");

    expect(mocks.disableUserForCyberCheckContainment).toHaveBeenCalledOnce();
    expect(mocks.disableUserForCyberCheckContainment).toHaveBeenCalledWith(7);
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

  it("skips a provider event when its matching observation was not recorded", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const observation: CyberCheckObservationHandle = {
      completion: Promise.resolve({ status: "capture_gap" }),
    };

    await expect(
      reportProviderPolicyEventBestEffort(session(observation), "cyber_policy")
    ).resolves.toBeNull();
    await vi.waitFor(() =>
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        "CyberCheck: authoritative provider cyber event skipped after observation capture gap"
      )
    );
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
    ).resolves.toBeNull();
    await vi.waitFor(() =>
      expect(mocks.logger.warn).toHaveBeenCalledWith(
        "CyberCheck: authoritative provider cyber event could not be reported",
        expect.objectContaining({
          errorType: "CyberCheckClientError",
          status: 409,
          serviceCode: "provider_event_conflict",
        })
      )
    );

    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      "sensitive response details"
    );
  });
});
