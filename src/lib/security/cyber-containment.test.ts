import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(async () => "OK"),
  redisStatus: "ready",
  dbExecute: vi.fn(),
  insertSecurityEvent: vi.fn(async () => {}),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () =>
    mocks.redisStatus === "ready"
      ? { get: mocks.redisGet, set: mocks.redisSet, status: "ready" }
      : null,
}));

vi.mock("@/drizzle/db", () => ({
  db: { execute: mocks.dbExecute },
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

import {
  blockSessionForCyberPolicy,
  containCyberPolicy,
  CYBER_POLICY_DISABLE_THRESHOLD,
  CYBER_SESSION_BLOCK_TTL_MS,
  isSessionCyberBlocked,
  maybeDisableUserForCyberPolicy,
} from "./cyber-containment";

describe("cyber containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("session block", () => {
    it("writes the session block key with the 24h TTL", async () => {
      await blockSessionForCyberPolicy("sess_abc");
      expect(mocks.redisSet).toHaveBeenCalledWith(
        "session:sess_abc:cyber_blocked",
        "1",
        "EX",
        Math.ceil(CYBER_SESSION_BLOCK_TTL_MS / 1000)
      );
    });

    it("reports a blocked session from Redis", async () => {
      mocks.redisGet.mockResolvedValueOnce("1");
      await expect(isSessionCyberBlocked("sess_abc")).resolves.toBe(true);
      expect(mocks.redisGet).toHaveBeenCalledWith("session:sess_abc:cyber_blocked");
    });

    it("reports an unblocked session when Redis has no key", async () => {
      mocks.redisGet.mockResolvedValueOnce(null);
      await expect(isSessionCyberBlocked("sess_abc")).resolves.toBe(false);
    });

    it("degrades to unblocked when Redis is unavailable", async () => {
      mocks.redisStatus = "down";
      await expect(isSessionCyberBlocked("sess_abc")).resolves.toBe(false);
      await blockSessionForCyberPolicy("sess_abc");
      expect(mocks.redisSet).not.toHaveBeenCalled();
      mocks.redisStatus = "ready";
    });

    it("contains Redis failures without throwing", async () => {
      mocks.redisSet.mockRejectedValueOnce(new Error("redis down"));
      await expect(blockSessionForCyberPolicy("sess_abc")).resolves.toBeUndefined();
      mocks.redisGet.mockRejectedValueOnce(new Error("redis down"));
      await expect(isSessionCyberBlocked("sess_abc")).resolves.toBe(false);
    });
  });

  describe("user strike disable", () => {
    it("disables the user when the threshold is reached", async () => {
      mocks.dbExecute.mockResolvedValueOnce([{ id: 7 }]);
      await expect(maybeDisableUserForCyberPolicy(7)).resolves.toBe(true);
      expect(mocks.warn).toHaveBeenCalledWith(
        "[CyberContainment] User auto-disabled after cyber policy strikes",
        { userId: 7, threshold: CYBER_POLICY_DISABLE_THRESHOLD }
      );
    });

    it("leaves the user enabled below the threshold", async () => {
      mocks.dbExecute.mockResolvedValueOnce([]);
      await expect(maybeDisableUserForCyberPolicy(7)).resolves.toBe(false);
      expect(mocks.warn).not.toHaveBeenCalled();
    });

    it("contains database failures without throwing", async () => {
      mocks.dbExecute.mockRejectedValueOnce(new Error("db down"));
      await expect(maybeDisableUserForCyberPolicy(7)).resolves.toBe(false);
      expect(mocks.error).toHaveBeenCalled();
    });
  });

  describe("containCyberPolicy", () => {
    const session = {
      sessionId: "sess_abc",
      messageContext: { id: 42, user: { id: 7 } },
    };

    it("records the event, blocks the session, and evaluates the strike", async () => {
      mocks.dbExecute.mockResolvedValueOnce([]);
      await containCyberPolicy(session);

      expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "cyber_policy");
      expect(mocks.redisSet).toHaveBeenCalledWith(
        "session:sess_abc:cyber_blocked",
        "1",
        "EX",
        expect.any(Number)
      );
      expect(mocks.dbExecute).toHaveBeenCalledTimes(1);
    });

    it("skips the session block without a session id", async () => {
      mocks.dbExecute.mockResolvedValueOnce([]);
      await containCyberPolicy({ sessionId: null, messageContext: session.messageContext });
      expect(mocks.redisSet).not.toHaveBeenCalled();
      expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "cyber_policy");
    });

    it("skips the strike evaluation without a user", async () => {
      await containCyberPolicy({ sessionId: "sess_abc", messageContext: null });
      expect(mocks.insertSecurityEvent).not.toHaveBeenCalled();
      expect(mocks.redisSet).toHaveBeenCalled();
      expect(mocks.dbExecute).not.toHaveBeenCalled();
    });
  });
});
