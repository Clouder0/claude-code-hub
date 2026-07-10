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

function toSqlText(query: { toQuery: (config: any) => { sql: string; params: unknown[] } }) {
  return query.toQuery({
    escapeName: (name: string) => `"${name}"`,
    escapeParam: (index: number) => `$${index}`,
    escapeString: (value: string) => `'${value}'`,
    paramStartIndex: { value: 1 },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("message_request 异步批量写入", () => {
  const envKeys = [
    "NODE_ENV",
    "DSN",
    "MESSAGE_REQUEST_WRITE_MODE",
    "MESSAGE_REQUEST_ASYNC_FLUSH_INTERVAL_MS",
    "MESSAGE_REQUEST_ASYNC_BATCH_SIZE",
    "MESSAGE_REQUEST_ASYNC_MAX_PENDING",
  ];
  const originalEnv = snapshotEnv(envKeys);

  const executeMock = vi.fn(async () => []);

  beforeEach(() => {
    vi.resetModules();
    executeMock.mockClear();

    process.env.NODE_ENV = "test";
    process.env.DSN = "postgres://postgres:postgres@localhost:5432/claude_code_hub_test";
    process.env.MESSAGE_REQUEST_ASYNC_FLUSH_INTERVAL_MS = "60000";
    process.env.MESSAGE_REQUEST_ASYNC_BATCH_SIZE = "1000";
    process.env.MESSAGE_REQUEST_ASYNC_MAX_PENDING = "1000";

    vi.doMock("@/drizzle/db", () => ({
      db: {
        execute: executeMock,
        // 避免 tests/setup.ts 的 afterAll 清理逻辑因 mock 缺失 select 而报错
        select: () => ({
          from: () => ({
            where: async () => [],
          }),
        }),
      },
    }));
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("sync 模式下不应入队/写库", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "sync";

    const { enqueueMessageRequestUpdate, flushMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );

    enqueueMessageRequestUpdate(1, { durationMs: 123 });
    await flushMessageRequestWriteBuffer();

    expect(executeMock).not.toHaveBeenCalled();
  });

  it("async 模式下应合并同一 id 的多次更新并批量写入", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const {
      enqueueMessageRequestUpdate,
      flushMessageRequestWriteBuffer,
      stopMessageRequestWriteBuffer,
    } = await import("@/repository/message-write-buffer");

    enqueueMessageRequestUpdate(42, { durationMs: 100 });
    enqueueMessageRequestUpdate(42, { statusCode: 200, ttfbMs: 10 });

    await flushMessageRequestWriteBuffer();
    await stopMessageRequestWriteBuffer();

    expect(executeMock).toHaveBeenCalledTimes(1);

    const query = executeMock.mock.calls[0]?.[0];
    const built = toSqlText(query);

    expect(built.sql).toContain("UPDATE message_request");
    expect(built.sql).toContain("duration_ms");
    expect(built.sql).toContain("status_code");
    expect(built.sql).toContain("ttfb_ms");
    expect(built.sql).toContain("updated_at");
    expect(built.sql).toContain("deleted_at IS NULL");
  });

  it("应在异步写入中保留观测 input、reported write=0 与核算来源", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const { enqueueMessageRequestUpdate, stopMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );

    enqueueMessageRequestUpdate(43, {
      statusCode: 200,
      observedInputTokens: 9016,
      cacheWriteTokensReported: 0,
      cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
    });

    await stopMessageRequestWriteBuffer();

    const built = toSqlText(executeMock.mock.calls[0]?.[0]);
    expect(built.sql).toContain("observed_input_tokens");
    expect(built.sql).toContain("cache_write_tokens_reported");
    expect(built.sql).toContain("cache_write_accounting");
    expect(built.params).toContain(9016);
    expect(built.params).toContain(0);
    expect(built.params).toContain("inferred_input_minus_cache_read_v1");
  });

  it("应对 costUsd/providerChain 做显式类型转换（numeric/jsonb）", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const { enqueueMessageRequestUpdate, stopMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );

    enqueueMessageRequestUpdate(7, {
      costUsd: "0.000123",
      providerChain: [{ id: 1, name: "p1" }],
    });

    await stopMessageRequestWriteBuffer();

    expect(executeMock).toHaveBeenCalledTimes(1);

    const query = executeMock.mock.calls[0]?.[0];
    const built = toSqlText(query);

    expect(built.sql).toContain("::numeric");
    expect(built.sql).toContain("::jsonb");
  });

  it("写入 buffered JSONB 字段前递归清理非法 key、value 和孤立 surrogate", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const { enqueueMessageRequestUpdate, stopMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );
    const providerChainEntry: Record<string, unknown> = {
      id: 1,
      name: "provider",
      body: "bad\u0000body\ud800 valid \u{1f600}",
    };
    Object.defineProperty(providerChainEntry, "bad\u0000key\udc00", {
      value: "kept",
      enumerable: true,
    });

    enqueueMessageRequestUpdate(8, {
      providerChain: [providerChainEntry],
      costBreakdown: {
        input: "0.01",
        output: "0.02",
        cache_creation: "0",
        cache_read: "0",
        base_total: "0.03",
        provider_multiplier: 1,
        group_multiplier: 1,
        total: "0.03\u0000",
      },
    });

    await stopMessageRequestWriteBuffer();

    const built = toSqlText(executeMock.mock.calls[0]?.[0]);
    const serializedParams = JSON.stringify(built.params);
    expect(serializedParams).not.toContain("\\u0000");
    expect(serializedParams).toContain("badbody\uFFFD valid \u{1f600}");
    expect(serializedParams).toContain("badkey\uFFFD");
  });

  it("异步 specialSettings 更新应单调保留已落库的 billing audit", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const { enqueueMessageRequestUpdate, stopMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );

    enqueueMessageRequestUpdate(9, { statusCode: 200, specialSettings: [] });
    await stopMessageRequestWriteBuffer();

    const built = toSqlText(executeMock.mock.calls[0]?.[0]);
    expect(built.sql).toContain("jsonb_array_elements");
    expect(built.sql).toContain("jsonb_build_array");
    expect(built.sql).toContain("special_settings");
    expect(built.sql).toContain("billing");
  });

  it("stop 应等待 in-flight flush 完成", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const deferred = createDeferred<unknown[]>();
    executeMock.mockImplementationOnce(async () => deferred.promise);

    const { enqueueMessageRequestUpdate, stopMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );

    enqueueMessageRequestUpdate(1, { durationMs: 123 });

    const stopPromise = stopMessageRequestWriteBuffer();

    expect(executeMock).toHaveBeenCalledTimes(1);

    const raced = await Promise.race([
      stopPromise.then(() => "stopped"),
      Promise.resolve("pending"),
    ]);
    expect(raced).toBe("pending");

    deferred.resolve([]);
    await stopPromise;
  });

  it("flush 进行中 enqueue 的更新应最终落库", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const firstExecute = createDeferred<unknown[]>();
    executeMock.mockImplementationOnce(async () => firstExecute.promise);
    executeMock.mockImplementationOnce(async () => []);

    const {
      enqueueMessageRequestUpdate,
      flushMessageRequestWriteBuffer,
      stopMessageRequestWriteBuffer,
    } = await import("@/repository/message-write-buffer");

    enqueueMessageRequestUpdate(42, { durationMs: 100 });

    const flushPromise = flushMessageRequestWriteBuffer();
    expect(executeMock).toHaveBeenCalledTimes(1);

    // 在第一次写入尚未完成时，追加同一请求的后续 patch
    enqueueMessageRequestUpdate(42, { statusCode: 200 });

    firstExecute.resolve([]);

    await flushPromise;
    await stopMessageRequestWriteBuffer();

    expect(executeMock).toHaveBeenCalledTimes(2);

    const secondQuery = executeMock.mock.calls[1]?.[0];
    const built = toSqlText(secondQuery);
    expect(built.sql).toContain("status_code");
  });

  it("DB 写入失败重试时不应覆盖更晚的 patch", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const firstExecute = createDeferred<unknown[]>();
    executeMock.mockImplementationOnce(async () => firstExecute.promise);
    executeMock.mockImplementationOnce(async () => []);

    const {
      enqueueMessageRequestUpdate,
      flushMessageRequestWriteBuffer,
      stopMessageRequestWriteBuffer,
    } = await import("@/repository/message-write-buffer");

    enqueueMessageRequestUpdate(7, { durationMs: 100 });

    const flushPromise = flushMessageRequestWriteBuffer();
    expect(executeMock).toHaveBeenCalledTimes(1);

    // 在第一次 flush 的 in-flight 期间写入“更晚”的字段
    enqueueMessageRequestUpdate(7, { statusCode: 500 });

    firstExecute.reject(new Error("db down"));
    await flushPromise;

    // 触发下一次 flush：应同时包含 duration/statusCode
    await flushMessageRequestWriteBuffer();
    await stopMessageRequestWriteBuffer();

    expect(executeMock).toHaveBeenCalledTimes(2);

    const secondQuery = executeMock.mock.calls[1]?.[0];
    const built = toSqlText(secondQuery);
    expect(built.sql).toContain("duration_ms");
    expect(built.sql).toContain("status_code");
  });

  it("JSONB poison 记录失败时拆批并保留同批健康记录与 poison 记录的标量字段", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";
    process.env.MESSAGE_REQUEST_ASYNC_BATCH_SIZE = "10";
    const poisonError = new Error("Failed query: update message_request", {
      cause: new Error("unsupported Unicode escape sequence"),
    });
    executeMock.mockRejectedValueOnce(poisonError);
    executeMock.mockRejectedValueOnce(poisonError);
    executeMock.mockResolvedValue([]);

    const {
      enqueueMessageRequestUpdate,
      flushMessageRequestWriteBuffer,
      stopMessageRequestWriteBuffer,
    } = await import("@/repository/message-write-buffer");

    enqueueMessageRequestUpdate(1, {
      statusCode: 500,
      providerChain: [{ id: 1, name: "poison" }],
    });
    enqueueMessageRequestUpdate(2, { statusCode: 200, durationMs: 12 });

    await flushMessageRequestWriteBuffer();
    await stopMessageRequestWriteBuffer();

    expect(executeMock).toHaveBeenCalledTimes(4);
    const queries = executeMock.mock.calls.map(([query]) => toSqlText(query));
    expect(
      queries.some(
        (query) =>
          query.params.includes(1) &&
          query.sql.includes("status_code") &&
          !query.sql.includes("provider_chain")
      )
    ).toBe(true);
    expect(queries.some((query) => query.params.includes(2))).toBe(true);
  });

  it("队列溢出时应优先保留带 statusCode 的终态 patch", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";
    process.env.MESSAGE_REQUEST_ASYNC_MAX_PENDING = "100";

    const { enqueueMessageRequestUpdate, stopMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );

    enqueueMessageRequestUpdate(1001, { statusCode: 200 }); // Gemini passthrough 等 statusCode-only 终态
    for (let i = 0; i < 100; i++) {
      enqueueMessageRequestUpdate(2000 + i, { durationMs: i });
    }

    await stopMessageRequestWriteBuffer();

    expect(executeMock).toHaveBeenCalledTimes(1);

    const query = executeMock.mock.calls[0]?.[0];
    const built = toSqlText(query);

    expect(built.params).toContain(1001);
    expect(built.sql).toContain("status_code");
    expect(built.params).not.toContain(2000);
    expect(built.params).toContain(2099);
  });

  it("costUsd 走纯替换语义（CASE id ... ::numeric，不累加）", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";

    const { enqueueMessageRequestUpdate, stopMessageRequestWriteBuffer } = await import(
      "@/repository/message-write-buffer"
    );

    enqueueMessageRequestUpdate(11, { costUsd: "0.000123" });
    await stopMessageRequestWriteBuffer();

    const built = toSqlText(executeMock.mock.calls[0]?.[0]);
    // 缓冲只承载非 hedge 的替换型 cost 写入（hedge 赢家/输家都走直接写）。
    expect(built.sql).toContain('"cost_usd" = CASE id');
    expect(built.sql).toContain("::numeric");
    expect(built.sql).not.toContain("COALESCE");
  });
});

describe("mergePatch（替换合并语义）", () => {
  it("非 undefined 的 incoming 字段覆盖 base", async () => {
    process.env.MESSAGE_REQUEST_WRITE_MODE = "async";
    process.env.DSN = "postgres://postgres:postgres@localhost:5432/claude_code_hub_test";
    vi.doMock("@/drizzle/db", () => ({
      db: {
        execute: vi.fn(async () => []),
        select: () => ({ from: () => ({ where: async () => [] }) }),
      },
    }));
    const { mergePatch } = await import("@/repository/message-write-buffer");

    const merged = mergePatch(
      { costUsd: "0.1", statusCode: 200, durationMs: 100 },
      { statusCode: 500 }
    );

    expect(merged.statusCode).toBe(500); // incoming wins
    expect(merged.costUsd).toBe("0.1"); // untouched (incoming undefined)
    expect(merged.durationMs).toBe(100); // untouched
  });
});
