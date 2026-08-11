import { describe, expect, test } from "vitest";
import {
  calculateRequestCost,
  calculateRequestCostBreakdown,
  matchLongContextPricing,
  resolvePricingSnapshotForCostBreakdown,
} from "@/lib/utils/cost-calculation";
import type { ModelPriceData } from "@/types/model-price";

const MILLION = 1_000_000;

interface PriceCase {
  model: string;
  standard: readonly [number, number, number, number];
  long: readonly [number, number, number, number];
  priority: readonly [number, number, number, number];
}

const PRICE_CASES: PriceCase[] = [
  {
    model: "gpt-5.6-sol",
    standard: [5, 0.5, 6.25, 30],
    long: [10, 1, 12.5, 45],
    priority: [10, 1, 12.5, 60],
  },
  {
    model: "gpt-5.6-terra",
    standard: [2.5, 0.25, 3.125, 15],
    long: [5, 0.5, 6.25, 22.5],
    priority: [5, 0.5, 6.25, 30],
  },
  {
    model: "gpt-5.6-luna",
    standard: [1, 0.1, 1.25, 6],
    long: [2, 0.2, 2.5, 9],
    priority: [2, 0.2, 2.5, 12],
  },
];

function priceData(priceCase: PriceCase): ModelPriceData {
  const [input, cacheRead, cacheWrite, output] = priceCase.standard;
  const [longInput, longCacheRead, longCacheWrite, longOutput] = priceCase.long;
  const [priorityInput, priorityCacheRead, priorityCacheWrite, priorityOutput] = priceCase.priority;

  return {
    slug: `openai/${priceCase.model}`,
    model_family: "gpt",
    input_cost_per_token: input / MILLION,
    cache_read_input_token_cost: cacheRead / MILLION,
    cache_creation_input_token_cost: cacheWrite / MILLION,
    output_cost_per_token: output / MILLION,
    input_cost_per_token_above_272k_tokens: longInput / MILLION,
    cache_read_input_token_cost_above_272k_tokens: longCacheRead / MILLION,
    cache_creation_input_token_cost_above_272k_tokens: longCacheWrite / MILLION,
    output_cost_per_token_above_272k_tokens: longOutput / MILLION,
    input_cost_per_token_priority: priorityInput / MILLION,
    cache_read_input_token_cost_priority: priorityCacheRead / MILLION,
    cache_creation_input_token_cost_priority: priorityCacheWrite / MILLION,
    output_cost_per_token_priority: priorityOutput / MILLION,
  };
}

function expectedCost(
  rates: readonly [number, number, number, number],
  ordinaryInputTokens: number
): number {
  const [input, cacheRead, cacheWrite, output] = rates;
  return (
    ordinaryInputTokens * (input / MILLION) +
    1000 * (cacheRead / MILLION) +
    1000 * (cacheWrite / MILLION) +
    1000 * (output / MILLION)
  );
}

