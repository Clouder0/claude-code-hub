import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getEnvConfig: vi.fn() }));

vi.mock("@/lib/config/env.schema", () => ({ getEnvConfig: mocks.getEnvConfig }));

import {
  getCyberCheckStateIfConfigured,
  reinstateCyberCheckClientInstanceIfConfigured,
  reinstateCyberCheckPrincipalIfConfigured,
} from "@/lib/cyber-check/admin";

function env(mode: "off" | "shadow" | "enforce") {
  return {
    CYBER_CHECK_MODE: mode,
    CYBER_CHECK_URL: "http://127.0.0.1:8090",
    CYBER_CHECK_GATEWAY_TOKEN: "gateway-token",
    CYBER_CHECK_ZSTD_MIN_BYTES: 256 * 1024,
    CYBER_CHECK_MAX_ENCODING_BYTES: 256 * 1024 * 1024,
  };
}

describe("Cyber Check principal administration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvConfig.mockReturnValue(env("enforce"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resets the principal epoch before a CCH user is re-enabled", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(reinstateCyberCheckPrincipalIfConfigured("7")).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8090/v1/principals/7/reinstatement"
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is a no-op only when the integration is explicitly off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getEnvConfig.mockReturnValue(env("off"));

    await expect(reinstateCyberCheckPrincipalIfConfigured("7")).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates service failure so the caller cannot claim reinstatement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "unavailable" } }, { status: 503 }))
    );

    await expect(reinstateCyberCheckPrincipalIfConfigured("7")).rejects.toMatchObject({
      status: 503,
    });
  });

  it("reads live state and resets one installation without exposing the token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          principal_id: "7",
          strike_window_seconds: 2_592_000,
          disable_threshold: 2,
          principal: { current_strikes: 1, restricted: false },
          client_instances: [],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getCyberCheckStateIfConfigured("7")).resolves.toMatchObject({
      principal_id: "7",
      principal: { current_strikes: 1 },
    });
    await expect(
      reinstateCyberCheckClientInstanceIfConfigured("7", "installation/1")
    ).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/principals/7/cyber-state");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "/v1/principals/7/client-instances/installation%2F1/reinstatement"
    );
  });
});
