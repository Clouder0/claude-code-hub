import { describe, expect, it } from "vitest";
import { allocateOpenAIUsage } from "@/lib/billing/openai-usage-accounting";

describe("allocateOpenAIUsage", () => {
  it("allocates an explicitly reported cache write without double-counting input", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 2_000,
      cachedTokens: 300,
      cacheWriteTokensReported: 800,
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

  it("leaves the uncached remainder as ordinary input when upstream reports zero", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 9_016,
      cachedTokens: 7_936,
      cacheWriteTokensReported: 0,
    });

    expect(allocation).toEqual({
      observedInputTokens: 9_016,
      ordinaryInputTokens: 1_080,
      cacheReadInputTokens: 7_936,
      cacheWriteInputTokens: 0,
      cacheWriteTokensReported: 0,
      cacheWriteAccounting: "none",
    });
  });

  it("keeps a missing reported write distinct from an explicit zero", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 9_016,
      cachedTokens: 0,
    });

    expect(allocation.cacheWriteTokensReported).toBeNull();
    expect(allocation.ordinaryInputTokens).toBe(9_016);
    expect(allocation.cacheWriteInputTokens).toBe(0);
    expect(allocation.cacheWriteAccounting).toBe("none");
  });

  it("leaves uncached input ordinary when inference is not eligible", () => {
    const allocation = allocateOpenAIUsage({
      observedInputTokens: 900,
      cachedTokens: 0,
      cacheWriteTokensReported: 0,
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
