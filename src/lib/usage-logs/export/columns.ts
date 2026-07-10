/**
 * Single source of truth for the usage-logs export detail columns, shared by
 * the CSV and XLSX renderers so they can never drift apart.
 */

import {
  resolveBillingSettlement,
  resolveEffectiveServiceTier,
  resolveLongContextPricingAudit,
  resolveUnitRatePerMillion,
} from "@/lib/usage-logs/billing-audit";
import { getRetryCount } from "@/lib/utils/provider-chain-formatter";
import type { UsageLogRow } from "@/repository/usage-logs";
import type { StoredPricingContext } from "@/types/cost-breakdown";

export type DetailColumnKind = "text" | "number" | "datetime";

export interface DetailColumn {
  /** Stable English header (datetime columns get the timezone appended). */
  header: string;
  kind: DetailColumnKind;
  /**
   * Raw extracted value: string for text columns, number|null for number
   * columns, Date|null for datetime columns.
   */
  get: (log: UsageLogRow) => string | number | Date | null;
  /** number columns only: emit 0 (instead of blank) when the value is null. */
  zeroWhenNull?: boolean;
  /** ExcelJS number/date format string. */
  numFmt?: string;
}

export const COST_NUM_FMT = "0.00######";
export const INT_NUM_FMT = "0";
export const DATETIME_NUM_FMT = "yyyy-mm-dd hh:mm:ss";

function retryCountOf(log: UsageLogRow): number {
  return log.providerChain ? getRetryCount(log.providerChain) : 0;
}

function formatHedgeLoserAudit(
  log: UsageLogRow,
  value: (loser: NonNullable<UsageLogRow["hedgeLosers"]>[number]) => string
): string {
  return (log.hedgeLosers ?? [])
    .map((loser) => `#${loser.attemptNumber} ${loser.providerName}: ${value(loser)}`)
    .join("; ");
}

function formatPricingContext(context?: StoredPricingContext | null): string {
  if (!context) return "";

  const parts = [`${context.source}/${context.provider}/${context.model}`];
  if (context.supplement) {
    parts.push(`supplement=${context.supplement.id}`);
    parts.push(`supplement_source=${context.supplement.source}`);
    if (context.supplement.applied_fields.length > 0) {
      parts.push(`applied=${context.supplement.applied_fields.join("+")}`);
    }
    if (context.supplement.conflicting_fields.length > 0) {
      parts.push(`conflicts=${context.supplement.conflicting_fields.join("+")}`);
    }
  }
  return parts.join(" | ");
}

