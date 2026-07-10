import { describe, expect, it } from "vitest";
import {
  allocateOpenAIUsage,
  shouldInferOpenAICacheWrite,
} from "@/lib/billing/openai-usage-accounting";

describe("allocateOpenAIUsage", () => {
  it("allocates an explicitly reported cache write without double-counting input", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 2_000,
      cachedTokens: 300,
      cacheWriteTokensReported: 800,
      inferUnreportedCacheWrite: true,
    });

    expect(allocation).toEqual({
      observedInputTokens: 2_000,
      ordinaryInputTokens: 900,
      cacheReadInputTokens: 300,
      cacheWriteInputTokens: 800,
      cacheWriteTokensReported: 800,
      cacheWriteAccounting: "reported_positive",
    });
  });

  it("infers a cache write from the uncached remainder when upstream reports zero", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 9_016,
      cachedTokens: 7_936,
      cacheWriteTokensReported: 0,
      inferUnreportedCacheWrite: true,
    });

    expect(allocation).toEqual({
      observedInputTokens: 9_016,
      ordinaryInputTokens: 0,
      cacheReadInputTokens: 7_936,
      cacheWriteInputTokens: 1_080,
      cacheWriteTokensReported: 0,
      cacheWriteAccounting: "inferred_input_minus_cache_read_v1",
    });
  });

  it("keeps a missing reported write distinct from an explicit zero", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 9_016,
      cachedTokens: 0,
      inferUnreportedCacheWrite: true,
    });

    expect(allocation.cacheWriteTokensReported).toBeNull();
    expect(allocation.cacheWriteInputTokens).toBe(9_016);
    expect(allocation.cacheWriteAccounting).toBe("inferred_input_minus_cache_read_v1");
  });

  it("leaves uncached input ordinary when inference is not eligible", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 900,
      cachedTokens: 0,
      cacheWriteTokensReported: 0,
      inferUnreportedCacheWrite: false,
    });

    expect(allocation).toMatchObject({
      ordinaryInputTokens: 900,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWriteAccounting: "none",
    });
  });

  it("clamps malformed bucket totals to the observed input", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 1_500,
      cachedTokens: 2_000,
      cacheWriteTokensReported: 900,
      inferUnreportedCacheWrite: true,
    });

    expect(allocation).toMatchObject({
      ordinaryInputTokens: 0,
      cacheReadInputTokens: 1_500,
      cacheWriteInputTokens: 0,
      cacheWriteAccounting: "reported_positive",
    });
  });

  it("preserves the accounting invariant across boundary combinations", () => {
    const tokenCounts = [-1, 0, 1, 1_023, 1_024, 272_000, 272_001];

    for (const observedInputTokens of tokenCounts) {
      for (const cachedTokens of tokenCounts) {
        for (const cacheWriteTokensReported of [undefined, 0, 1, 999_999]) {
          const allocation = allocateOpenAIUsage({
            observedInputTokens,
            cachedTokens,
            cacheWriteTokensReported,
            inferUnreportedCacheWrite: true,
          });
          expect(
            allocation.ordinaryInputTokens +
              allocation.cacheReadInputTokens +
              allocation.cacheWriteInputTokens
          ).toBe(allocation.observedInputTokens);
          expect(allocation.ordinaryInputTokens).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("shouldInferOpenAICacheWrite", () => {
  it("enables inference for eligible GPT-5.6 OpenAI-subset usage", () => {
    expect(
      shouldInferOpenAICacheWrite({
        modelName: "gpt-5.6-sol",
        providerType: "codex",
        observedInputTokens: 1024,
        cachedTokensPresent: true,
        cacheWriteCostPerToken: 0.00000625,
        requestBody: {},
      })
    ).toBe(true);
  });

  it("enables inference for provider-qualified and snapshot GPT-5.6 aliases", () => {
    for (const modelName of [
      "openai/gpt-5.6-sol",
      "gpt-5.6-terra-2026-07-10",
      "gpt-5.6-luna:latest",
    ]) {
      expect(
        shouldInferOpenAICacheWrite({
          modelName,
          providerType: "openai-compatible",
          observedInputTokens: 9_016,
          cachedTokensPresent: true,
          cacheWriteCostPerToken: 0.00000125,
          requestBody: {},
        })
      ).toBe(true);
    }
  });

  it("disables inference for explicit cache mode without a breakpoint", () => {
    expect(
      shouldInferOpenAICacheWrite({
        modelName: "gpt-5.6-terra",
        providerType: "openai-compatible",
        observedInputTokens: 9_016,
        cachedTokensPresent: true,
        cacheWriteCostPerToken: 0.000003125,
        requestBody: { prompt_cache_options: { mode: "explicit" }, input: [] },
      })
    ).toBe(false);
  });

  it("allows explicit cache mode when a breakpoint is present", () => {
    expect(
      shouldInferOpenAICacheWrite({
        modelName: "openai/gpt-5.6-luna",
        providerType: "openai-compatible",
        observedInputTokens: 1_024,
        cachedTokensPresent: true,
        cacheWriteCostPerToken: 0.00000125,
        requestBody: {
          prompt_cache_options: { mode: "explicit" },
          input: [
            {
              content: [
                {
                  type: "input_text",
                  text: "stable",
                  prompt_cache_breakpoint: { mode: "explicit" },
                },
              ],
            },
          ],
        },
      })
    ).toBe(true);
  });

  it.each([
    ["non-GPT-5.6 model", { modelName: "gpt-5.5" }],
    ["unknown GPT-5.6 suffix", { modelName: "gpt-5.6-pro" }],
    ["unsupported provider", { providerType: "claude" }],
    ["short prompt", { observedInputTokens: 1_023 }],
    ["missing cached token observation", { cachedTokensPresent: false }],
    ["missing write price", { cacheWriteCostPerToken: undefined }],
  ])("disables inference for %s", (_label, override) => {
    expect(
      shouldInferOpenAICacheWrite({
        modelName: "gpt-5.6-sol",
        providerType: "codex",
        observedInputTokens: 9_016,
        cachedTokensPresent: true,
        cacheWriteCostPerToken: 0.00000625,
        requestBody: {},
        ...override,
      })
    ).toBe(false);
  });
});
