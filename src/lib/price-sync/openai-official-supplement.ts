import type { CptPricingVariant } from "./cpt-schema";

const MILLION = 1_000_000;

export const OPENAI_OFFICIAL_GPT56_PRICING_SUPPLEMENT_ID = "openai-gpt-5.6-2026-07-10";
const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";

type Gpt56RateTuple = readonly [
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number,
];

interface Gpt56RateProfile {
  standard: Gpt56RateTuple;
  priority: Gpt56RateTuple;
}

const GPT56_RATE_PROFILES: Record<string, Gpt56RateProfile> = {
  "gpt-5.6": {
    standard: [5, 0.5, 6.25, 30],
    priority: [10, 1, 12.5, 60],
  },
  "gpt-5.6-sol": {
    standard: [5, 0.5, 6.25, 30],
    priority: [10, 1, 12.5, 60],
  },
  "gpt-5.6-terra": {
    standard: [2.5, 0.25, 3.125, 15],
    priority: [5, 0.5, 6.25, 30],
  },
  "gpt-5.6-luna": {
    standard: [1, 0.1, 1.25, 6],
    priority: [2, 0.2, 2.5, 12],
  },
};

function toPerTokenRates(profile: Gpt56RateProfile): Record<string, number> {
  const [standardInput, standardCacheRead, standardCacheWrite, standardOutput] = profile.standard;
  const [priorityInput, priorityCacheRead, priorityCacheWrite, priorityOutput] = profile.priority;

  return {
    input_cost_per_token: standardInput / MILLION,
    cache_read_input_token_cost: standardCacheRead / MILLION,
    cache_creation_input_token_cost: standardCacheWrite / MILLION,
    output_cost_per_token: standardOutput / MILLION,
    input_cost_per_token_priority: priorityInput / MILLION,
    cache_read_input_token_cost_priority: priorityCacheRead / MILLION,
    cache_creation_input_token_cost_priority: priorityCacheWrite / MILLION,
    output_cost_per_token_priority: priorityOutput / MILLION,
  };
}

interface ApplyOpenAiOfficialPricingSupplementInput {
  modelName: string;
  variant: CptPricingVariant;
  converted: Record<string, unknown>;
}

function ratesMatch(actual: unknown, expected: number): boolean {
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return false;
  }

  const tolerance = Math.max(1e-18, Math.abs(expected) * 1e-9);
  return Math.abs(actual - expected) <= tolerance;
}

export function applyOpenAiOfficialPricingSupplement(
  input: ApplyOpenAiOfficialPricingSupplementInput
): Record<string, unknown> {
  const profile = GPT56_RATE_PROFILES[input.modelName];
  if (!profile || input.variant.provider !== "openai" || input.variant.official !== true) {
    return input.converted;
  }

  const supplemented = { ...input.converted };
  const appliedFields: string[] = [];
  const conflictingFields: string[] = [];
  for (const [field, value] of Object.entries(toPerTokenRates(profile))) {
    if (supplemented[field] === undefined) {
      supplemented[field] = value;
      appliedFields.push(field);
    } else if (!ratesMatch(supplemented[field], value)) {
      conflictingFields.push(field);
    }
  }
  supplemented.openai_official_pricing_supplement = {
    id: OPENAI_OFFICIAL_GPT56_PRICING_SUPPLEMENT_ID,
    source: OPENAI_PRICING_SOURCE,
    applied_fields: appliedFields,
    conflicting_fields: conflictingFields,
  };
  return supplemented;
}
