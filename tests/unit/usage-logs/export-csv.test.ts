import { describe, expect, test } from "vitest";
import type { UsageLogRow } from "@/repository/usage-logs";
import { buildCsvHeaderLine, buildCsvRows, escapeCsvField } from "@/lib/usage-logs/export/csv";
import { buildDetailHeaders } from "@/lib/usage-logs/export/columns";

function makeLog(overrides: Partial<UsageLogRow> = {}): UsageLogRow {
  return {
    id: 1,
    createdAt: new Date("2026-06-03T12:34:56.000Z"),
    sessionId: "s1",
    requestSequence: 1,
    userName: "alice",
    keyName: "key-1",
    providerName: "anthropic",
    model: "claude",
    originalModel: "claude-orig",
    actualResponseModel: null,
    endpoint: "/v1/messages",
    statusCode: 200,
    inputTokens: 10,
    observedInputTokens: null,
    outputTokens: 20,
    cacheWriteTokensReported: null,
    cacheWriteAccounting: null,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 5,
    cacheCreation5mInputTokens: 1,
    cacheCreation1hInputTokens: 2,
    cacheTtlApplied: null,
    totalTokens: 38,
    costUsd: "1.500000000000000",
    costMultiplier: null,
    groupCostMultiplier: null,
    costBreakdown: null,
    durationMs: 123,
    ttfbMs: null,
    errorMessage: null,
    providerChain: null,
    blockedBy: null,
    blockedReason: null,
    userAgent: null,
    clientIp: null,
    messagesCount: null,
    context1mApplied: null,
    swapCacheTtlApplied: null,
    specialSettings: null,
    ...overrides,
  };
}

const HEADER = buildDetailHeaders("UTC");
const TIME_IDX = 0;
const STATUS_IDX = HEADER.indexOf("Status Code");
const COST_IDX = HEADER.indexOf("Cost (USD)");
const DURATION_IDX = HEADER.indexOf("Duration (ms)");

describe("buildCsvHeaderLine", () => {
  test("annotates the time column with the timezone", () => {
    expect(buildCsvHeaderLine("Asia/Shanghai").split(",")[TIME_IDX]).toBe("Time (Asia/Shanghai)");
    expect(buildCsvHeaderLine("UTC").split(",")[TIME_IDX]).toBe("Time (UTC)");
  });
});

