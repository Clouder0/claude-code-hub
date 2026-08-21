import { sql } from "drizzle-orm";
import { usageLedger } from "@/drizzle/schema";

/**
 * 只统计可计费请求。
 *
 * 历史实现是 blocked_by IS NULL + endpoint 非计费端点排除的 REGEXP_REPLACE
 * 表达式：不可索引、进不了任何部分索引谓词，所有账单聚合都要逐行求值 +
 * 堆回取。自 0116 起该判定以 usage_ledger.is_billable 存储列形式由写入
 * 触发器维护（表达式逐字等价，历史行已在线回填并三重验证），读侧翻转
 * 为单列引用后，WHERE is_billable 的部分覆盖索引即可服务全部聚合。
 */
export const LEDGER_BILLING_CONDITION = sql`${usageLedger.isBillable}`;

/**
 * 非计费查询中排除被阻断请求的别名条件（语义更清晰）。
 */
export const LEDGER_ACTIVE_CONDITION = LEDGER_BILLING_CONDITION;

/**
 * successRate / availability 相关统计只统计已明确属于上游 success/failure 的请求。
 */
export const LEDGER_SUCCESS_RATE_COUNTABLE_CONDITION = sql`${usageLedger.successRateOutcome} IN ('success', 'failure')`;

/**
 * successRate 分子条件：只统计明确的 success outcome。
 */
export const LEDGER_SUCCESS_RATE_SUCCESS_CONDITION = sql`${usageLedger.successRateOutcome} = 'success'`;