export const DETAIL_COLUMNS: DetailColumn[] = [
  { header: "Time", kind: "datetime", numFmt: DATETIME_NUM_FMT, get: (log) => log.createdAt },
  { header: "User", kind: "text", get: (log) => log.userName },
  { header: "Key", kind: "text", get: (log) => log.keyName },
  { header: "Provider", kind: "text", get: (log) => log.providerName ?? "" },
  { header: "Model", kind: "text", get: (log) => log.model ?? "" },
  { header: "Original Model", kind: "text", get: (log) => log.originalModel ?? "" },
  { header: "Endpoint", kind: "text", get: (log) => log.endpoint ?? "" },
  { header: "Status Code", kind: "number", numFmt: INT_NUM_FMT, get: (log) => log.statusCode },
  {
    header: "Input Tokens",
    kind: "number",
    numFmt: INT_NUM_FMT,
    zeroWhenNull: true,
    get: (log) => log.inputTokens,
  },
  {
    header: "Observed Input Tokens",
    kind: "number",
    numFmt: INT_NUM_FMT,
    get: (log) => log.observedInputTokens,
  },
  {
    header: "Output Tokens",
    kind: "number",
    numFmt: INT_NUM_FMT,
    zeroWhenNull: true,
    get: (log) => log.outputTokens,
  },
  {
    header: "Cache Write 5m",
    kind: "number",
    numFmt: INT_NUM_FMT,
    zeroWhenNull: true,
    get: (log) => log.cacheCreation5mInputTokens,
  },
  {
    header: "Cache Write 1h",
    kind: "number",
    numFmt: INT_NUM_FMT,
    zeroWhenNull: true,
    get: (log) => log.cacheCreation1hInputTokens,
  },
  {
    header: "Cache Read",
    kind: "number",
    numFmt: INT_NUM_FMT,
    zeroWhenNull: true,
    get: (log) => log.cacheReadInputTokens,
  },
  {
    header: "Cache Write Reported",
    kind: "number",
    numFmt: INT_NUM_FMT,
    get: (log) => log.cacheWriteTokensReported,
  },
  {
    header: "Cache Write Effective",
    kind: "number",
    numFmt: INT_NUM_FMT,
    get: (log) => log.cacheCreationInputTokens,
  },
  {
    header: "Cache Write Accounting",
    kind: "text",
    get: (log) => log.cacheWriteAccounting ?? "",
  },
  {
    header: "Billing Settlement Status",
    kind: "text",
    get: (log) => resolveBillingSettlement(log.specialSettings)?.status ?? "",
  },
  {
    header: "Billing Settlement Reason",
    kind: "text",
    get: (log) => resolveBillingSettlement(log.specialSettings)?.reason ?? "",
  },
  {
    header: "Billing Settlement Missing Fields",
    kind: "text",
    get: (log) => resolveBillingSettlement(log.specialSettings)?.missingFields.join("; ") ?? "",
  },
  {
    header: "Billing Settlement Price Book",
    kind: "text",
    get: (log) =>
      formatPricingContext(resolveBillingSettlement(log.specialSettings)?.pricingContext),
  },
  {
    header: "Hedge Loser Settlement",
    kind: "text",
    get: (log) => formatHedgeLoserAudit(log, (loser) => loser.billingStatus ?? "settled"),
  },
  {
    header: "Hedge Loser Settlement Reason",
    kind: "text",
    get: (log) =>
      formatHedgeLoserAudit(log, (loser) =>
        [loser.billingReason, ...(loser.missingPricingFields ?? [])].filter(Boolean).join(" | ")
      ),
  },
  {
    header: "Hedge Loser Price Book",
    kind: "text",
    get: (log) =>
      formatHedgeLoserAudit(log, (loser) => {
        const context = loser.pricingContext;
        if (context) return formatPricingContext(context);
        const pricing = loser.costBreakdown?.pricing;
        return pricing
          ? `${pricing.price_book_source}/${pricing.price_book_provider}/${pricing.price_book_model}`
          : "";
      }),
  },
  {
    header: "Effective Service Tier",
    kind: "text",
    get: (log) =>
      resolveEffectiveServiceTier(log.specialSettings, log.costBreakdown?.pricing?.tier) ?? "",
  },
  {
    header: "Pricing Tier",
    kind: "text",
    get: (log) => log.costBreakdown?.pricing?.tier ?? "",
  },
  {
    header: "Long Context Pricing",
    kind: "text",
    get: (log) => {
      const audit = resolveLongContextPricingAudit(
        log.specialSettings,
        log.costBreakdown?.pricing?.tier
      );
      return audit ? (audit.pricingScope ?? "applied") : "";
    },
  },
  {
    header: "Long Context Threshold",
    kind: "number",
    numFmt: INT_NUM_FMT,
    get: (log) =>
      resolveLongContextPricingAudit(log.specialSettings, log.costBreakdown?.pricing?.tier)
        ?.thresholdTokens ?? null,
  },
  {
    header: "Input Unit Rate (USD / 1M)",
    kind: "number",
    numFmt: COST_NUM_FMT,
    get: (log) =>
      resolveUnitRatePerMillion({
        storedRatePerToken: log.costBreakdown?.pricing?.unit_rates.input,
      }),
  },
  {
    header: "Cache Write Unit Rate (USD / 1M)",
    kind: "number",
    numFmt: COST_NUM_FMT,
    get: (log) =>
      resolveUnitRatePerMillion({
        storedRatePerToken: log.costBreakdown?.pricing?.unit_rates.cache_write,
      }),
  },
  {
    header: "Cache Read Unit Rate (USD / 1M)",
    kind: "number",
    numFmt: COST_NUM_FMT,
    get: (log) =>
      resolveUnitRatePerMillion({
        storedRatePerToken: log.costBreakdown?.pricing?.unit_rates.cache_read,
      }),
  },
  {
    header: "Output Unit Rate (USD / 1M)",
    kind: "number",
    numFmt: COST_NUM_FMT,
    get: (log) =>
      resolveUnitRatePerMillion({
        storedRatePerToken: log.costBreakdown?.pricing?.unit_rates.output,
      }),
  },
  {
    header: "Pricing Rate Source",
    kind: "text",
    get: (log) => log.costBreakdown?.pricing?.rate_source ?? "",
  },
  {
    header: "Pricing Rate Source ID",
    kind: "text",
    get: (log) => log.costBreakdown?.pricing?.rate_source_id ?? "",
  },
  {
    header: "Pricing Rate Source URL",
    kind: "text",
    get: (log) => log.costBreakdown?.pricing?.rate_source_url ?? "",
  },
  {
    header: "Price Book Source",
    kind: "text",
    get: (log) => log.costBreakdown?.pricing?.price_book_source ?? "",
  },
  {
    header: "Price Book Model",
    kind: "text",
    get: (log) => log.costBreakdown?.pricing?.price_book_model ?? "",
  },
  {
    header: "Price Book Provider",
    kind: "text",
    get: (log) => log.costBreakdown?.pricing?.price_book_provider ?? "",
  },
  {
    header: "Total Tokens",
    kind: "number",
    numFmt: INT_NUM_FMT,
    zeroWhenNull: true,
    get: (log) => log.totalTokens,
  },
  {
    header: "Cost (USD)",
    kind: "number",
    numFmt: COST_NUM_FMT,
    get: (log) => (resolveBillingSettlement(log.specialSettings) ? null : log.costUsd),
  },
  { header: "Duration (ms)", kind: "number", numFmt: INT_NUM_FMT, get: (log) => log.durationMs },
  { header: "Session ID", kind: "text", get: (log) => log.sessionId ?? "" },
  {
    header: "Retry Count",
    kind: "number",
    numFmt: INT_NUM_FMT,
    zeroWhenNull: true,
    get: retryCountOf,
  },
];

/**
 * Detail-sheet headers, with the timezone appended to datetime columns so the
 * cells stay clean datetimes (e.g. "Time (Asia/Shanghai)").
 */
export function buildDetailHeaders(timezone: string): string[] {
  return DETAIL_COLUMNS.map((column) =>
    column.kind === "datetime" ? `${column.header} (${timezone})` : column.header
  );
}

/** A cell value that should render blank (null, undefined, or whitespace-only). */
export function isBlankValue(value: string | number | Date | null | undefined): boolean {
  return (
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
  );
}
