import { describe, expect, test } from "vitest";
import {
  calculateRequestCost,
  calculateRequestCostBreakdown,
  UnsupportedPricingCombinationError,
} from "@/lib/utils/cost-calculation";
import type { ModelPriceData } from "@/types/model-price";

function makePriceData(overrides: Partial<ModelPriceData> = {}): ModelPriceData {
  return {
    mode: "responses",
    input_cost_per_token: 1,
    output_cost_per_token: 10,
    cache_read_input_token_cost: 0.1,
    input_cost_per_token_priority: 2,
    output_cost_per_token_priority: 20,
    cache_read_input_token_cost_priority: 0.2,
    ...overrides,
  };
}

describe("calculateRequestCost priority service tier", () => {
  test("uses the Priority cache-write rate for generic cache writes", () => {
    const cost = calculateRequestCost(
      { cache_creation_input_tokens: 4 },
      makePriceData({
        cache_creation_input_token_cost: 1.25,
        cache_creation_input_token_cost_priority: 3,
      }),
      1,
      false,
      true
    );

    expect(Number(cost.toString())).toBe(12);
  });

  test("rejects an incomplete GPT-5.6 Priority rate set instead of mixing Standard rates", () => {
    expect(() =>
      calculateRequestCost(
        {
          input_tokens: 2,
          output_tokens: 3,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 5,
        },
        makePriceData({
          slug: "openai/gpt-5.6-sol",
          cache_creation_input_token_cost: 1.25,
          cache_creation_input_token_cost_priority: undefined,
        }),
        1,
        false,
        true
      )
    ).toThrowError(UnsupportedPricingCombinationError);
  });

  test("rejects GPT-5.6 Priority long context instead of inventing a combined price", () => {
    expect(() =>
      calculateRequestCost(
        { input_tokens: 272001 },
        makePriceData({
          slug: "openai/gpt-5.6-sol",
          cache_creation_input_token_cost_priority: 2.5,
          input_cost_per_token_above_272k_tokens: 5,
          output_cost_per_token_above_272k_tokens: 50,
          cache_creation_input_token_cost_above_272k_tokens: 6.25,
          cache_read_input_token_cost_above_272k_tokens: 0.5,
        }),
        1,
        false,
        true
      )
    ).toThrowError(expect.objectContaining({ reason: "gpt56_priority_long_context_unsupported" }));
  });

  test("uses the resolved model name to reject Priority long context when price data has no slug", () => {
    expect(() =>
      calculateRequestCost(
        { input_tokens: 272001 },
        makePriceData({
          slug: undefined,
          cache_creation_input_token_cost_priority: 2.5,
          input_cost_per_token_above_272k_tokens: 5,
          output_cost_per_token_above_272k_tokens: 50,
          cache_creation_input_token_cost_above_272k_tokens: 6.25,
          cache_read_input_token_cost_above_272k_tokens: 0.5,
        }),
        {
          priorityServiceTierApplied: true,
          modelName: "gpt-5.6-sol",
        }
      )
    ).toThrowError(expect.objectContaining({ reason: "gpt56_priority_long_context_unsupported" }));
  });

  test("uses the resolved model name to reject incomplete Priority rates when price data has no slug", () => {
    expect(() =>
      calculateRequestCost(
        { input_tokens: 1000, cache_creation_input_tokens: 100 },
        makePriceData({
          slug: undefined,
          cache_creation_input_token_cost_priority: undefined,
        }),
        {
          priorityServiceTierApplied: true,
          modelName: "gpt-5.6-sol",
        }
      )
    ).toThrowError(expect.objectContaining({ reason: "gpt56_priority_rates_incomplete" }));
  });

  test("propagates the resolved model name through breakdown pricing validation", () => {
    expect(() =>
      calculateRequestCostBreakdown(
        { input_tokens: 272001 },
        makePriceData({
          slug: undefined,
          cache_creation_input_token_cost_priority: 2.5,
        }),
        {
          priorityServiceTierApplied: true,
          modelName: "gpt-5.6-sol",
        }
      )
    ).toThrowError(expect.objectContaining({ reason: "gpt56_priority_long_context_unsupported" }));
  });

  test("uses priority pricing fields when priority service tier is applied", () => {
    const cost = calculateRequestCost(
      { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 },
      makePriceData(),
      1,
      false,
      true
    );

    expect(Number(cost.toString())).toBe(65);
  });

  test("falls back to regular pricing when priority fields are absent", () => {
    const cost = calculateRequestCost(
      { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 },
      makePriceData({
        input_cost_per_token_priority: undefined,
        output_cost_per_token_priority: undefined,
        cache_read_input_token_cost_priority: undefined,
      }),
      1,
      false,
      true
    );

    expect(Number(cost.toString())).toBe(32.5);
  });

  test.each([
    undefined,
    null,
  ])("keeps generic Priority fallback semantics when modelName is %s", (modelName) => {
    const priceData = makePriceData({
      input_cost_per_token_priority: undefined,
      output_cost_per_token_priority: undefined,
      cache_read_input_token_cost_priority: undefined,
    });

    const cost = calculateRequestCost(
      { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 },
      priceData,
      { priorityServiceTierApplied: true, modelName }
    );
    const breakdown = calculateRequestCostBreakdown(
      { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5 },
      priceData,
      { priorityServiceTierApplied: true, modelName }
    );

    expect(cost.toNumber()).toBe(32.5);
    expect(breakdown.total).toBe(32.5);
  });

  test("uses priority long-context pricing fields when available", () => {
    const cost = calculateRequestCost(
      {
        input_tokens: 272001,
        output_tokens: 2,
        cache_read_input_tokens: 10,
      },
      makePriceData({
        mode: "responses",
        model_family: "gpt",
        input_cost_per_token_above_272k_tokens: 5,
        output_cost_per_token_above_272k_tokens: 50,
        cache_read_input_token_cost_above_272k_tokens: 0.5,
        input_cost_per_token_above_272k_tokens_priority: 7,
        output_cost_per_token_above_272k_tokens_priority: 70,
        cache_read_input_token_cost_above_272k_tokens_priority: 0.7,
      }),
      1,
      false,
      true
    );

    expect(Number(cost.toString())).toBe(1904154);
  });

  test("falls back to regular long-context pricing when priority long-context fields are absent", () => {
    const cost = calculateRequestCost(
      {
        input_tokens: 272001,
        output_tokens: 2,
        cache_read_input_tokens: 10,
      },
      makePriceData({
        mode: "responses",
        model_family: "gpt",
        input_cost_per_token_above_272k_tokens: 5,
        output_cost_per_token_above_272k_tokens: 50,
        cache_read_input_token_cost_above_272k_tokens: 0.5,
        input_cost_per_token_above_272k_tokens_priority: undefined,
        output_cost_per_token_above_272k_tokens_priority: undefined,
        cache_read_input_token_cost_above_272k_tokens_priority: undefined,
      }),
      1,
      false,
      true
    );

    expect(Number(cost.toString())).toBe(1360110);
  });

  test("uses priority long-context fields by schema, not by model name", () => {
    const cost = calculateRequestCost(
      {
        input_tokens: 272001,
        output_tokens: 2,
      },
      makePriceData({
        mode: "responses",
        model_family: undefined,
        input_cost_per_token_above_272k_tokens: undefined,
        output_cost_per_token_above_272k_tokens: undefined,
        input_cost_per_token_above_272k_tokens_priority: 7,
        output_cost_per_token_above_272k_tokens_priority: 70,
      }),
      1,
      false,
      true
    );

    expect(Number(cost.toString())).toBe(1904147);
  });
});
