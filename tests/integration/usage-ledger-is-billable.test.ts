import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { db } from "@/drizzle/db";
import { messageRequest, usageLedger } from "@/drizzle/schema";
import { backfillUsageLedger } from "@/lib/ledger-backfill";

if (!process.env.DSN && process.env.DATABASE_URL) {
  process.env.DSN = process.env.DATABASE_URL;
}

const HAS_DB = Boolean(process.env.DSN);
const run = describe.skipIf(!HAS_DB);

const KEY_PREFIX = `it-is-billable-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ID_SEED = Math.floor(Date.now() / 1000) % 1_000_000;

let idCursor = 0;
let keyCursor = 0;

function nextUserId() {
  idCursor += 1;
  return 710_000_000 + ID_SEED * 10 + idCursor;
}

function nextProviderId() {
  idCursor += 1;
  return 810_000_000 + ID_SEED * 10 + idCursor;
}

function nextKey(tag: string) {
  keyCursor += 1;
  return `${KEY_PREFIX}-${tag}-${keyCursor}`;
}

type InsertRequestInput = {
  key: string;
  userId: number;
  providerId: number;
  endpoint?: string | null;
  statusCode?: number | null;
  blockedBy?: string | null;
  costUsd?: string | null;
  createdAt?: Date;
};

async function insertMessageRequestRow(input: InsertRequestInput) {
  const [row] = await db
    .insert(messageRequest)
    .values({
      key: input.key,
      userId: input.userId,
      providerId: input.providerId,
      endpoint: input.endpoint,
      statusCode: input.statusCode,
      blockedBy: input.blockedBy,
      costUsd: input.costUsd,
      createdAt: input.createdAt,
    })
    .returning({ id: messageRequest.id });

  if (!row) {
    throw new Error("failed to insert message_request test row");
  }

  return row.id;
}

async function ledgerBillableByRequestId(requestId: number) {
  const result = await db.execute(sql`
    SELECT is_billable, blocked_by, endpoint
    FROM usage_ledger
    WHERE request_id = ${requestId}
  `);
  const row = (
    Array.from(result) as Array<{
      is_billable: boolean | null;
      blocked_by: string | null;
      endpoint: string | null;
    }>
  )[0];
  return row ?? null;
}

async function legacyBillableByRequestId(requestId: number) {
  // Byte-equivalent re-statement of the legacy read-side condition, used to
  // cross-check the stored flag on real rows.
  const result = await db.execute(sql`
    SELECT (
      blocked_by IS NULL
      AND (
        endpoint IS NULL
        OR LOWER(REGEXP_REPLACE(endpoint, '/+$', '')) NOT IN (
          '/v1/messages/count_tokens',
          '/v1/responses/compact'
        )
      )
    ) AS legacy_billable
    FROM usage_ledger
    WHERE request_id = ${requestId}
  `);
  const row = (Array.from(result) as Array<{ legacy_billable: boolean }>)[0];
  return row?.legacy_billable ?? null;
}

async function cleanupTestRows() {
  await db.execute(sql`
    DELETE FROM usage_ledger
    WHERE request_id IN (
      SELECT id FROM message_request WHERE key LIKE ${`${KEY_PREFIX}%`}
    )
  `);
  await db.delete(messageRequest).where(sql`${messageRequest.key} LIKE ${`${KEY_PREFIX}%`}`);
}

run("usage ledger is_billable column", () => {
  beforeAll(async () => {
    await cleanupTestRows();
  });

  afterAll(async () => {
    await cleanupTestRows();
  });

  test("normal finalized request stores is_billable = true, matching the legacy condition", async () => {
    const requestId = await insertMessageRequestRow({
      key: nextKey("normal"),
      userId: nextUserId(),
      providerId: nextProviderId(),
      endpoint: "/v1/responses",
      statusCode: 200,
      costUsd: "0.010000000000000",
    });

    const row = await ledgerBillableByRequestId(requestId);
    expect(row).not.toBeNull();
    expect(row?.is_billable).toBe(true);
    expect(await legacyBillableByRequestId(requestId)).toBe(true);
  });

  test("NULL endpoint is billable (endpoint clause vacuous)", async () => {
    const requestId = await insertMessageRequestRow({
      key: nextKey("null-endpoint"),
      userId: nextUserId(),
      providerId: nextProviderId(),
      endpoint: null,
      statusCode: 200,
      costUsd: "0.010000000000000",
    });

    const row = await ledgerBillableByRequestId(requestId);
    expect(row?.is_billable).toBe(true);
    expect(await legacyBillableByRequestId(requestId)).toBe(true);
  });

  test("blocked request keeps its ledger row with is_billable = false", async () => {
    const requestId = await insertMessageRequestRow({
      key: nextKey("blocked"),
      userId: nextUserId(),
      providerId: nextProviderId(),
      endpoint: "/v1/messages",
      blockedBy: "sensitive_word",
      costUsd: null,
    });

    const row = await ledgerBillableByRequestId(requestId);
    // Blocked rows DO enter the ledger (audit) but are never billable.
    expect(row).not.toBeNull();
    expect(row?.blocked_by).toBe("sensitive_word");
    expect(row?.is_billable).toBe(false);
    expect(await legacyBillableByRequestId(requestId)).toBe(false);
  });

  test("non-billing endpoints never reach the ledger — including trailing slashes", async () => {
    for (const endpoint of [
      "/v1/messages/count_tokens",
      "/v1/responses/compact",
      "/v1/messages/count_tokens/",
      "/v1/responses/compact//",
    ]) {
      const requestId = await insertMessageRequestRow({
        key: nextKey("non-billing"),
        userId: nextUserId(),
        providerId: nextProviderId(),
        endpoint,
        statusCode: 200,
      });
      const row = await ledgerBillableByRequestId(requestId);
      expect(row).toBeNull();
    }
  });

  test("warmup transition clears is_billable on an existing row", async () => {
    const requestId = await insertMessageRequestRow({
      key: nextKey("warmup-flip"),
      userId: nextUserId(),
      providerId: nextProviderId(),
      endpoint: "/v1/responses",
      statusCode: 200,
      costUsd: "0.020000000000000",
    });
    expect((await ledgerBillableByRequestId(requestId))?.is_billable).toBe(true);

    await db
      .update(messageRequest)
      .set({ blockedBy: "warmup" })
      .where(eq(messageRequest.id, requestId));

    const row = await ledgerBillableByRequestId(requestId);
    expect(row?.blocked_by).toBe("warmup");
    expect(row?.is_billable).toBe(false);
    expect(await legacyBillableByRequestId(requestId)).toBe(false);
  });

  test("ledger-backfill service writes is_billable for rebuilt rows", async () => {
    const billableId = await insertMessageRequestRow({
      key: nextKey("backfill-billable"),
      userId: nextUserId(),
      providerId: nextProviderId(),
      endpoint: "/v1/responses",
      statusCode: 200,
      costUsd: "0.030000000000000",
    });
    const blockedId = await insertMessageRequestRow({
      key: nextKey("backfill-blocked"),
      userId: nextUserId(),
      providerId: nextProviderId(),
      endpoint: "/v1/messages",
      blockedBy: "sensitive_word",
    });

    // Simulate missing ledger rows, then rebuild via the backfill service
    // (repair mode covers rows the ledger is missing).
    await db.delete(usageLedger).where(eq(usageLedger.requestId, billableId));
    await db.delete(usageLedger).where(eq(usageLedger.requestId, blockedId));
    await backfillUsageLedger({ mode: "repair" });

    expect((await ledgerBillableByRequestId(billableId))?.is_billable).toBe(true);
    expect((await ledgerBillableByRequestId(blockedId))?.is_billable).toBe(false);
  });
});
