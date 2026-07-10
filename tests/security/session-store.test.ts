import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRedisClientMock, loggerMock } = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  loggerMock: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

const ORIGINAL_AUTH_SESSION_TTL_SECONDS = process.env.AUTH_SESSION_TTL_SECONDS;

vi.mock("@/lib/redis", () => ({
  getRedisClient: getRedisClientMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: loggerMock,
}));

class FakeRedis {
  status: "ready" | "end" | "connecting" | "reconnecting" = "ready";
  readonly store = new Map<string, string>();
  readonly ttlByKey = new Map<string, number>();
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  throwOnGet = false;
  throwOnSetex = false;
  throwOnDel = false;

  readonly get = vi.fn(async (key: string) => {
    if (this.throwOnGet) throw new Error("redis get failed");
    return this.store.get(key) ?? null;
  });

  readonly setex = vi.fn(async (key: string, ttlSeconds: number, value: string) => {
    if (this.throwOnSetex) throw new Error("redis setex failed");
    this.store.set(key, value);
    this.ttlByKey.set(key, ttlSeconds);
    return "OK";
  });

  readonly del = vi.fn(async (key: string) => {
    if (this.throwOnDel) throw new Error("redis del failed");
    const existed = this.store.delete(key);
    this.ttlByKey.delete(key);
    return existed ? 1 : 0;
  });

  on(eventName: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(eventName) ?? new Set<(...args: unknown[]) => void>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return this;
  }

  once(eventName: string, listener: (...args: unknown[]) => void) {
    const wrapper = (...args: unknown[]) => {
      this.off(eventName, wrapper);
      listener(...args);
    };
    return this.on(eventName, wrapper);
  }

  off(eventName: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(eventName)?.delete(listener);
    return this;
  }

  emit(eventName: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(eventName) ?? [])]) {
      listener(...args);
    }
  }
}

