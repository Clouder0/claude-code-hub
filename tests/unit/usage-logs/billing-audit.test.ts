import { describe, expect, test } from "vitest";
import {
  resolveUnitRatePerMillion,
  resolveEffectiveServiceTier,
  resolveBillingSettlement,
  resolveLongContextPricingAudit,
} from "@/lib/usage-logs/billing-audit";
import type { SpecialSetting } from "@/types/special-settings";

function serviceTierSetting(
  overrides: Partial<Extract<SpecialSetting, { type: "codex_service_tier_result" }>> = {}
): Extract<SpecialSetting, { type: "codex_service_tier_result" }> {
  return {
    type: "codex_service_tier_result",
    scope: "response",
    hit: true,
    requestedServiceTier: "priority",
    actualServiceTier: "default",
    billingSourcePreference: "actual",
    resolvedFrom: "actual",
    effectivePriority: false,
    ...overrides,
  };
}

describe("resolveEffectiveServiceTier", () => {
  test("uses the actual tier and normalizes an upstream default downgrade to standard", () => {
    expect(resolveEffectiveServiceTier([serviceTierSetting()])).toBe("standard");
  });

  test("supports the public OpenAI-compatible service-tier result", () => {
    expect(
      resolveEffectiveServiceTier([
        {
          type: "openai_service_tier_result",
          scope: "response",
          hit: true,
          providerType: "openai-compatible",
          requestedServiceTier: "priority",
          actualServiceTier: "default",
          resolvedFrom: "actual",
          effectivePriority: false,
        },
      ])
    ).toBe("standard");
  });

  test("falls back to the immutable pricing snapshot tier", () => {
    expect(resolveEffectiveServiceTier(null, "standard_long_context")).toBe("standard");
    expect(resolveEffectiveServiceTier(null, "priority")).toBe("priority");
  });

  test("covers requested, legacy actual, and legacy effective-priority fallbacks", () => {
    expect(
      resolveEffectiveServiceTier([
        serviceTierSetting({
          requestedServiceTier: "priority",
          actualServiceTier: null,
          resolvedFrom: "requested",
          effectivePriority: true,
        }),
      ])
    ).toBe("priority");
    expect(
      resolveEffectiveServiceTier([
        serviceTierSetting({
          requestedServiceTier: null,
          actualServiceTier: "auto",
          resolvedFrom: null,
          effectivePriority: false,
        }),
      ])
    ).toBe("standard");
    expect(
      resolveEffectiveServiceTier([
        serviceTierSetting({
          requestedServiceTier: null,
          actualServiceTier: null,
          resolvedFrom: null,
          effectivePriority: true,
        }),
      ])
    ).toBe("priority");
    expect(
      resolveEffectiveServiceTier([
        serviceTierSetting({
          requestedServiceTier: null,
          actualServiceTier: null,
          resolvedFrom: null,
          effectivePriority: false,
        }),
      ])
    ).toBeNull();
    expect(resolveEffectiveServiceTier(null)).toBeNull();
  });
});

describe("resolveLongContextPricingAudit", () => {
  test("returns the persisted applied scope and threshold", () => {
    expect(
      resolveLongContextPricingAudit([
        {
          type: "long_context_pricing",
          scope: "billing",
          hit: true,
          pricingScope: "request",
          thresholdTokens: 272000,
        },
      ])
    ).toEqual({ pricingScope: "request", thresholdTokens: 272000 });
  });

  test("recognizes long context from the immutable pricing snapshot", () => {
    expect(resolveLongContextPricingAudit(null, "standard_long_context")).toEqual({
      pricingScope: "request",
      thresholdTokens: null,
    });
  });

  test("ignores a non-hit long-context setting", () => {
    expect(
      resolveLongContextPricingAudit([
        {
          type: "long_context_pricing",
          scope: "billing",
          hit: false,
          pricingScope: "request",
          thresholdTokens: 272000,
        },
      ])
    ).toBeNull();
  });
});

describe("resolveUnitRatePerMillion", () => {
  test("converts the immutable per-token snapshot rate even when a bucket used zero tokens", () => {
    expect(
      resolveUnitRatePerMillion({
        storedRatePerToken: "0.0000125",
      })
    ).toBe(12.5);
  });

  test("does not infer a unit rate when the persisted pricing snapshot is absent", () => {
    expect(resolveUnitRatePerMillion({ storedRatePerToken: null })).toBeNull();
    expect(resolveUnitRatePerMillion({ storedRatePerToken: undefined })).toBeNull();
    expect(resolveUnitRatePerMillion({ storedRatePerToken: "-0.000001" })).toBeNull();
  });
});

describe("resolveBillingSettlement", () => {
  test("returns an unsupported pricing settlement without interpreting unrelated settings", () => {
    expect(
      resolveBillingSettlement([
        {
          type: "billing_settlement",
          scope: "billing",
          hit: true,
          status: "unsupported",
          reason: "gpt56_priority_long_context_unsupported",
          observedInputTokens: 272001,
          missingFields: [],
        },
      ])
    ).toMatchObject({
      status: "unsupported",
      reason: "gpt56_priority_long_context_unsupported",
      observedInputTokens: 272001,
    });
  });

  test("returns null when no settlement audit exists", () => {
    expect(resolveBillingSettlement(null)).toBeNull();
    expect(
      resolveBillingSettlement([
        {
          type: "long_context_pricing",
          scope: "billing",
          hit: true,
          pricingScope: "request",
          thresholdTokens: 272000,
        },
      ])
    ).toBeNull();
  });
});
