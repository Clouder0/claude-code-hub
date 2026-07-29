import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EnvSnapshot = Partial<Record<string, string | undefined>>;

function snapshotEnv(keys: string[]): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("drizzle/db 连接池配置", () => {
  const databaseStateKey = Symbol.for("claude-code-hub.database-state");
  const envKeys = [
    "NODE_ENV",
    "DSN",
    "DB_POOL_MAX",
    "DB_POOL_IDLE_TIMEOUT",
    "DB_POOL_CONNECT_TIMEOUT",
    "MESSAGE_REQUEST_WRITE_MODE",
  ];

  const postgresMock = vi.fn();
  const drizzleMock = vi.fn(() => ({ __db: true }));
  const endMock = vi.fn(async () => undefined);
  const postgresClient = { end: endMock };
  const loggerMock = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };

  const originalEnv = snapshotEnv(envKeys);

  beforeEach(() => {
    vi.resetModules();
    postgresMock.mockReset();
    drizzleMock.mockReset();
    endMock.mockClear();
    for (const method of Object.values(loggerMock)) {
      method.mockClear();
    }
    delete (globalThis as Record<PropertyKey, unknown>)[databaseStateKey];

    // 确保每个用例有一致的基础环境
    process.env.DSN = "postgres://postgres:postgres@localhost:5432/claude_code_hub_test";
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";
    delete process.env.DB_POOL_MAX;
    delete process.env.DB_POOL_IDLE_TIMEOUT;
    delete process.env.DB_POOL_CONNECT_TIMEOUT;

    postgresMock.mockReturnValue(postgresClient);
    drizzleMock.mockReturnValue({ __db: true });

    vi.doMock("postgres", () => ({ default: postgresMock }));
    vi.doMock("drizzle-orm/postgres-js", () => ({
      drizzle: drizzleMock,
    }));
    vi.doMock("@/lib/logger", () => ({ logger: loggerMock }));
  });

  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[databaseStateKey];
    restoreEnv(originalEnv);
  });

  it("生产环境默认 max=20、idle_timeout=20、connect_timeout=10", async () => {
    process.env.NODE_ENV = "production";

    const { getDb } = await import("@/drizzle/db");
    getDb();

    expect(postgresMock).toHaveBeenCalledWith(
      process.env.DSN,
      expect.objectContaining({
        max: 20,
        idle_timeout: 20,
        connect_timeout: 10,
        fetch_types: false,
      })
    );
  });

  it("开发环境默认 max=10", async () => {
    process.env.NODE_ENV = "development";

    const { getDb } = await import("@/drizzle/db");
    getDb();

    expect(postgresMock).toHaveBeenCalledWith(
      process.env.DSN,
      expect.objectContaining({
        max: 10,
      })
    );
  });

  it("支持通过 env 覆盖连接池参数", async () => {
    process.env.NODE_ENV = "production";
    process.env.DB_POOL_MAX = "50";
    process.env.DB_POOL_IDLE_TIMEOUT = "30";
    process.env.DB_POOL_CONNECT_TIMEOUT = "5";

    const { getDb } = await import("@/drizzle/db");
    getDb();

    expect(postgresMock).toHaveBeenCalledWith(
      process.env.DSN,
      expect.objectContaining({
        max: 50,
        idle_timeout: 30,
        connect_timeout: 5,
      })
    );
  });

  it("reuses one postgres client when independently loaded module copies share a process", async () => {
    process.env.NODE_ENV = "production";

    const firstModule = await import("@/drizzle/db");
    const firstDb = firstModule.getDb();

    vi.resetModules();
    const secondModule = await import("@/drizzle/db");
    const secondDb = secondModule.getDb();

    expect(secondDb).toBe(firstDb);
    expect(postgresMock).toHaveBeenCalledTimes(1);
    expect(drizzleMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a conflicting pool configuration instead of creating another client", async () => {
    process.env.NODE_ENV = "production";
    process.env.DB_POOL_MAX = "10";

    const firstModule = await import("@/drizzle/db");
    firstModule.getDb();

    process.env.DB_POOL_MAX = "11";
    vi.resetModules();
    const secondModule = await import("@/drizzle/db");

    expect(() => secondModule.getDb()).toThrow(/configuration/i);
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });

  it("closes the shared client once and does not resurrect it", async () => {
    process.env.NODE_ENV = "production";

    const databaseModule = await import("@/drizzle/db");
    databaseModule.getDb();

    await Promise.all([databaseModule.closeDatabase(), databaseModule.closeDatabase()]);

    expect(endMock).toHaveBeenCalledTimes(1);
    expect(endMock).toHaveBeenCalledWith({ timeout: 2 });
    expect(() => databaseModule.getDb()).toThrow(/closed|closing/i);
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });
});