describe("buildCsvRows", () => {
  test("renders the timestamp in the requested timezone (no UTC Z suffix)", () => {
    const [row] = buildCsvRows([makeLog()], "Asia/Shanghai");
    const cells = row.split(",");
    // 12:34:56 UTC -> 20:34:56 in Asia/Shanghai (+08:00)
    expect(cells[TIME_IDX]).toBe("2026-06-03 20:34:56");
    expect(cells[TIME_IDX]).not.toContain("Z");
  });

  test("normalizes the cost so Excel reads it as a number (trailing zeros gone)", () => {
    const [row] = buildCsvRows([makeLog({ costUsd: "1.500000000000000" })], "UTC");
    expect(row.split(",")[COST_IDX]).toBe("1.5");
  });

  test("caps 16-significant-digit costs to Excel's 15-digit ceiling", () => {
    const [row] = buildCsvRows([makeLog({ costUsd: "1.234567890123456" })], "UTC");
    expect(row.split(",")[COST_IDX]).toBe("1.23456789012346");
  });

  test("blank status code, duration, and unresolved cost stay blank", () => {
    const [row] = buildCsvRows(
      [makeLog({ statusCode: null, durationMs: null, costUsd: null })],
      "UTC"
    );
    const cells = row.split(",");
    expect(cells[STATUS_IDX]).toBe("");
    expect(cells[DURATION_IDX]).toBe("");
    expect(cells[COST_IDX]).toBe("");
  });

  test("null timestamp renders as an empty cell", () => {
    const [row] = buildCsvRows([makeLog({ createdAt: null })], "UTC");
    expect(row.split(",")[TIME_IDX]).toBe("");
  });

  test("invalid Date timestamp renders empty (no RangeError crash)", () => {
    const [row] = buildCsvRows([makeLog({ createdAt: new Date(Number.NaN) })], "UTC");
    expect(row.split(",")[TIME_IDX]).toBe("");
  });

  test("retry count is derived from the provider chain", () => {
    const retryIdx = HEADER.indexOf("Retry Count");
    const [row] = buildCsvRows(
      [
        makeLog({
          providerChain: [
            { reason: "initial_selection" },
            { reason: "retry_failed", attemptNumber: 1 },
            { reason: "retry_success", statusCode: 200, attemptNumber: 1 },
          ] as UsageLogRow["providerChain"],
        }),
      ],
      "UTC"
    );
    expect(row.split(",")[retryIdx]).toBe("1");
  });

  test("exports observed, reported, effective, and accounting cache-write evidence", () => {
    const observedInputIdx = HEADER.indexOf("Observed Input Tokens");
    const reportedWriteIdx = HEADER.indexOf("Cache Write Reported");
    const effectiveWriteIdx = HEADER.indexOf("Cache Write Effective");
    const accountingIdx = HEADER.indexOf("Cache Write Accounting");
    const [row] = buildCsvRows(
      [
        makeLog({
          observedInputTokens: 9016,
          cacheWriteTokensReported: 0,
          cacheCreationInputTokens: 1080,
          cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
        }),
      ],
      "UTC"
    );
    const cells = row.split(",");

    expect(observedInputIdx).toBeGreaterThanOrEqual(0);
    expect(reportedWriteIdx).toBeGreaterThanOrEqual(0);
    expect(effectiveWriteIdx).toBeGreaterThanOrEqual(0);
    expect(accountingIdx).toBeGreaterThanOrEqual(0);
    expect(cells[observedInputIdx]).toBe("9016");
    expect(cells[reportedWriteIdx]).toBe("0");
    expect(cells[effectiveWriteIdx]).toBe("1080");
    expect(cells[accountingIdx]).toBe("inferred_input_minus_cache_read_v1");
  });

  test("keeps historical null audit evidence blank instead of rewriting it as zero", () => {
    const observedInputIdx = HEADER.indexOf("Observed Input Tokens");
    const reportedWriteIdx = HEADER.indexOf("Cache Write Reported");
    const effectiveWriteIdx = HEADER.indexOf("Cache Write Effective");
    const accountingIdx = HEADER.indexOf("Cache Write Accounting");
    const [row] = buildCsvRows(
      [
        makeLog({
          observedInputTokens: null,
          cacheWriteTokensReported: null,
          cacheCreationInputTokens: null,
          cacheWriteAccounting: null,
        }),
      ],
      "UTC"
    );
    const cells = row.split(",");

    expect(cells[observedInputIdx]).toBe("");
    expect(cells[reportedWriteIdx]).toBe("");
    expect(cells[effectiveWriteIdx]).toBe("");
    expect(cells[accountingIdx]).toBe("");
  });

  test("exports effective tier, persisted long-context audit, and derivable unit rates", () => {
    const [row] = buildCsvRows(
      [
        makeLog({
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 1080,
          cacheReadInputTokens: 7936,
          costBreakdown: {
            input: "0.0005",
            output: "0.0003",
            cache_creation: "0.00675",
            cache_creation_default: "0.00675",
            cache_read: "0.001984",
            pricing: {
              tier: "standard_long_context",
              unit_rates: {
                input: "0.00001",
                cache_read: "0.000001",
                cache_write: "0.0000125",
                output: "0.000045",
              },
              rate_source: "model_price_data",
              price_book_source: "cloud_official",
              price_book_model: "gpt-5.6-sol",
              price_book_provider: "openai",
            },
            base_total: "0.009534",
            provider_multiplier: 1,
            group_multiplier: 1,
            total: "0.009534",
          },
          specialSettings: [
            {
              type: "codex_service_tier_result",
              scope: "response",
              hit: true,
              requestedServiceTier: "priority",
              actualServiceTier: "default",
              billingSourcePreference: "actual",
              resolvedFrom: "actual",
              effectivePriority: false,
            },
            {
              type: "long_context_pricing",
              scope: "billing",
              hit: true,
              pricingScope: "request",
              thresholdTokens: 272000,
            },
          ],
        }),
      ],
      "UTC"
    );
    const cells = row.split(",");
    const value = (header: string) => cells[HEADER.indexOf(header)];

    expect(value("Effective Service Tier")).toBe("standard");
    expect(value("Long Context Pricing")).toBe("request");
    expect(value("Long Context Threshold")).toBe("272000");
    expect(value("Input Unit Rate (USD / 1M)")).toBe("10");
    expect(value("Cache Write Unit Rate (USD / 1M)")).toBe("12.5");
    expect(value("Cache Read Unit Rate (USD / 1M)")).toBe("1");
    expect(value("Output Unit Rate (USD / 1M)")).toBe("45");
    expect(value("Pricing Tier")).toBe("standard_long_context");
    expect(value("Pricing Rate Source")).toBe("model_price_data");
    expect(value("Price Book Source")).toBe("cloud_official");
    expect(value("Price Book Model")).toBe("gpt-5.6-sol");
    expect(value("Price Book Provider")).toBe("openai");
  });

  test("leaves unit-rate columns blank when bucket costs lack a pricing snapshot", () => {
    const [row] = buildCsvRows(
      [
        makeLog({
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 1080,
          cacheReadInputTokens: 7936,
          costBreakdown: {
            input: "0.0005",
            output: "0.0003",
            cache_creation: "0.00675",
            cache_creation_default: "0.00675",
            cache_read: "0.001984",
            base_total: "0.009534",
            provider_multiplier: 1,
            group_multiplier: 1,
            total: "0.009534",
          },
        }),
      ],
      "UTC"
    );
    const cells = row.split(",");

    for (const header of [
      "Input Unit Rate (USD / 1M)",
      "Cache Write Unit Rate (USD / 1M)",
      "Cache Read Unit Rate (USD / 1M)",
      "Output Unit Rate (USD / 1M)",
    ]) {
      expect(cells[HEADER.indexOf(header)]).toBe("");
    }
  });

  test("exports unsupported settlement status and reason without inventing a cost", () => {
    const [row] = buildCsvRows(
      [
        makeLog({
          observedInputTokens: 272001,
          costUsd: "0.000000000000000",
          specialSettings: [
            {
              type: "billing_settlement",
              scope: "billing",
              hit: true,
              status: "unsupported",
              reason: "gpt56_priority_rates_incomplete",
              observedInputTokens: 272001,
              missingFields: ["output_cost_per_token_priority"],
              pricingContext: {
                source: "cloud_official",
                model: "gpt-5.6-sol",
                provider: "openai",
                supplement: {
                  id: "openai-gpt56-2026-06-30",
                  source: "https://developers.openai.com/api/docs/pricing",
                  applied_fields: ["input_cost_per_token_priority"],
                  conflicting_fields: ["cache_creation_input_token_cost"],
                },
              },
            },
          ],
        }),
      ],
      "UTC"
    );
    const cells = row.split(",");
    const value = (header: string) => cells[HEADER.indexOf(header)];

    expect(value("Billing Settlement Status")).toBe("unsupported");
    expect(value("Billing Settlement Reason")).toBe("gpt56_priority_rates_incomplete");
    expect(value("Billing Settlement Missing Fields")).toBe("output_cost_per_token_priority");
    expect(value("Billing Settlement Price Book")).toBe(
      "cloud_official/openai/gpt-5.6-sol | supplement=openai-gpt56-2026-06-30 | supplement_source=https://developers.openai.com/api/docs/pricing | applied=input_cost_per_token_priority | conflicts=cache_creation_input_token_cost"
    );
    expect(value("Cost (USD)")).toBe("");
  });

  test("exports unsupported hedge-loser settlement and price-book provenance", () => {
    const [row] = buildCsvRows(
      [
        makeLog({
          hedgeLosers: [
            {
              providerId: 9,
              providerName: "loser-nine",
              attemptNumber: 2,
              costUsd: "0",
              billingStatus: "unsupported",
              billingReason: "gpt56_priority_long_context_unsupported",
              missingPricingFields: [],
              pricingContext: {
                source: "cloud_official",
                model: "gpt-5.6-sol",
                provider: "openai",
                supplement: {
                  id: "openai-gpt56-2026-06-30",
                  source: "https://developers.openai.com/api/docs/pricing",
                  applied_fields: ["input_cost_per_token_priority"],
                  conflicting_fields: ["cache_creation_input_token_cost"],
                },
              },
            },
          ],
        }),
      ],
      "UTC"
    );
    const cells = row.split(",");
    const value = (header: string) => cells[HEADER.indexOf(header)];

    expect(value("Hedge Loser Settlement")).toBe("#2 loser-nine: unsupported");
    expect(value("Hedge Loser Settlement Reason")).toContain(
      "gpt56_priority_long_context_unsupported"
    );
    expect(value("Hedge Loser Price Book")).toContain(
      "#2 loser-nine: cloud_official/openai/gpt-5.6-sol"
    );
    expect(value("Hedge Loser Price Book")).toContain("supplement=openai-gpt56-2026-06-30");
    expect(value("Hedge Loser Price Book")).toContain("conflicts=cache_creation_input_token_cost");
  });
});

describe("escapeCsvField", () => {
  test("neutralizes formula injection regardless of leading whitespace", () => {
    expect(escapeCsvField("=1+1")).toBe("'=1+1");
    // a tab does not trigger CSV quoting, so only the leading-quote guard applies
    expect(escapeCsvField(" \t@SUM(A1:A2)")).toBe("' \t@SUM(A1:A2)");
    expect(escapeCsvField("+2+2")).toBe("'+2+2");
  });

  test("quotes fields containing commas or quotes", () => {
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    expect(escapeCsvField("plain")).toBe("plain");
  });
});
