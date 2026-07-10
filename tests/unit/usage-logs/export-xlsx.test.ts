import { strFromU8, unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { UsageLogRow } from "@/repository/usage-logs";
import { buildDetailHeaders } from "@/lib/usage-logs/export/columns";
import { SUMMARY_HEADERS } from "@/lib/usage-logs/export/summary";
import { buildUsageLogsXlsx, columnRef } from "@/lib/usage-logs/export/xlsx";

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

function unzip(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    out[name] = strFromU8(content);
  }
  return out;
}

/** Extract the inner XML of a cell by its A1 reference. */
function cell(sheetXml: string, ref: string): string | null {
  const match = sheetXml.match(new RegExp(`<c r="${ref}"[^>]*?(?:/>|>(.*?)</c>)`));
  if (!match) return null;
  return match[0];
}

const HEADER = buildDetailHeaders("UTC");
const columnFor = (header: string) => columnRef(HEADER.indexOf(header));
const COST_COL = columnFor("Cost (USD)");
const TIME_COL = columnRef(0); // A
const MODEL_COL = columnRef(4); // E
const STATUS_COL = columnRef(7); // H

describe("buildUsageLogsXlsx", () => {
  test("produces a valid two-sheet workbook package", async () => {
    const files = unzip(await buildUsageLogsXlsx([makeLog()], "UTC"));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "xl/workbook.xml",
        "xl/_rels/workbook.xml.rels",
        "xl/styles.xml",
        "xl/worksheets/sheet1.xml",
        "xl/worksheets/sheet2.xml",
      ])
    );
    expect(files["xl/workbook.xml"]).toContain('name="Usage Logs"');
  });

  test("cost is a numeric cell (not text) and normalized for Excel", async () => {
    const files = unzip(
      await buildUsageLogsXlsx([makeLog({ costUsd: "1.500000000000000" })], "UTC")
    );
    const costCell = cell(files["xl/worksheets/sheet1.xml"], `${COST_COL}2`) ?? "";
    expect(costCell).toContain("<v>1.5</v>");
    expect(costCell).not.toContain("inlineStr");
  });

  test("16-significant-digit cost is capped to 15 digits", async () => {
    const files = unzip(
      await buildUsageLogsXlsx([makeLog({ costUsd: "1.234567890123456" })], "UTC")
    );
    const costCell = cell(files["xl/worksheets/sheet1.xml"], `${COST_COL}2`) ?? "";
    expect(costCell).toContain("<v>1.23456789012346</v>");
  });

  test("model name is a text (inlineStr) cell, not interpreted as a formula", async () => {
    const files = unzip(await buildUsageLogsXlsx([makeLog({ model: "=1+1" })], "UTC"));
    const modelCell = cell(files["xl/worksheets/sheet1.xml"], `${MODEL_COL}2`) ?? "";
    expect(modelCell).toContain("inlineStr");
    expect(modelCell).toContain("=1+1");
  });

  test("status code is an integer numeric cell", async () => {
    const files = unzip(await buildUsageLogsXlsx([makeLog({ statusCode: 200 })], "UTC"));
    const statusCell = cell(files["xl/worksheets/sheet1.xml"], `${STATUS_COL}2`) ?? "";
    expect(statusCell).toContain("<v>200</v>");
    expect(statusCell).not.toContain("inlineStr");
  });

  test("writes cache accounting audit fields with numeric token cells", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
        [
          makeLog({
            observedInputTokens: 9016,
            cacheWriteTokensReported: 0,
            cacheCreationInputTokens: 1080,
            cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
          }),
        ],
        "UTC"
      )
    );
    const sheet = files["xl/worksheets/sheet1.xml"];

    expect(cell(sheet, `${columnFor("Observed Input Tokens")}2`)).toContain("<v>9016</v>");
    expect(cell(sheet, `${columnFor("Cache Write Reported")}2`)).toContain("<v>0</v>");
    expect(cell(sheet, `${columnFor("Cache Write Effective")}2`)).toContain("<v>1080</v>");
    expect(cell(sheet, `${columnFor("Cache Write Accounting")}2`)).toContain(
      "inferred_input_minus_cache_read_v1"
    );
  });

  test("writes tier, long-context, and unit-rate evidence to the detail sheet", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
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
                tier: "priority",
                unit_rates: {
                  input: "0.00001",
                  cache_read: "0.000001",
                  cache_write: "0.0000125",
                  output: "0.00006",
                },
                rate_source: "openai_official_supplement",
                rate_source_id: "openai-gpt-5.6-2026-07-10",
                rate_source_url: "https://developers.openai.com/api/docs/pricing",
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
                actualServiceTier: "priority",
                billingSourcePreference: "actual",
                resolvedFrom: "actual",
                effectivePriority: true,
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
      )
    );
    const sheet = files["xl/worksheets/sheet1.xml"];

    expect(cell(sheet, `${columnFor("Effective Service Tier")}2`)).toContain("priority");
    expect(cell(sheet, `${columnFor("Long Context Pricing")}2`)).toContain("request");
    expect(cell(sheet, `${columnFor("Long Context Threshold")}2`)).toContain("<v>272000</v>");
    expect(cell(sheet, `${columnFor("Input Unit Rate (USD / 1M)")}2`)).toContain("<v>10</v>");
    expect(cell(sheet, `${columnFor("Cache Write Unit Rate (USD / 1M)")}2`)).toContain(
      "<v>12.5</v>"
    );
    expect(cell(sheet, `${columnFor("Cache Read Unit Rate (USD / 1M)")}2`)).toContain("<v>1</v>");
    expect(cell(sheet, `${columnFor("Output Unit Rate (USD / 1M)")}2`)).toContain("<v>60</v>");
    expect(cell(sheet, `${columnFor("Pricing Tier")}2`)).toContain("priority");
    expect(cell(sheet, `${columnFor("Pricing Rate Source")}2`)).toContain(
      "openai_official_supplement"
    );
    expect(cell(sheet, `${columnFor("Price Book Model")}2`)).toContain("gpt-5.6-sol");
  });

  test("leaves unit-rate cells blank when bucket costs lack a pricing snapshot", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
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
      )
    );
    const sheet = files["xl/worksheets/sheet1.xml"];

    for (const header of [
      "Input Unit Rate (USD / 1M)",
      "Cache Write Unit Rate (USD / 1M)",
      "Cache Read Unit Rate (USD / 1M)",
      "Output Unit Rate (USD / 1M)",
    ]) {
      const unitRateCell = cell(sheet, `${columnFor(header)}2`) ?? "";
      expect(unitRateCell).not.toContain("<v>");
      expect(unitRateCell).not.toContain("inlineStr");
    }
  });

  test("writes unsupported settlement evidence without inventing a numeric cost", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
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
                reason: "gpt56_long_context_rates_incomplete",
                observedInputTokens: 272001,
                missingFields: ["output_cost_per_token_above_272k_tokens"],
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
      )
    );
    const sheet = files["xl/worksheets/sheet1.xml"];

    expect(cell(sheet, `${columnFor("Billing Settlement Status")}2`)).toContain("unsupported");
    expect(cell(sheet, `${columnFor("Billing Settlement Reason")}2`)).toContain(
      "gpt56_long_context_rates_incomplete"
    );
    expect(cell(sheet, `${columnFor("Billing Settlement Missing Fields")}2`)).toContain(
      "output_cost_per_token_above_272k_tokens"
    );
    expect(cell(sheet, `${columnFor("Billing Settlement Price Book")}2`)).toContain(
      "supplement=openai-gpt56-2026-06-30"
    );
    const costCell = cell(sheet, `${COST_COL}2`) ?? "";
    expect(costCell).not.toContain("<v>");
    expect(costCell).not.toContain("inlineStr");
  });

  test("writes unsupported hedge-loser settlement and price-book provenance", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
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
      )
    );
    const sheet = files["xl/worksheets/sheet1.xml"];

    expect(cell(sheet, `${columnFor("Hedge Loser Settlement")}2`)).toContain("unsupported");
    expect(cell(sheet, `${columnFor("Hedge Loser Settlement Reason")}2`)).toContain(
      "gpt56_priority_long_context_unsupported"
    );
    expect(cell(sheet, `${columnFor("Hedge Loser Price Book")}2`)).toContain(
      "cloud_official/openai/gpt-5.6-sol"
    );
    expect(cell(sheet, `${columnFor("Hedge Loser Price Book")}2`)).toContain(
      "conflicts=cache_creation_input_token_cost"
    );
  });

  test("timestamp is a real Excel date serial reflecting the system timezone", async () => {
    const files = unzip(await buildUsageLogsXlsx([makeLog()], "Asia/Shanghai"));
    const sheet1 = files["xl/worksheets/sheet1.xml"];
    // header carries the timezone
    expect(sheet1).toContain("Time (Asia/Shanghai)");

    const timeCell = cell(sheet1, `${TIME_COL}2`) ?? "";
    const serial = Number(timeCell.match(/<v>([^<]+)<\/v>/)?.[1]);
    expect(Number.isFinite(serial)).toBe(true);

    // serial -> wall clock; 12:34:56 UTC is 20:34:56 in Asia/Shanghai (+08:00)
    const ms = Math.round(((serial - 25569) * 86_400_000) / 1000) * 1000;
    const wall = new Date(ms);
    expect(wall.getUTCFullYear()).toBe(2026);
    expect(wall.getUTCMonth()).toBe(5); // June
    expect(wall.getUTCDate()).toBe(3);
    expect(wall.getUTCHours()).toBe(20);
    expect(wall.getUTCMinutes()).toBe(34);
    expect(wall.getUTCSeconds()).toBe(56);
  });

  test("single-day data yields an hourly summary sheet", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
        [
          makeLog({ createdAt: new Date("2026-06-03T12:00:00.000Z"), costUsd: "0.5" }),
          makeLog({ createdAt: new Date("2026-06-03T12:30:00.000Z"), costUsd: "0.5" }),
        ],
        "UTC"
      )
    );
    expect(files["xl/workbook.xml"]).toContain('name="Hourly Summary"');
    const summary = files["xl/worksheets/sheet2.xml"];
    expect(summary).toContain("Period");
    expect(summary).toContain("2026-06-03 12:00");
    expect(summary).toContain("Total");
    // total cost cell at column I (index 8), last data row + total row
  });

  test("multi-day data yields a daily summary sheet", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
        [
          makeLog({ createdAt: new Date("2026-06-03T12:00:00.000Z") }),
          makeLog({ createdAt: new Date("2026-06-04T12:00:00.000Z") }),
        ],
        "UTC"
      )
    );
    expect(files["xl/workbook.xml"]).toContain('name="Daily Summary"');
    const summary = files["xl/worksheets/sheet2.xml"];
    expect(summary).toContain("2026-06-03");
    expect(summary).toContain("2026-06-04");
  });

  test("does not crash on empty input", async () => {
    const files = unzip(await buildUsageLogsXlsx([], "UTC"));
    expect(files["xl/worksheets/sheet1.xml"]).toContain("Time (UTC)");
    expect(files["xl/worksheets/sheet2.xml"]).toContain("Total");
  });

  test("invalid Date timestamp yields an empty cell (no crash)", async () => {
    const files = unzip(
      await buildUsageLogsXlsx([makeLog({ createdAt: new Date(Number.NaN) })], "UTC")
    );
    const timeCell = cell(files["xl/worksheets/sheet1.xml"], `${TIME_COL}2`) ?? "";
    expect(timeCell).toBe(`<c r="${TIME_COL}2"/>`);
  });

  test("strips illegal XML characters from text cells", async () => {
    const files = unzip(await buildUsageLogsXlsx([makeLog({ model: "gpt\uFFFE\uFFFF-x" })], "UTC"));
    const modelCell = cell(files["xl/worksheets/sheet1.xml"], `${MODEL_COL}2`) ?? "";
    expect(modelCell).toContain("gpt-x");
    expect(modelCell).not.toContain("\uFFFE");
    expect(modelCell).not.toContain("\uFFFF");
  });

  test("styles.xml declares the two OOXML-reserved fills", async () => {
    const files = unzip(await buildUsageLogsXlsx([makeLog()], "UTC"));
    expect(files["xl/styles.xml"]).toContain('<fills count="2">');
    expect(files["xl/styles.xml"]).toContain('patternType="gray125"');
  });
});

