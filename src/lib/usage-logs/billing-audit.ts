import { toDecimal } from "@/lib/utils/currency";
import type { SpecialSetting } from "@/types/special-settings";

export function resolveUnitRatePerMillion(input: {
  storedRatePerToken?: string | number | null;
}): number | null {
  const storedRate = toDecimal(input.storedRatePerToken);
  if (storedRate && !storedRate.isNegative()) {
    return storedRate.mul(1_000_000).toNumber();
  }
  return null;
}

function normalizeServiceTier(value: string | null): string | null {
  if (value == null) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "default" || normalized === "auto") return "standard";
  return normalized;
}

export function resolveEffectiveServiceTier(
  specialSettings?: SpecialSetting[] | null,
  pricingTier?: "standard" | "standard_long_context" | "priority" | null
): string | null {
  if (pricingTier === "priority") return "priority";
  if (pricingTier === "standard" || pricingTier === "standard_long_context") return "standard";

  const result = specialSettings?.find(
    (
      setting
    ): setting is Extract<
      SpecialSetting,
      { type: "codex_service_tier_result" | "openai_service_tier_result" }
    > =>
      setting.type === "openai_service_tier_result" || setting.type === "codex_service_tier_result"
  );
  if (!result) return null;

  if (result.resolvedFrom === "actual") {
    return normalizeServiceTier(result.actualServiceTier);
  }
  if (result.resolvedFrom === "requested") {
    return normalizeServiceTier(result.requestedServiceTier);
  }
  if (result.actualServiceTier != null) {
    return normalizeServiceTier(result.actualServiceTier);
  }
  if (result.effectivePriority) {
    return "priority";
  }
  return null;
}

export interface LongContextPricingAudit {
  pricingScope: "request" | "session" | null;
  thresholdTokens: number | null;
}

export function resolveLongContextPricingAudit(
  specialSettings?: SpecialSetting[] | null,
  pricingTier?: "standard" | "standard_long_context" | "priority" | null
): LongContextPricingAudit | null {
  const setting = specialSettings?.find(
    (item): item is Extract<SpecialSetting, { type: "long_context_pricing" }> =>
      item.type === "long_context_pricing" && item.hit
  );
  if (setting) {
    return { pricingScope: setting.pricingScope, thresholdTokens: setting.thresholdTokens };
  }
  return pricingTier === "standard_long_context"
    ? { pricingScope: "request", thresholdTokens: null }
    : null;
}

export function resolveBillingSettlement(
  specialSettings?: SpecialSetting[] | null
): Extract<SpecialSetting, { type: "billing_settlement" }> | null {
  return (
    specialSettings?.find(
      (setting): setting is Extract<SpecialSetting, { type: "billing_settlement" }> =>
        setting.type === "billing_settlement"
    ) ?? null
  );
}
