import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnvConfig: vi.fn(),
  redisMget: vi.fn(async (): Promise<(string | null)[]> => [null, null]),
  redisSet: vi.fn(async () => "OK"),
  redisStatus: "ready",
  dbExecute: vi.fn(),
  insertSecurityEvent: vi.fn(async () => {}),
  invalidateCachedUser: vi.fn(async () => {}),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/config/env.schema", () => ({ getEnvConfig: mocks.getEnvConfig }));

vi.mock("@/lib/redis", () => ({
  getRedisClient: () =>
    mocks.redisStatus === "ready"
      ? {
          mget: mocks.redisMget,
          set: mocks.redisSet,
          status: "ready",
        }
      : null,
}));

vi.mock("@/drizzle/db", () => ({
  db: { execute: mocks.dbExecute },
}));

vi.mock("@/repository/security-events", () => ({
  insertSecurityEvent: mocks.insertSecurityEvent,
}));

vi.mock("@/lib/security/api-key-auth-cache", () => ({
  invalidateCachedUser: mocks.invalidateCachedUser,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: mocks.warn,
    error: mocks.error,
  },
}));

import {
  blockSessionForPolicyRejection,
  containPolicyRejection,
  disableUserForCyberCheckContainment,
  findSessionBlockPolicy,
  POLICY_SESSION_BLOCK_TTL_MS,
} from "./policy-containment";

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(sqlText).join("");
  if (!value || typeof value !== "object") return "";
  const node = value as { queryChunks?: unknown; value?: unknown };
  if (node.queryChunks !== undefined) return sqlText(node.queryChunks);
  if (node.value !== undefined) return sqlText(node.value);
  return "";
}