describe("buildUsageLogsXlsx settlement-aware summary", () => {
  const summaryColumnFor = (header: string) =>
    columnRef((SUMMARY_HEADERS as readonly string[]).indexOf(header));

  test("marks request-level unsupported rows and leaves aggregate cost unsettled", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
        [
          makeLog({ createdAt: new Date("2026-06-03T12:00:00.000Z"), costUsd: "0.5" }),
          makeLog({
            createdAt: new Date("2026-06-03T12:30:00.000Z"),
            costUsd: "0.000000000000000",
            specialSettings: [
              {
                type: "billing_settlement",
                scope: "billing",
                hit: true,
                status: "unsupported",
                reason: "gpt56_priority_long_context_unsupported",
                observedInputTokens: 272001,
                missingFields: [],
              },
            ],
          }),
        ],
        "UTC"
      )
    );
    const summary = files["xl/worksheets/sheet2.xml"];
    const unsettledColumn = summaryColumnFor("Unsettled Requests");
    const costColumn = summaryColumnFor("Cost (USD)");

    expect(summary).toContain("Unsettled Requests");
    expect(cell(summary, `${unsettledColumn}2`)).toContain("<v>1</v>");
    expect(cell(summary, `${unsettledColumn}3`)).toContain("<v>1</v>");
    expect(cell(summary, `${costColumn}2`)).not.toContain("<v>");
    expect(cell(summary, `${costColumn}3`)).not.toContain("<v>");
  });

  test("marks an unsupported hedge loser as an incomplete aggregate cost", async () => {
    const files = unzip(
      await buildUsageLogsXlsx(
        [
          makeLog({
            costUsd: "0.5",
            hedgeLosers: [
              {
                providerId: 9,
                providerName: "unsupported-loser",
                attemptNumber: 2,
                costUsd: "0",
                billingStatus: "unsupported",
                billingReason: "gpt56_priority_long_context_unsupported",
              },
            ],
          }),
        ],
        "UTC"
      )
    );
    const summary = files["xl/worksheets/sheet2.xml"];
    const unsettledColumn = summaryColumnFor("Unsettled Requests");
    const costColumn = summaryColumnFor("Cost (USD)");

    expect(cell(summary, `${unsettledColumn}2`)).toContain("<v>1</v>");
    expect(cell(summary, `${unsettledColumn}3`)).toContain("<v>1</v>");
    expect(cell(summary, `${costColumn}2`)).not.toContain("<v>");
    expect(cell(summary, `${costColumn}3`)).not.toContain("<v>");
  });
});