describe("GPT-5.6 exact request pricing", () => {
  test.each(
    PRICE_CASES
  )("$model uses Standard four-bucket rates at exactly 272000 observed input tokens", (priceCase) => {
    const usage = {
      input_tokens: 270000,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 1000,
      output_tokens: 1000,
    };

    const cost = calculateRequestCost(usage, priceData(priceCase));
    const breakdown = calculateRequestCostBreakdown(usage, priceData(priceCase));

    expect(cost.toNumber()).toBeCloseTo(expectedCost(priceCase.standard, 270000), 12);
    expect(breakdown.input).toBeCloseTo(270000 * (priceCase.standard[0] / MILLION), 12);
    expect(breakdown.cache_read).toBeCloseTo(1000 * (priceCase.standard[1] / MILLION), 12);
    expect(breakdown.cache_creation_default).toBeCloseTo(
      1000 * (priceCase.standard[2] / MILLION),
      12
    );
    expect(breakdown.output).toBeCloseTo(1000 * (priceCase.standard[3] / MILLION), 12);
  });

  test.each(PRICE_CASES)("$model keeps Standard rates at 272001", (priceCase) => {
    const usage = {
      input_tokens: 270001,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 1000,
      output_tokens: 1000,
    };

    const cost = calculateRequestCost(usage, priceData(priceCase));
    const breakdown = calculateRequestCostBreakdown(usage, priceData(priceCase));

    expect(cost.toNumber()).toBeCloseTo(expectedCost(priceCase.standard, 270001), 12);
    expect(breakdown.input).toBeCloseTo(270001 * (priceCase.standard[0] / MILLION), 12);
    expect(breakdown.cache_read).toBeCloseTo(1000 * (priceCase.standard[1] / MILLION), 12);
    expect(breakdown.cache_creation_default).toBeCloseTo(
      1000 * (priceCase.standard[2] / MILLION),
      12
    );
    expect(breakdown.output).toBeCloseTo(1000 * (priceCase.standard[3] / MILLION), 12);
  });

  test.each(PRICE_CASES)("$model uses complete Priority rates below the limit", (priceCase) => {
    const usage = {
      input_tokens: 270000,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 1000,
      output_tokens: 1000,
    };

    const cost = calculateRequestCost(usage, priceData(priceCase), {
      priorityServiceTierApplied: true,
    });
    const breakdown = calculateRequestCostBreakdown(usage, priceData(priceCase), {
      priorityServiceTierApplied: true,
    });

    expect(cost.toNumber()).toBeCloseTo(expectedCost(priceCase.priority, 270000), 12);
    expect(breakdown.input).toBeCloseTo(270000 * (priceCase.priority[0] / MILLION), 12);
    expect(breakdown.cache_read).toBeCloseTo(1000 * (priceCase.priority[1] / MILLION), 12);
    expect(breakdown.cache_creation_default).toBeCloseTo(
      1000 * (priceCase.priority[2] / MILLION),
      12
    );
    expect(breakdown.output).toBeCloseTo(1000 * (priceCase.priority[3] / MILLION), 12);
  });

  test.each(PRICE_CASES)("$model keeps Priority rates at 272001", (priceCase) => {
    const usage = {
      input_tokens: 270001,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 1000,
      output_tokens: 1000,
    };

    const cost = calculateRequestCost(usage, priceData(priceCase), {
      priorityServiceTierApplied: true,
    });

    expect(cost.toNumber()).toBeCloseTo(expectedCost(priceCase.priority, 270001), 12);
  });

  test("rejects Standard pricing when any short-context bucket rate is missing", () => {
    const incomplete = priceData(PRICE_CASES[0]);
    incomplete.cache_creation_input_token_cost = undefined;

    expect(() =>
      calculateRequestCost(
        {
          input_tokens: 1000,
          cache_creation_input_tokens: 100,
        },
        incomplete
      )
    ).toThrowError(expect.objectContaining({ reason: "gpt56_standard_rates_incomplete" }));
  });

  test("ignores missing long-context pricing above 272000", () => {
    const incomplete = priceData(PRICE_CASES[0]);
    incomplete.output_cost_per_token_above_272k_tokens = undefined;

    const breakdown = calculateRequestCostBreakdown(
      {
        input_tokens: 272001,
        output_tokens: 100,
      },
      incomplete
    );

    expect(breakdown.input).toBeCloseTo(272001 * (PRICE_CASES[0].standard[0] / MILLION), 12);
    expect(breakdown.output).toBeCloseTo(100 * (PRICE_CASES[0].standard[3] / MILLION), 12);
  });

  test.each([
    {
      name: "Standard short-context",
      usage: {
        input_tokens: 1_000,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 100,
        output_tokens: 100,
      },
      priorityServiceTierApplied: false,
      expectedTier: "standard" as const,
      expectedRates: PRICE_CASES[0].standard,
    },
    {
      name: "Standard above 272K",
      usage: {
        input_tokens: 272_001,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 100,
        output_tokens: 100,
      },
      priorityServiceTierApplied: false,
      expectedTier: "standard" as const,
      expectedRates: PRICE_CASES[0].standard,
    },
    {
      name: "Priority short-context",
      usage: {
        input_tokens: 1_000,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 100,
        output_tokens: 100,
      },
      priorityServiceTierApplied: true,
      expectedTier: "priority" as const,
      expectedRates: PRICE_CASES[0].priority,
    },
  ])("$name ignores a conflicting generic long-context override so charge and snapshot agree", ({
    usage,
    priorityServiceTierApplied,
    expectedTier,
    expectedRates,
  }) => {
    const prices = priceData(PRICE_CASES[0]);
    const conflictingLongContextPricing = {
      thresholdTokens: 1,
      scope: "request" as const,
      inputCostPerToken: 1,
      cacheReadInputTokenCost: 2,
      cacheCreationInputTokenCost: 3,
      cacheCreationInputTokenCostAbove1hr: 4,
      outputCostPerToken: 5,
    };
    const options = {
      priorityServiceTierApplied,
      longContextPricing: conflictingLongContextPricing,
    };

    const cost = calculateRequestCost(usage, prices, options);
    const breakdown = calculateRequestCostBreakdown(usage, prices, options);
    const snapshot = resolvePricingSnapshotForCostBreakdown(usage, prices, options);
    const [input, cacheRead, cacheWrite, output] = expectedRates;
    const expected =
      usage.input_tokens * (input / MILLION) +
      usage.cache_read_input_tokens * (cacheRead / MILLION) +
      usage.cache_creation_input_tokens * (cacheWrite / MILLION) +
      usage.output_tokens * (output / MILLION);

    expect(snapshot).toMatchObject({
      tier: expectedTier,
      unitRates: {
        input: input / MILLION,
        cacheRead: cacheRead / MILLION,
        cacheWrite: cacheWrite / MILLION,
        output: output / MILLION,
      },
    });
    expect(cost.toNumber()).toBeCloseTo(expected, 12);
    expect(breakdown.total).toBeCloseTo(expected, 12);
  });

  test("does not expose a conflicting generic long-context audit for GPT-5.6", () => {
    const prices = priceData(PRICE_CASES[0]);
    prices.long_context_pricing = {
      threshold_tokens: 1,
      scope: "request",
      input_cost_per_token: 1,
      output_cost_per_token: 1,
    };

    expect(matchLongContextPricing({ input_tokens: 2_000 }, prices)).toBeNull();
  });
});
