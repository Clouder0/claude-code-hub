import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/drizzle/db";
import { logger } from "@/lib/logger";

export interface BackfillUsageLedgerSummary {
  totalProcessed: number;
  totalInserted: number;
  durationMs: number;
  alreadyExisted: number;
}

export type LedgerBackfillMode = "sync" | "repair";

/**
 * 启动同步模式的墙钟上限。同步模式只应处理账本水位之后的少量尾部行；
 * 超过该时长通常意味着水位锚定失效（如账本被清空），记录并让出启动路径，
 * 由下一次启动或显式 repair 处理。
 */
const SYNC_MODE_MAX_DURATION_MS = 60_000;

/**
 * 回填 usage_ledger。
 *
 * 两种模式（背景：写路径由 trg_upsert_usage_ledger 触发器维护账本，回填只是兜底）：
 *
 * - "sync"（默认，启动用）：只处理"账本尾部之后"的缺失行。水位锚点是
 *   max(usage_ledger.request_id)（request_id 有索引，瞬时取得），因此正常情况下
 *   每次启动只扫描最后几秒~几分钟的 message_request 尾巴。选择条件是纯
 *   anti-join（ul.request_id IS NULL），不逐行求值派生函数——历史版本的启动
 *   路径为了支持语义修复在 WHERE 里保留了 IS DISTINCT FROM fn_... 条件，
 *   导致每次启动都对 300 万+ 行各跑两个 PL/pgSQL 函数（分钟级全表扫描，
 *   2026-08-20 诊断确认它会打满主库 I/O）。
 * - "repair"（显式调用）：完整的语义重导——按当前派生规则重新计算
 *   final_provider_id / is_success / success_rate_outcome 并更新不一致行。
 *   仅在派生语义变更（如成功率先兆修正）后由维护者手动触发，不挂在启动上。
 *   无时长上限：它本来就预期跑很久。
 */
export async function backfillUsageLedger(
  options: { mode?: LedgerBackfillMode } = {}
): Promise<BackfillUsageLedgerSummary> {
  const mode = options.mode ?? "sync";

  // sync 模式处理的是账本水位之后的尾部行，与 trg_upsert_usage_ledger 的
  // 并发写入天然重叠：INSERT ... SELECT ... ON CONFLICT 撞上未提交的同行
  // 插入时可能直接报错。错误会把 PG 事务置为 aborted，批次内无法重试，
  // 因此整个事务级重试（每次重拿 advisory 锁、重取水位，幂等）。
  const maxAttempts = mode === "sync" ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runBackfillTransaction(mode);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        const cause = (error as { cause?: unknown } | null)?.cause;
        logger.warn("Ledger backfill transaction failed, retrying", {
          mode,
          attempt,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error),
          causeMessage: cause instanceof Error ? cause.message : String(cause),
          causeCode: (cause as { code?: unknown } | null)?.code,
        });
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  throw lastError;
}