describe("RedisSessionStore", () => {
  let redis: FakeRedis;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-18T10:00:00.000Z"));
    vi.clearAllMocks();

    redis = new FakeRedis();
    getRedisClientMock.mockReturnValue(redis);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (ORIGINAL_AUTH_SESSION_TTL_SECONDS === undefined) {
      delete process.env.AUTH_SESSION_TTL_SECONDS;
    } else {
      process.env.AUTH_SESSION_TTL_SECONDS = ORIGINAL_AUTH_SESSION_TTL_SECONDS;
    }
    vi.resetModules();
  });

  it("create() returns session data with generated sessionId", async () => {
    const { DEFAULT_SESSION_TTL } = await import("@/lib/auth-session-store");
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const store = new RedisSessionStore();
    const created = await store.create({
      keyFingerprint: "fp-1",
      credentialType: "user-api-key",
      userId: 101,
      userRole: "user",
    });

    expect(created.sessionId).toMatch(/^sid_[0-9a-f-]{36}$/i);
    expect(created.keyFingerprint).toBe("fp-1");
    expect(created.credentialType).toBe("user-api-key");
    expect(created.userId).toBe(101);
    expect(created.userRole).toBe("user");
    expect(created.createdAt).toBe(new Date("2026-02-18T10:00:00.000Z").getTime());
    expect(created.expiresAt).toBe(created.createdAt + DEFAULT_SESSION_TTL * 1000);
  });

  it("create() normalizes old browser transport labels to database-key provenance", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const store = new RedisSessionStore();
    const created = await store.create({
      keyFingerprint: "fp-old-browser-label",
      credentialType: "session",
      userId: 101,
      userRole: "admin",
    });

    expect(created.credentialType).toBe("user-api-key");
    expect(JSON.parse(redis.store.get(`cch:session:${created.sessionId}`) ?? "{}")).toMatchObject({
      credentialType: "user-api-key",
    });
  });

  it("read() returns data for existing session", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const session = {
      sessionId: "6b5097ff-a11e-4425-aad0-f57f7d2206fc",
      keyFingerprint: "fp-existing",
      credentialType: "admin-token",
      userId: -1,
      userRole: "admin",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_360_000,
    };
    redis.store.set(`cch:session:${session.sessionId}`, JSON.stringify(session));

    const store = new RedisSessionStore();
    const found = await store.read(session.sessionId);

    expect(found).toEqual(session);
  });

  it("read() waits briefly for a connecting Redis client before treating the session as missing", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const session = {
      sessionId: "cold-start-session",
      keyFingerprint: "fp-cold-start",
      credentialType: "user-api-key" as const,
      userId: 7,
      userRole: "user",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_360_000,
    };
    redis.store.set(`cch:session:${session.sessionId}`, JSON.stringify(session));
    redis.status = "connecting";

    const store = new RedisSessionStore({ redisReadyWaitMs: 1_000 });
    const pendingRead = store.read(session.sessionId);

    await Promise.resolve();
    expect(redis.get).not.toHaveBeenCalled();

    redis.status = "ready";
    redis.emit("ready");

    await expect(pendingRead).resolves.toEqual(session);
    expect(redis.get).toHaveBeenCalledWith(`cch:session:${session.sessionId}`);
  });

  it("read() keeps waiting while Redis reconnects after transient connection failures", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const session = {
      sessionId: "reconnecting-session",
      keyFingerprint: "fp-reconnecting",
      credentialType: "user-api-key" as const,
      userId: 8,
      userRole: "user",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_360_000,
    };
    redis.store.set(`cch:session:${session.sessionId}`, JSON.stringify(session));
    redis.status = "connecting";

    const store = new RedisSessionStore({ redisReadyWaitMs: 1_000 });
    const pendingRead = store.read(session.sessionId);

    await Promise.resolve();
    redis.emit("error", new Error("connection refused"));
    redis.emit("close");
    redis.status = "reconnecting";
    await Promise.resolve();

    expect(redis.get).not.toHaveBeenCalled();

    redis.status = "ready";
    redis.emit("ready");

    await expect(pendingRead).resolves.toEqual(session);
    expect(redis.get).toHaveBeenCalledWith(`cch:session:${session.sessionId}`);
    expect(redis.listeners.get("ready")?.size ?? 0).toBe(0);
    expect(redis.listeners.get("end")?.size ?? 0).toBe(0);
  });

  it("read() downgrades old browser transport labels to database-key provenance", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const session = {
      sessionId: "browser-admin-session",
      keyFingerprint: "fp-browser",
      credentialType: "session",
      userId: 7,
      userRole: "admin",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_360_000,
    };
    redis.store.set(`cch:session:${session.sessionId}`, JSON.stringify(session));

    const store = new RedisSessionStore();
    const found = await store.read(session.sessionId);

    expect(found).toEqual({ ...session, credentialType: "user-api-key" });
  });

  it("read() classifies legacy admin opaque sessions without credentialType as admin-token", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const legacyAdminSession = {
      sessionId: "legacy-admin-session",
      keyFingerprint: "fp-admin",
      userId: -1,
      userRole: "admin",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_360_000,
    };
    redis.store.set(
      `cch:session:${legacyAdminSession.sessionId}`,
      JSON.stringify(legacyAdminSession)
    );

    const store = new RedisSessionStore();
    const found = await store.read(legacyAdminSession.sessionId);

    expect(found).toMatchObject({
      ...legacyAdminSession,
      credentialType: "admin-token",
    });
  });

  it("read() classifies legacy opaque browser sessions without credentialType as user-api-key", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const legacyUserSession = {
      sessionId: "legacy-user-session",
      keyFingerprint: "fp-user",
      userId: 12,
      userRole: "admin",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_360_000,
    };
    redis.store.set(
      `cch:session:${legacyUserSession.sessionId}`,
      JSON.stringify(legacyUserSession)
    );

    const store = new RedisSessionStore();
    const found = await store.read(legacyUserSession.sessionId);

    expect(found).toMatchObject({
      ...legacyUserSession,
      credentialType: "user-api-key",
    });
  });

  it("read() returns null for non-existent session", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const store = new RedisSessionStore();
    const found = await store.read("missing-session");

    expect(found).toBeNull();
  });

  it("read() returns null when Redis read fails", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    redis.throwOnGet = true;
    const store = new RedisSessionStore();
    const found = await store.read("any-session");

    expect(found).toBeNull();
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it("revoke() deletes session", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const sessionId = "f327f4f4-c95f-40ab-a017-af714df7a3f8";
    redis.store.set(`cch:session:${sessionId}`, JSON.stringify({ sessionId }));

    const store = new RedisSessionStore();
    const revoked = await store.revoke(sessionId);

    expect(revoked).toBe(true);
    expect(redis.store.has(`cch:session:${sessionId}`)).toBe(false);
  });

  it("rotate() creates new session and revokes old session", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const oldSession = {
      sessionId: "e7f7bf87-c3b9-4525-ac0c-c2cf7cd5006b",
      keyFingerprint: "fp-rotate",
      credentialType: "user-api-key" as const,
      userId: 18,
      userRole: "user",
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() + 120_000,
    };
    redis.store.set(`cch:session:${oldSession.sessionId}`, JSON.stringify(oldSession));

    const store = new RedisSessionStore();
    const rotated = await store.rotate(oldSession.sessionId);

    expect(rotated).not.toBeNull();
    expect(rotated?.sessionId).not.toBe(oldSession.sessionId);
    expect(rotated?.keyFingerprint).toBe(oldSession.keyFingerprint);
    expect(rotated?.credentialType).toBe(oldSession.credentialType);
    expect(rotated?.userId).toBe(oldSession.userId);
    expect(rotated?.userRole).toBe(oldSession.userRole);
    expect(redis.store.has(`cch:session:${oldSession.sessionId}`)).toBe(false);
    expect(rotated ? redis.store.has(`cch:session:${rotated.sessionId}`) : false).toBe(true);
  });

  it("create() applies TTL and stores expiresAt deterministically", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const store = new RedisSessionStore();
    const created = await store.create(
      { keyFingerprint: "fp-ttl", credentialType: "user-api-key", userId: 9, userRole: "user" },
      120
    );

    const key = `cch:session:${created.sessionId}`;
    expect(redis.ttlByKey.get(key)).toBe(120);
    expect(created.expiresAt - created.createdAt).toBe(120_000);
  });

  it("create() uses AUTH_SESSION_TTL_SECONDS as the default TTL", async () => {
    process.env.AUTH_SESSION_TTL_SECONDS = "3600";
    vi.resetModules();
    getRedisClientMock.mockReturnValue(redis);
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const store = new RedisSessionStore();
    const created = await store.create({
      keyFingerprint: "fp-env-ttl",
      credentialType: "user-api-key",
      userId: 9,
      userRole: "user",
    });

    const key = `cch:session:${created.sessionId}`;
    expect(redis.ttlByKey.get(key)).toBe(3600);
    expect(created.expiresAt - created.createdAt).toBe(3_600_000);
  });

  it("create() throws when Redis setex fails", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    redis.throwOnSetex = true;
    const store = new RedisSessionStore();

    await expect(
      store.create({
        keyFingerprint: "fp-fail",
        credentialType: "user-api-key",
        userId: 3,
        userRole: "user",
      })
    ).rejects.toThrow("redis setex failed");
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it("create() throws when Redis is not ready", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    redis.status = "end";
    const store = new RedisSessionStore();

    await expect(
      store.create({
        keyFingerprint: "fp-noredis",
        credentialType: "user-api-key",
        userId: 4,
        userRole: "user",
      })
    ).rejects.toThrow("Redis not ready");
  });

  it("rotate() returns null when Redis setex fails during create", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const oldSession = {
      sessionId: "2a036ab4-902a-4f31-a782-ec18344e17b9",
      keyFingerprint: "fp-failure",
      credentialType: "user-api-key" as const,
      userId: 3,
      userRole: "user",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    redis.store.set(`cch:session:${oldSession.sessionId}`, JSON.stringify(oldSession));
    redis.throwOnSetex = true;

    const store = new RedisSessionStore();
    const rotated = await store.rotate(oldSession.sessionId);

    expect(rotated).toBeNull();
    expect(redis.store.has(`cch:session:${oldSession.sessionId}`)).toBe(true);
    expect(loggerMock.error).toHaveBeenCalled();
  });

  it("rotate() keeps new session when old session revocation fails", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const oldSession = {
      sessionId: "aaa-old-session",
      keyFingerprint: "fp-revoke-fail",
      credentialType: "user-api-key" as const,
      userId: 5,
      userRole: "user",
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() + 120_000,
    };
    redis.store.set(`cch:session:${oldSession.sessionId}`, JSON.stringify(oldSession));
    redis.throwOnDel = true;

    const store = new RedisSessionStore();
    const rotated = await store.rotate(oldSession.sessionId);

    expect(rotated).not.toBeNull();
    expect(rotated?.keyFingerprint).toBe(oldSession.keyFingerprint);
    expect(rotated?.credentialType).toBe(oldSession.credentialType);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it("rotate() returns null for already-expired session", async () => {
    const { RedisSessionStore } = await import("@/lib/auth-session-store/redis-session-store");

    const expiredSession = {
      sessionId: "bbb-expired-session",
      keyFingerprint: "fp-expired",
      credentialType: "user-api-key" as const,
      userId: 6,
      userRole: "user",
      createdAt: Date.now() - 120_000,
      expiresAt: Date.now() - 1_000,
    };
    redis.store.set(`cch:session:${expiredSession.sessionId}`, JSON.stringify(expiredSession));

    const store = new RedisSessionStore();
    const rotated = await store.rotate(expiredSession.sessionId);

    expect(rotated).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "[AuthSessionStore] Cannot rotate expired session",
      expect.objectContaining({ sessionId: expiredSession.sessionId })
    );
  });
});
