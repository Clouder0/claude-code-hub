import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  insertSecurityEvent: vi.fn(async () => {}),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/repository/security-events", () => ({
  insertSecurityEvent: mocks.insertSecurityEvent,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import { recordSecurityEventBestEffort } from "./security-event-recorder";

describe("security event recorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a fact against the user and message request", async () => {
    await recordSecurityEventBestEffort(7, 42, "cyber_policy");
    expect(mocks.insertSecurityEvent).toHaveBeenCalledTimes(1);
    expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "cyber_policy");
  });

  it("records a fact with a null request link", async () => {
    await recordSecurityEventBestEffort(7, null, "cyber_safety_check");
    expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, null, "cyber_safety_check");
  });

  it("does not attempt an unattributed write", async () => {
    await recordSecurityEventBestEffort(null, 42, "cyber_policy");
    expect(mocks.insertSecurityEvent).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith("[SecurityEvent] Cannot attribute event without user", {
      type: "cyber_policy",
    });
  });

  it("contains persistence failures without changing proxy control flow", async () => {
    mocks.insertSecurityEvent.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(recordSecurityEventBestEffort(7, 42, "cyber_policy")).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith(
      "[SecurityEvent] Failed to persist event",
      expect.objectContaining({
        userId: 7,
        messageRequestId: 42,
        type: "cyber_policy",
        error: "database unavailable",
      })
    );
  });

  it("logs non-Error persistence failures without exposing event content", async () => {
    mocks.insertSecurityEvent.mockRejectedValueOnce("database unavailable");
    await expect(
      recordSecurityEventBestEffort(7, 42, "cyber_safety_check")
    ).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith("[SecurityEvent] Failed to persist event", {
      userId: 7,
      messageRequestId: 42,
      type: "cyber_safety_check",
      error: "database unavailable",
    });
  });
});