async function runBackfillTransaction(mode: LedgerBackfillMode): Promise<BackfillUsageLedgerSummary> {
  const startTime = Date.now();
  const LOCK_KEY = 20260101;

  // Use pg_try_advisory_xact_lock (transaction-scoped) so lock/unlock always happen
  // on the same connection — safe with connection pools.
  return await db.transaction(async (tx) => {
    const lockResult = await tx.execute(sql`
      SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS acquired
    `);

    const acquired = (lockResult as unknown as Array<{ acquired: boolean }>)[0]?.acquired;
    if (!acquired) {
      return {
        totalProcessed: 0,
        totalInserted: 0,
        durationMs: Date.now() - startTime,
        alreadyExisted: 0,
      };
    }

    try {
      let totalProcessed = 0;
      let totalInserted = 0;
      let totalAlreadyExisted = 0;
      let lastId = 0;

      if (mode === "sync") {
        // 水位锚点：账本已覆盖到的最大 message_request id。
        // 低于水位的缺失属于历史漂移，归 repair 模式管。
        const anchorResult = await tx.execute(sql`
          SELECT COALESCE(MAX(request_id), 0)::bigint AS max_request_id FROM usage_ledger
        `);
        lastId = Number(
          (anchorResult as unknown as Array<{ max_request_id: string | number }>)[0]
            ?.max_request_id ?? 0
        );
      }

      while (true) {
        // 行选择条件按模式在 TS 侧组装（而不是参数化布尔）：
        // - sync 只做缺失行 anti-join，查询文本里不出现语义比较条件，
        //   计划器与执行器都不需要为它求值；
        // - repair 保留完整语义重导条件。
        const selectionCondition =
          mode === "repair"
            ? sql`
              ul.request_id IS NULL
              OR ul.success_rate_outcome IS NULL
              OR ul.final_provider_id IS DISTINCT FROM resolved.final_provider_id
              OR ul.is_success IS DISTINCT FROM (
                (mr.error_message IS NULL OR mr.error_message = '')
                AND (mr.status_code IS NULL OR mr.status_code < 400)
              )
            `
            : sql`ul.request_id IS NULL`;

        // repair 必须直接调 fn_compute（mr.success_rate_outcome 列可能存着
        // 旧语义的值，重导的意义就是按当前函数重算）；sync 处理的是刚写入的
        // 尾部行，触发器已用当前函数维护过该列，COALESCE 省一次函数调用。
        const outcomeExpression =
          mode === "repair"
            ? sql`fn_compute_message_request_success_rate_outcome(
                mr.blocked_by,
                mr.status_code,
                mr.error_message,
                mr.provider_chain
              )`
            : sql`COALESCE(
              mr.success_rate_outcome,
              fn_compute_message_request_success_rate_outcome(
                mr.blocked_by,
                mr.status_code,
                mr.error_message,
                mr.provider_chain
              )
            )`;

        const batchResult = await tx.execute(sql`
        WITH batch AS (
          SELECT
            mr.id,
            mr.user_id,
            mr.key,
            mr.provider_id,
            resolved.final_provider_id,
            mr.model,
            mr.original_model,
            mr.actual_response_model,
            mr.endpoint,
            mr.api_type,
            mr.session_id,
            mr.status_code,
            ${outcomeExpression} AS success_rate_outcome,
            (mr.error_message IS NULL OR mr.error_message = '')
              AND (mr.status_code IS NULL OR mr.status_code < 400) AS is_success,
            mr.blocked_by,
            mr.cost_usd,
            mr.cost_multiplier,
            mr.group_cost_multiplier,
            mr.cost_breakdown,
            mr.input_tokens,
            mr.observed_input_tokens,
            mr.output_tokens,
            mr.cache_write_tokens_reported,
            mr.cache_write_accounting,
            mr.cache_creation_input_tokens,
            mr.cache_read_input_tokens,
            mr.cache_creation_5m_input_tokens,
            mr.cache_creation_1h_input_tokens,
            mr.cache_ttl_applied,
            mr.context_1m_applied,
            mr.swap_cache_ttl_applied,
            mr.special_settings,
            mr.hedge_losers,
            mr.duration_ms,
            mr.ttfb_ms,
            mr.client_ip,
            mr.created_at,
            ul.request_id AS existing_request_id
          FROM message_request mr
          CROSS JOIN LATERAL (
            SELECT fn_resolve_message_request_final_provider_id(
              mr.provider_id,
              mr.provider_chain
            ) AS final_provider_id
          ) AS resolved
          LEFT JOIN usage_ledger ul ON ul.request_id = mr.id
          WHERE mr.id > ${lastId}
            AND mr.blocked_by IS DISTINCT FROM 'warmup'
            AND (
              mr.endpoint IS NULL
              OR LOWER(REGEXP_REPLACE(mr.endpoint, '/+$', '')) NOT IN (
                '/v1/messages/count_tokens',
                '/v1/responses/compact'
              )
            )
            AND ${selectionCondition}
          ORDER BY mr.id ASC
          LIMIT 10000
        ),
        inserted_rows AS (
          INSERT INTO usage_ledger (
            request_id, user_id, key, provider_id, final_provider_id,
            model, original_model, actual_response_model, endpoint, api_type, session_id,
            status_code, is_success, success_rate_outcome, blocked_by,
            cost_usd, cost_multiplier, group_cost_multiplier, cost_breakdown,
            input_tokens, observed_input_tokens, output_tokens,
            cache_write_tokens_reported, cache_write_accounting,
            cache_creation_input_tokens, cache_read_input_tokens,
            cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
            cache_ttl_applied, context_1m_applied, swap_cache_ttl_applied,
            special_settings, hedge_losers,
            duration_ms, ttfb_ms, client_ip, created_at
          )
          SELECT
            batch.id,
            batch.user_id,
            batch.key,
            batch.provider_id,
            batch.final_provider_id,
            batch.model,
            batch.original_model,
            batch.actual_response_model,
            batch.endpoint,
            batch.api_type,
            batch.session_id,
            batch.status_code,
            batch.is_success,
            batch.success_rate_outcome,
            batch.blocked_by,
            batch.cost_usd,
            batch.cost_multiplier,
            batch.group_cost_multiplier,
            batch.cost_breakdown,
            batch.input_tokens,
            batch.observed_input_tokens,
            batch.output_tokens,
            batch.cache_write_tokens_reported,
            batch.cache_write_accounting,
            batch.cache_creation_input_tokens,
            batch.cache_read_input_tokens,
            batch.cache_creation_5m_input_tokens,
            batch.cache_creation_1h_input_tokens,
            batch.cache_ttl_applied,
            batch.context_1m_applied,
            batch.swap_cache_ttl_applied,
            batch.special_settings,
            batch.hedge_losers,
            batch.duration_ms,
            batch.ttfb_ms,
            batch.client_ip,
            batch.created_at
          FROM batch
          ON CONFLICT (request_id) DO UPDATE SET
            final_provider_id = EXCLUDED.final_provider_id,
            is_success = EXCLUDED.is_success,
            success_rate_outcome = EXCLUDED.success_rate_outcome
          RETURNING request_id
        )
        SELECT
          COALESCE((SELECT COUNT(*) FROM batch), 0)::integer AS processed,
          COALESCE(
            (
              SELECT COUNT(*)
              FROM inserted_rows ir
              JOIN batch b ON b.id = ir.request_id
              WHERE b.existing_request_id IS NULL
            ),
            0
          )::integer AS inserted,
          COALESCE(
            (
              SELECT COUNT(*)
              FROM inserted_rows ir
              JOIN batch b ON b.id = ir.request_id
              WHERE b.existing_request_id IS NOT NULL
            ),
            0
          )::integer AS updated,
          COALESCE((SELECT MAX(id) FROM batch), 0)::integer AS max_id
      `);

        const batchRow = (
          batchResult as unknown as Array<{
            processed?: number | string;
            inserted?: number | string;
            updated?: number | string;
            max_id?: number | string;
          }>
        )[0];

        const processed = Number(batchRow?.processed ?? 0);
        const inserted = Number(batchRow?.inserted ?? 0);
        const updated = Number(batchRow?.updated ?? 0);
        const maxId = Number(batchRow?.max_id ?? 0);

        if (processed === 0) {
          break;
        }

        totalProcessed += processed;
        totalInserted += inserted;
        totalAlreadyExisted += updated;
        lastId = maxId;

        logger.info("Backfill progress", {
          mode,
          processed: totalProcessed,
          inserted: totalInserted,
          elapsed: Date.now() - startTime,
        });

        if (mode === "sync" && Date.now() - startTime > SYNC_MODE_MAX_DURATION_MS) {
          // 水位锚定失效的保险带：正常 sync 模式几秒内应扫完尾部。
          // 到达上限即让出启动路径；剩余漂移由下次启动或显式 repair 处理。
          logger.warn("Backfill sync mode hit wall-clock cap, deferring remaining work", {
            processed: totalProcessed,
            lastId,
            elapsed: Date.now() - startTime,
          });
          break;
        }
      }

      const durationMs = Date.now() - startTime;
      return {
        totalProcessed,
        totalInserted,
        durationMs,
        alreadyExisted: totalAlreadyExisted,
      };
    } finally {
      // pg_try_advisory_xact_lock is automatically released when the transaction ends
    }
  });
}
