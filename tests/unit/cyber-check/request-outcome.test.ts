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
import { reportCleanRequestOutcomeBestEffort } from "@/lib/cyber-check/request-outcome";

const correlation: CyberCheckAdmissionCorrelation = {
  identity: {
    request_id: "42:digest",
    principal_id: "7",
    client_instance_id: "installation-1",
    session_id: "session-request-outcome-test",
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

function session(marker: CyberCheckAdmissionCorrelation | null = correlation) {
  return {
    getCyberCheckAdmissionCorrelation: () => marker,
  };
}

describe("CCH clean request-outcome reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvConfig.mockReturnValue(env("shadow"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the exact successful admission identity", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await reportCleanRequestOutcomeBestEffort(session());

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:8090/v1/request-outcomes");
    expect(JSON.parse(String(init?.body))).toEqual({
      schema_version: "cyber-check.request-outcome.v1",
      identity: correlation.identity,
      outcome: "clean",
    });
    expect(mocks.logger.debug).toHaveBeenCalledWith(
      "CyberCheck: clean request outcome reported",
      expect.objectContaining({
        requestId: "42:digest",
        sessionId: "session-request-outcome-test",
      })
    );
  });

  it("does not report without correlation or when the integration is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await reportCleanRequestOutcomeBestEffort(session(null));
    mocks.getEnvConfig.mockReturnValue(env("off"));
    await reportCleanRequestOutcomeBestEffort(session());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("contains service failures without exposing response content", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "request_outcome_conflict", message: "sensitive response details" },
          }),
          { status: 409, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(reportCleanRequestOutcomeBestEffort(session())).resolves.toBeUndefined();

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "CyberCheck: clean request outcome could not be reported",
      expect.objectContaining({
        errorType: "CyberCheckClientError",
        status: 409,
        serviceCode: "request_outcome_conflict",
      })
    );
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain(
      "sensitive response details"
    );
  });
});
