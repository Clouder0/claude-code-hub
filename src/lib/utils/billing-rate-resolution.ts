import { isSupportedGpt56ModelName } from "@/lib/billing/openai-usage-accounting";
import type { ModelPriceData } from "@/types/model-price";

export interface BillingRateUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_5m_input_tokens?: number;
  cache_creation_1h_input_tokens?: number;
  cache_read_input_tokens?: number;
  input_image_tokens?: number;
}

export interface BillingUnitRates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type BillingPricingTier = "standard" | "standard_long_context" | "priority";
export type BillingRateSource =
  | "model_price_data"
  | "openai_official_supplement"
  | "mixed_model_price_data_and_supplement";
export type Gpt56UnsupportedPricingReason =
  | "gpt56_standard_rates_incomplete"
  | "gpt56_long_context_rates_incomplete"
  | "gpt56_priority_rates_incomplete"
  | "gpt56_priority_long_context_unsupported";

export interface ResolvedBillingRateSnapshot {
  tier: BillingPricingTier;
  unitRates: BillingUnitRates;
  rateSource: BillingRateSource;
  rateSourceId?: string;
  rateSourceUrl?: string;
}

export type RequestBillingRateResolution =
  | {
      status: "resolved";
      pricingTier: BillingPricingTier;
      observedInputTokens: number;
      rates: BillingUnitRates;
      rateSource: BillingRateSource;
      rateSourceId?: string;
      rateSourceUrl?: string;
    }
  | {
      status: "unsupported";
      reason: Gpt56UnsupportedPricingReason;
      observedInputTokens: number;
      missingFields: string[];
    };

export interface ResolveRequestBillingRatesInput {
  usage: BillingRateUsage;
  priceData: ModelPriceData;
  priorityServiceTierApplied: boolean;
  modelName?: string | null;
}

const GPT56_PRIORITY_RATE_FIELDS = {
  input: "input_cost_per_token_priority",
  cacheRead: "cache_read_input_token_cost_priority",
  cacheWrite: "cache_creation_input_token_cost_priority",
  output: "output_cost_per_token_priority",
} as const;

const GPT56_STANDARD_RATE_FIELDS = {
  input: "input_cost_per_token",
  cacheRead: "cache_read_input_token_cost",
  cacheWrite: "cache_creation_input_token_cost",
  output: "output_cost_per_token",
} as const;

const GPT56_LONG_CONTEXT_RATE_FIELDS = {
  input: "input_cost_per_token_above_272k_tokens",
  cacheRead: "cache_read_input_token_cost_above_272k_tokens",
  cacheWrite: "cache_creation_input_token_cost_above_272k_tokens",
  output: "output_cost_per_token_above_272k_tokens",
} as const;

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveRateSource(
  priceData: ModelPriceData,
  fields: Record<keyof BillingUnitRates, string>
): Pick<
  Extract<RequestBillingRateResolution, { status: "resolved" }>,
  "rateSource" | "rateSourceId" | "rateSourceUrl"
> {
  const supplement = priceData.openai_official_pricing_supplement;
  const selectedFields = Object.values(fields);
  const supplementedFieldCount = supplement
    ? selectedFields.filter((field) => supplement.applied_fields.includes(field)).length
    : 0;

  if (!supplement || supplementedFieldCount === 0) {
    return { rateSource: "model_price_data" };
  }

  return {
    rateSource:
      supplementedFieldCount === selectedFields.length
        ? "openai_official_supplement"
        : "mixed_model_price_data_and_supplement",
    rateSourceId: supplement.id,
    rateSourceUrl: supplement.source,
  };
}

export function isGpt56PriceData(priceData: ModelPriceData, modelName?: string | null): boolean {
  const candidates = [
    modelName,
    priceData.slug,
    priceData.selected_pricing_source_model,
    priceData.display_name,
  ];

  return candidates.some(isSupportedGpt56ModelName);
}

export function getObservedInputTokens(usage: BillingRateUsage): number {
  const cacheWrite =
    typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : (usage.cache_creation_5m_input_tokens ?? 0) + (usage.cache_creation_1h_input_tokens ?? 0);

  return (
    (usage.input_tokens ?? 0) +
    cacheWrite +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.input_image_tokens ?? 0)
  );
}

export function resolveRequestBillingRates(
  input: ResolveRequestBillingRatesInput
): RequestBillingRateResolution | null {
  if (!isGpt56PriceData(input.priceData, input.modelName)) {
    return null;
  }

  const observedInputTokens = getObservedInputTokens(input.usage);
  if (!input.priorityServiceTierApplied) {
    const longContext = observedInputTokens > 272000;
    const fields = longContext ? GPT56_LONG_CONTEXT_RATE_FIELDS : GPT56_STANDARD_RATE_FIELDS;
    const missingFields = Object.values(fields).filter(
      (field) => !isFinitePositiveNumber(input.priceData[field])
    );
    if (missingFields.length > 0) {
      return {
        status: "unsupported",
        reason: longContext
          ? "gpt56_long_context_rates_incomplete"
          : "gpt56_standard_rates_incomplete",
        observedInputTokens,
        missingFields,
      };
    }

    return {
      status: "resolved",
      pricingTier: longContext ? "standard_long_context" : "standard",
      observedInputTokens,
      rates: {
        input: input.priceData[fields.input] as number,
        cacheRead: input.priceData[fields.cacheRead] as number,
        cacheWrite: input.priceData[fields.cacheWrite] as number,
        output: input.priceData[fields.output] as number,
      },
      ...resolveRateSource(input.priceData, fields),
    };
  }

  if (observedInputTokens > 272000) {
    return {
      status: "unsupported",
      reason: "gpt56_priority_long_context_unsupported",
      observedInputTokens,
      missingFields: [],
    };
  }

  const missingFields = Object.values(GPT56_PRIORITY_RATE_FIELDS).filter(
    (field) => !isFinitePositiveNumber(input.priceData[field])
  );
  if (missingFields.length > 0) {
    return {
      status: "unsupported",
      reason: "gpt56_priority_rates_incomplete",
      observedInputTokens,
      missingFields,
    };
  }

  return {
    status: "resolved",
    pricingTier: "priority",
    observedInputTokens,
    rates: {
      input: input.priceData[GPT56_PRIORITY_RATE_FIELDS.input] as number,
      cacheRead: input.priceData[GPT56_PRIORITY_RATE_FIELDS.cacheRead] as number,
      cacheWrite: input.priceData[GPT56_PRIORITY_RATE_FIELDS.cacheWrite] as number,
      output: input.priceData[GPT56_PRIORITY_RATE_FIELDS.output] as number,
    },
    ...resolveRateSource(input.priceData, GPT56_PRIORITY_RATE_FIELDS),
  };
}
