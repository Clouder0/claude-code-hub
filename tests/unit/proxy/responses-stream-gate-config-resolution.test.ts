import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnvConfig: vi.fn(),
}));

vi.mock("@/lib/config/env.schema", () => ({
  getEnvConfig: mocks.getEnvConfig,
}));

import {
  DEFAULT_RESPONSES_STREAM_GATE_CAPS,
  resolveResponsesStreamGateCaps,
  resolveResponsesStreamGateMode,
} from "@/app/v1/_lib/proxy/stream-gate/responses-content-gate";

describe("Responses stream gate runtime config resolution", () => {
  beforeEach(() => {
    mocks.getEnvConfig.mockReset();
  });

  it("falls back field by field when an existing partial config mock omits new settings", () => {
    mocks.getEnvConfig.mockReturnValue({ NODE_ENV: "test" });

    expect(resolveResponsesStreamGateMode()).toBe("enforce");
    expect(resolveResponsesStreamGateCaps()).toEqual(DEFAULT_RESPONSES_STREAM_GATE_CAPS);
  });

  it("keeps valid fields while replacing invalid fields with bounded defaults", () => {
    mocks.getEnvConfig.mockReturnValue({
      STREAM_GATE_MODE: "shadow",
      STREAM_GATE_PREBUFFER_EVENT_CAP: 12,
      STREAM_GATE_PREBUFFER_BYTE_CAP: 0,
      STREAM_GATE_REQUEST_ECHO_BYTE_CAP: Number.POSITIVE_INFINITY,
    });

    expect(resolveResponsesStreamGateMode()).toBe("shadow");
    expect(resolveResponsesStreamGateCaps()).toEqual({
      prebufferEventCap: 12,
      prebufferByteCap: DEFAULT_RESPONSES_STREAM_GATE_CAPS.prebufferByteCap,
      requestEchoByteCap: DEFAULT_RESPONSES_STREAM_GATE_CAPS.requestEchoByteCap,
    });
  });

  it.each(["off", "enforce"] as const)("keeps the valid %s mode", (mode) => {
    mocks.getEnvConfig.mockReturnValue({ STREAM_GATE_MODE: mode });

    expect(resolveResponsesStreamGateMode()).toBe(mode);
  });

  it("falls back when config loading throws", () => {
    mocks.getEnvConfig.mockImplementation(() => {
      throw new Error("config unavailable");
    });

    expect(resolveResponsesStreamGateMode()).toBe("enforce");
    expect(resolveResponsesStreamGateCaps()).toEqual(DEFAULT_RESPONSES_STREAM_GATE_CAPS);
  });
});