describe("policy containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvConfig.mockReturnValue({ CYBER_CHECK_MODE: "shadow" });
  });

  describe("session block", () => {
    it("writes the cyber session block key with the 24h TTL", async () => {
      await blockSessionForPolicyRejection("sess_abc", "cyber_policy");
      expect(mocks.redisSet).toHaveBeenCalledWith(
        "session:sess_abc:cyber_blocked",
        "1",
        "EX",
        Math.ceil(POLICY_SESSION_BLOCK_TTL_MS / 1000)
      );
    });

    it("writes the bio session block key with the same TTL", async () => {
      await blockSessionForPolicyRejection("sess_bio", "bio_policy");
      expect(mocks.redisSet).toHaveBeenCalledWith(
        "session:sess_bio:bio_blocked",
        "1",
        "EX",
        Math.ceil(POLICY_SESSION_BLOCK_TTL_MS / 1000)
      );
    });

    it("reads the block state with one MGET in POLICY_REJECTION_CODES order", async () => {
      mocks.redisMget.mockResolvedValueOnce(["1", null]);
      await expect(findSessionBlockPolicy("sess_abc")).resolves.toBe("cyber_policy");
      expect(mocks.redisMget).toHaveBeenCalledTimes(1);
      expect(mocks.redisMget).toHaveBeenCalledWith(
        "session:sess_abc:cyber_blocked",
        "session:sess_abc:bio_blocked"
      );
    });

    it("a cyber block does not read as a bio block and vice versa", async () => {
      mocks.redisMget.mockResolvedValueOnce(["1", null]);
      await expect(findSessionBlockPolicy("sess_abc")).resolves.toBe("cyber_policy");

      mocks.redisMget.mockResolvedValueOnce([null, "1"]);
      await expect(findSessionBlockPolicy("sess_abc")).resolves.toBe("bio_policy");
    });

    it("returns null when no block key exists", async () => {
      mocks.redisMget.mockResolvedValueOnce([null, null]);
      await expect(findSessionBlockPolicy("sess_abc")).resolves.toBeNull();
    });

    it("prefers cyber when both block keys exist", async () => {
      mocks.redisMget.mockResolvedValueOnce(["1", "1"]);
      await expect(findSessionBlockPolicy("sess_abc")).resolves.toBe("cyber_policy");
    });

    it("degrades to unblocked when Redis is unavailable", async () => {
      mocks.redisStatus = "down";
      await expect(findSessionBlockPolicy("sess_abc")).resolves.toBeNull();
      await blockSessionForPolicyRejection("sess_abc", "bio_policy");
      expect(mocks.redisSet).not.toHaveBeenCalled();
      mocks.redisStatus = "ready";
    });

    it("contains Redis failures without throwing", async () => {
      mocks.redisSet.mockRejectedValueOnce(new Error("redis down"));
      await expect(
        blockSessionForPolicyRejection("sess_abc", "cyber_policy")
      ).resolves.toBeUndefined();
      mocks.redisMget.mockRejectedValueOnce(new Error("redis down"));
      await expect(findSessionBlockPolicy("sess_abc")).resolves.toBeNull();
    });
  });

  describe("authoritative Cyber Check principal containment", () => {
    it("disables the complete user immediately and invalidates authentication", async () => {
      mocks.dbExecute.mockResolvedValueOnce([{ id: 7 }]);

      await expect(disableUserForCyberCheckContainment(7)).resolves.toBe(true);

      expect(mocks.invalidateCachedUser).toHaveBeenCalledWith(7);
      expect(sqlText(mocks.dbExecute.mock.calls[0]?.[0])).toContain("WHERE id =");
      expect(sqlText(mocks.dbExecute.mock.calls[0]?.[0])).toContain("deleted_at IS NULL");
    });

    it("is idempotent when the user is already disabled", async () => {
      mocks.dbExecute.mockResolvedValueOnce([]);

      await expect(disableUserForCyberCheckContainment(7)).resolves.toBe(false);
      expect(mocks.invalidateCachedUser).not.toHaveBeenCalled();
    });
  });

  describe("containPolicyRejection", () => {
    const session = {
      sessionId: "sess_abc",
      messageContext: { id: 42, user: { id: 7 } },
    };

    it("cyber shadow: records audit only and creates no executable local containment", async () => {
      await containPolicyRejection(session, "cyber_policy");

      expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "cyber_policy");
      expect(mocks.redisSet).not.toHaveBeenCalled();
      expect(mocks.dbExecute).not.toHaveBeenCalled();
    });

    it("cyber enforce: leaves every cyber restriction and strike to Cyber Check", async () => {
      mocks.getEnvConfig.mockReturnValue({ CYBER_CHECK_MODE: "enforce" });
      await containPolicyRejection(session, "cyber_policy");

      expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "cyber_policy");
      expect(mocks.redisSet).not.toHaveBeenCalled();
      expect(mocks.dbExecute).not.toHaveBeenCalled();
    });

    it("cyber off: preserves the legacy local session block without local strikes", async () => {
      mocks.getEnvConfig.mockReturnValue({ CYBER_CHECK_MODE: "off" });
      await containPolicyRejection(session, "cyber_policy");

      expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "cyber_policy");
      expect(mocks.redisSet).toHaveBeenCalledWith(
        "session:sess_abc:cyber_blocked",
        "1",
        "EX",
        expect.any(Number)
      );
      expect(mocks.dbExecute).not.toHaveBeenCalled();
    });

    it("bio: records the event and blocks the session without evaluating a strike", async () => {
      await containPolicyRejection(session, "bio_policy");

      expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "bio_policy");
      expect(mocks.redisSet).toHaveBeenCalledWith(
        "session:sess_abc:bio_blocked",
        "1",
        "EX",
        expect.any(Number)
      );
      // 关键差异：bio 不参与罢工禁用，绝不触发用户禁用 UPDATE。
      expect(mocks.dbExecute).not.toHaveBeenCalled();
      expect(mocks.invalidateCachedUser).not.toHaveBeenCalled();
    });

    it("bio containment stays strike-free across repeated confirmations", async () => {
      await containPolicyRejection(session, "bio_policy");
      await containPolicyRejection(session, "bio_policy");
      await containPolicyRejection(session, "bio_policy");
      expect(mocks.insertSecurityEvent).toHaveBeenCalledTimes(3);
      expect(mocks.dbExecute).not.toHaveBeenCalled();
    });

    it("skips the session block without a session id", async () => {
      await containPolicyRejection(
        { sessionId: null, messageContext: session.messageContext },
        "cyber_policy"
      );
      expect(mocks.redisSet).not.toHaveBeenCalled();
      expect(mocks.insertSecurityEvent).toHaveBeenCalledWith(7, 42, "cyber_policy");
    });

    it("keeps cyber audit best effort without a user and never runs local punishment", async () => {
      await containPolicyRejection({ sessionId: "sess_abc", messageContext: null }, "cyber_policy");
      expect(mocks.insertSecurityEvent).not.toHaveBeenCalled();
      expect(mocks.redisSet).not.toHaveBeenCalled();
      expect(mocks.dbExecute).not.toHaveBeenCalled();
    });
  });
});
