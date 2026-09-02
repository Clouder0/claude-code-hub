import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { db } from "@/drizzle/db";
import { messageRequest } from "@/drizzle/schema";

if (!process.env.DSN && process.env.DATABASE_URL) {
  process.env.DSN = process.env.DATABASE_URL;
}

const HAS_DB = Boolean(process.env.DSN);
const run = describe.skipIf(!HAS_DB);

/**
 * O2 触发器 WHEN 守卫的行为契约（drizzle/0115 + trigger.sql 镜像）：
 *
 * trg_upsert_usage_ledger 原本对 message_request 的每一条 INSERT/UPDATE 无条件
 * 触发，一次 soft-delete（仅 deleted_at）也会全行重写 usage_ledger（37 列 × 14
 * 索引）。守卫后：INSERT 无条件触发；UPDATE 仅当账本消费列实际变化时触发。
 *
 * 可观测证据：在 usage_ledger 上挂一个计数触发器写入日志表，
 * 通过 message_request 的不同 UPDATE 形状验证触发次数。
 */
run("usage_ledger trigger WHEN guard (0115)", () => {
  const LOG_TABLE = `it_ledger_write_log_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const KEY = `it-trigger-guard-${Date.now()}`;
  const USER_ID = 730_000_000 + (Math.floor(Date.now() / 1000) % 1_000_000);
  let requestId = 0;

  async function ledgerWriteCount(): Promise<number> {
    const result = await db.execute<{ n: number }>(
      sql.raw(`SELECT COUNT(*)::integer AS n FROM ${LOG_TABLE}`)
    );
    return Number(result[0]?.n ?? 0);
  }

  beforeAll(async () => {
    await db.execute(
      sql.raw(`CREATE TABLE ${LOG_TABLE} (id serial PRIMARY KEY, tag text NOT NULL DEFAULT 'x')`)
    );
    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION ${LOG_TABLE}_fn() RETURNS TRIGGER AS $fn$
        BEGIN
          INSERT INTO ${LOG_TABLE} (tag) VALUES (TG_OP);
          RETURN NULL;
        END $fn$ LANGUAGE plpgsql`)
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER ${LOG_TABLE}_trg
        AFTER INSERT OR UPDATE ON usage_ledger
        FOR EACH ROW EXECUTE FUNCTION ${LOG_TABLE}_fn()`)
    );

    const [row] = await db
      .insert(messageRequest)
      .values({
        providerId: 910_000_001,
        userId: USER_ID,
        key: KEY,
        model: "it-guard-model",
        endpoint: "/v1/responses",
        apiType: "response",
      })
      .returning({ id: messageRequest.id });
    requestId = row.id;
  });

  afterAll(async () => {
    try {
      // 顺序关键：先摘掉 usage_ledger 上的计数触发器，再删表/函数。残留的
      // 触发器会让后续所有 ledger 写入（包括 fn_upsert 内部的 INSERT）触发
      // 指向已删表的错误，被 fn 的异常处理器吞掉后表现为 ledger 行丢失。
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${LOG_TABLE}_trg ON usage_ledger`));
      if (requestId) {
        await db.delete(messageRequest).where(sql`${messageRequest.id} = ${requestId}`);
      }
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${LOG_TABLE}`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${LOG_TABLE}_fn()`));
    } catch {
      /* best effort */
    }
  });

  test("INSERT fires the ledger upsert unconditionally", async () => {
    const before = await ledgerWriteCount();
    expect(before).toBeGreaterThanOrEqual(1); // beforeAll 的 INSERT 已产生一次 ledger 写
    const [row] = await db
      .select({
        ledgerId: sql<number>`(SELECT id FROM usage_ledger WHERE request_id = ${requestId})`,
      })
      .from(messageRequest)
      .where(sql`${messageRequest.id} = ${requestId}`);
    expect(Number(row?.ledgerId ?? 0)).toBeGreaterThan(0);
  });

  test("soft-delete (deleted_at only) does NOT rewrite the ledger row", async () => {
    const before = await ledgerWriteCount();
    await db
      .update(messageRequest)
      .set({ deletedAt: new Date() })
      .where(sql`${messageRequest.id} = ${requestId}`);
    const after = await ledgerWriteCount();
    expect(after).toBe(before);
  });

  test("error_stack-only append does NOT rewrite the ledger row", async () => {
    const before = await ledgerWriteCount();
    await db
      .update(messageRequest)
      .set({ errorStack: "TypeError: it-guard\n    at test" })
      .where(sql`${messageRequest.id} = ${requestId}`);
    const after = await ledgerWriteCount();
    expect(after).toBe(before);
  });

  test("status_code transition DOES fire the ledger upsert", async () => {
    const before = await ledgerWriteCount();
    await db
      .update(messageRequest)
      .set({ statusCode: 200, durationMs: 1234 })
      .where(sql`${messageRequest.id} = ${requestId}`);
    const after = await ledgerWriteCount();
    expect(after).toBe(before + 1);
    const [ledger] = await db.execute<{ status_code: number; duration_ms: number }>(
      sql`SELECT status_code, duration_ms FROM usage_ledger WHERE request_id = ${requestId}`
    );
    expect(Number(ledger?.status_code)).toBe(200);
    expect(Number(ledger?.duration_ms)).toBe(1234);
  });

  test("cost settlement transition DOES fire the ledger upsert", async () => {
    const before = await ledgerWriteCount();
    await db
      .update(messageRequest)
      .set({ costUsd: "0.123450000000000", inputTokens: 5000 })
      .where(sql`${messageRequest.id} = ${requestId}`);
    const after = await ledgerWriteCount();
    expect(after).toBe(before + 1);
  });

  test("updated_at-only touch does NOT rewrite the ledger row", async () => {
    const before = await ledgerWriteCount();
    await db
      .update(messageRequest)
      .set({ updatedAt: new Date() })
      .where(sql`${messageRequest.id} = ${requestId}`);
    const after = await ledgerWriteCount();
    expect(after).toBe(before);
  });
});
