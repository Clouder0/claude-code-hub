import { describe, expect, test } from "vitest";
import { resolveRequestBillingRates } from "@/lib/utils/billing-rate-resolution";
import type { ModelPriceData } from "@/types/model-price";

function gpt56SolPriceData(overrides: Partial<ModelPriceData> = {}): ModelPriceData {
  return {
    slug: "openai/gpt-5.6-sol",
    model_family: "gpt",
    input_cost_per_token: 5 / 1_000_000,
    cache_read_input_token_cost: 0.5 / 1_000_000,
    cache_creation_input_token_cost: 6.25 / 1_000_000,
    output_cost_per_token: 30 / 1_000_000,
    input_cost_per_token_above_272k_tokens: 10 / 1_000_000,
    cache_read_input_token_cost_above_272k_tokens: 1 / 1_000_000,
    cache_creation_input_token_cost_above_272k_tokens: 12.5 / 1_000_000,
    output_cost_per_token_above_272k_tokens: 45 / 1_000_000,
    input_cost_per_token_priority: 10 / 1_000_000,
    cache_read_input_token_cost_priority: 1 / 1_000_000,
    cache_creation_input_token_cost_priority: 12.5 / 1_000_000,
    output_cost_per_token_priority: 60 / 1_000_000,
    ...overrides,
  };
}

describe("resolveRequestBillingRates", () => {
  test.each([
    "gpt-5.6-sol-2026-07-10",
    "openai/gpt-5.6-terra@latest",
    "gpt-5.6-luna:latest",
  ])("recognizes supported GPT-5.6 snapshot or qualified alias %s", (modelName) => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 1_000 },
      priceData: gpt56SolPriceData({ slug: undefined }),
      priorityServiceTierApplied: false,
      modelName,
    });

    expect(resolution).toMatchObject({ status: "resolved", pricingTier: "standard" });
  });

  test.each([
    "gpt-5.6-pro",
    "gpt-5.6-solar",
    "gpt-5.6-experimental",
  ])("does not apply the GPT-5.6 four-rate contract to unknown suffix %s", (modelName) => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 1_000 },
      priceData: gpt56SolPriceData({ slug: `openai/${modelName}` }),
      priorityServiceTierApplied: false,
      modelName,
    });

    expect(resolution).toBeNull();
  });

  test("resolves GPT-5.6 Standard rates at 272000 tokens", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 272000 },
      priceData: gpt56SolPriceData(),
      priorityServiceTierApplied: false,
    });

    expect(resolution).toEqual({
      status: "resolved",
      pricingTier: "standard",
      observedInputTokens: 272000,
      rateSource: "model_price_data",
      rates: {
        input: 5 / 1_000_000,
        cacheRead: 0.5 / 1_000_000,
        cacheWrite: 6.25 / 1_000_000,
        output: 30 / 1_000_000,
      },
    });
  });

  test("keeps GPT-5.6 Standard rates above 272000 tokens", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 272001 },
      priceData: gpt56SolPriceData(),
      priorityServiceTierApplied: false,
    });

    expect(resolution).toEqual({
      status: "resolved",
      pricingTier: "standard",
      observedInputTokens: 272001,
      rateSource: "model_price_data",
      rates: {
        input: 5 / 1_000_000,
        cacheRead: 0.5 / 1_000_000,
        cacheWrite: 6.25 / 1_000_000,
        output: 30 / 1_000_000,
      },
    });
  });

  test("rejects an incomplete GPT-5.6 Standard four-bucket rate set", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 1000 },
      priceData: gpt56SolPriceData({ cache_creation_input_token_cost: undefined }),
      priorityServiceTierApplied: false,
    });

    expect(resolution).toEqual({
      status: "unsupported",
      reason: "gpt56_standard_rates_incomplete",
      observedInputTokens: 1000,
      missingFields: ["cache_creation_input_token_cost"],
    });
  });

  test("rejects a zero GPT-5.6 Standard rate instead of treating it as a free bucket", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 1_000 },
      priceData: gpt56SolPriceData({ cache_creation_input_token_cost: 0 }),
      priorityServiceTierApplied: false,
      modelName: "gpt-5.6-sol",
    });

    expect(resolution).toEqual({
      status: "unsupported",
      reason: "gpt56_standard_rates_incomplete",
      observedInputTokens: 1_000,
      missingFields: ["cache_creation_input_token_cost"],
    });
  });

  test("does not require GPT-5.6 long-context rates above 272000 tokens", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 272001 },
      priceData: gpt56SolPriceData({ output_cost_per_token_above_272k_tokens: undefined }),
      priorityServiceTierApplied: false,
    });

    expect(resolution).toMatchObject({
      status: "resolved",
      pricingTier: "standard",
      observedInputTokens: 272001,
      rates: {
        input: 5 / 1_000_000,
        cacheRead: 0.5 / 1_000_000,
        cacheWrite: 6.25 / 1_000_000,
        output: 30 / 1_000_000,
      },
    });
  });

  test("resolves all four GPT-5.6 Priority rates atomically at 272000 tokens", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 272000 },
      priceData: gpt56SolPriceData(),
      priorityServiceTierApplied: true,
    });

    expect(resolution).toEqual({
      status: "resolved",
      pricingTier: "priority",
      observedInputTokens: 272000,
      rateSource: "model_price_data",
      rates: {
        input: 10 / 1_000_000,
        cacheRead: 1 / 1_000_000,
        cacheWrite: 12.5 / 1_000_000,
        output: 60 / 1_000_000,
      },
    });
  });

  test("keeps GPT-5.6 Priority rates above 272000 tokens", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 272001 },
      priceData: gpt56SolPriceData(),
      priorityServiceTierApplied: true,
    });

    expect(resolution).toMatchObject({
      status: "resolved",
      pricingTier: "priority",
      observedInputTokens: 272001,
      rates: {
        input: 10 / 1_000_000,
        cacheRead: 1 / 1_000_000,
        cacheWrite: 12.5 / 1_000_000,
        output: 60 / 1_000_000,
      },
    });
  });

  test("marks a partially supplemented Priority rate set as mixed provenance", () => {
    const resolution = resolveRequestBillingRates({
      usage: { input_tokens: 1000 },
      priceData: gpt56SolPriceData({
        openai_official_pricing_supplement: {
          id: "openai-gpt-5.6-2026-07-10",
          source: "https://developers.openai.com/api/docs/pricing",
          applied_fields: ["cache_creation_input_token_cost_priority"],
          conflicting_fields: [],
        },
      }),
      priorityServiceTierApplied: true,
    });

    expect(resolution).toMatchObject({
      status: "resolved",
      rateSource: "mixed_model_price_data_and_supplement",
      rateSourceId: "openai-gpt-5.6-2026-07-10",
      rateSourceUrl: "https://developers.openai.com/api/docs/pricing",
    });
  });
});
