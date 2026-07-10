import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const locales = ["zh-CN", "zh-TW", "en", "ja", "ru"] as const;
const requiredPaths = [
  "observedInput",
  "ordinaryInput",
  "cacheWriteReported",
  "cacheWriteEffective",
  "cacheWriteNotReported",
  "cacheWriteAccounting",
  "cacheWriteAccountingSource.reported_positive",
  "cacheWriteAccountingSource.inferred_input_minus_cache_read_v1",
  "cacheWriteAccountingSource.none",
  "effectiveServiceTier",
  "serviceTier.standard",
  "serviceTier.priority",
  "longContextPricing",
  "longContextApplied",
  "longContextAppliedUnknown",
  "unitPricePer1M",
  "pricingTier",
  "pricingTierValue.standard",
  "pricingTierValue.standard_long_context",
  "pricingTierValue.priority",
  "pricingRateSource",
  "priceBook",
  "settlementStatus",
  "settlementUnsupported",
  "settlementReason.gpt56_standard_rates_incomplete",
  "settlementReason.gpt56_long_context_rates_incomplete",
  "settlementReason.gpt56_priority_rates_incomplete",
  "settlementReason.gpt56_priority_long_context_unsupported",
  "settlementMissingFields",
] as const;

function readBillingDetails(locale: (typeof locales)[number]): Record<string, unknown> {
  const dashboard = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "messages", locale, "dashboard.json"), "utf8")
  ) as {
    logs?: { details?: { billingDetails?: Record<string, unknown> } };
  };
  return dashboard.logs?.details?.billingDetails ?? {};
}

function readPath(root: Record<string, unknown>, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((value, segment) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

describe("GPT-5.6 billing audit translations", () => {
  test.each(locales)("%s contains every request-detail audit label", (locale) => {
    const billingDetails = readBillingDetails(locale);
    for (const requiredPath of requiredPaths) {
      expect(readPath(billingDetails, requiredPath), `${locale}: ${requiredPath}`).toEqual(
        expect.any(String)
      );
    }
  });
});
