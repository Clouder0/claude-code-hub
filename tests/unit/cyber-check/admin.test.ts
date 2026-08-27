import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getEnvConfig: vi.fn() }));

vi.mock("@/lib/config/env.schema", () => ({ getEnvConfig: mocks.getEnvConfig }));

import { reinstateCyberCheckPrincipalIfConfigured } from "@/lib/cyber-check/admin";

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

    await reinstateCyberCheckPrincipalIfConfigured("7");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:8090/v1/principals/7/reinstatement"
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("is a no-op only when the integration is explicitly off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getEnvConfig.mockReturnValue(env("off"));

    await reinstateCyberCheckPrincipalIfConfigured("7");

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
});
