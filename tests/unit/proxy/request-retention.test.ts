import { describe, expect, it } from "vitest";
import {
  buildHighConcurrencyCodexRequestSummary,
  isHighConcurrencyCodexReleaseEndpoint,
  shouldDirectlyConsumeHighConcurrencyCodexRequest,
  shouldUseHighConcurrencyCodexSseRetention,
} from "@/app/v1/_lib/proxy/request-retention";

describe("Codex request retention policy", () => {
  it("directly consumes only high-concurrency standard Responses requests", () => {
    expect(
      shouldDirectlyConsumeHighConcurrencyCodexRequest("/v1/responses", {
        highConcurrencyModeEnabled: true,
      })
    ).toBe(true);
    expect(
      shouldDirectlyConsumeHighConcurrencyCodexRequest("/V1/RESPONSES/", {
        highConcurrencyModeEnabled: true,
      })
    ).toBe(true);
    expect(
      shouldDirectlyConsumeHighConcurrencyCodexRequest("/v1/responses", {
        highConcurrencyModeEnabled: false,
      })
    ).toBe(false);
    expect(
      shouldDirectlyConsumeHighConcurrencyCodexRequest("/v1/responses/compact", {
        highConcurrencyModeEnabled: true,
      })
    ).toBe(false);
  });

  it("uses lightweight retained state only for streaming requests", () => {
    const options = { highConcurrencyModeEnabled: true };

    expect(
      shouldUseHighConcurrencyCodexSseRetention("/v1/responses", { stream: true }, options)
    ).toBe(true);
    expect(
      shouldUseHighConcurrencyCodexSseRetention("/v1/responses", { stream: false }, options)
    ).toBe(false);
    expect(shouldUseHighConcurrencyCodexSseRetention("/v1/responses", { stream: true }, {})).toBe(
      false
    );
  });

  it("builds a bounded structural summary without request content", () => {
    const sensitive = "sensitive".repeat(10_000);
    const summaryText = buildHighConcurrencyCodexRequestSummary(
      {
        model: `gpt-${"m".repeat(1_000)}`,
        stream: true,
        service_tier: `priority-${"t".repeat(1_000)}`,
        instructions: sensitive,
        input: [{ content: sensitive }],
        tools: [{ name: "tool" }],
        prompt_cache_key: sensitive,
      },
      123,
      456
    );
    const summary = JSON.parse(summaryText);

    expect(summaryText.length).toBeLessThan(1_024);
    expect(summaryText).not.toContain("sensitive");
    expect(summary).toMatchObject({
      diagnostic: "high_concurrency_codex_request_body_omitted",
      stream: true,
      inputItemCount: 1,
      toolCount: 1,
      hasInstructions: true,
      hasPromptCacheKey: true,
      receivedBodyBytes: 123,
      decodedBodyBytes: 456,
    });
    expect(summary.model).toHaveLength(256);
    expect(summary.serviceTier).toHaveLength(256);
  });

  it("keeps missing optional diagnostic facts explicit", () => {
    expect(JSON.parse(buildHighConcurrencyCodexRequestSummary({}, 0, 0))).toEqual({
      diagnostic: "high_concurrency_codex_request_body_omitted",
      model: null,
      stream: false,
      serviceTier: null,
      inputItemCount: null,
      toolCount: null,
      hasInstructions: false,
      hasPromptCacheKey: false,
      receivedBodyBytes: 0,
      decodedBodyBytes: 0,
    });
  });
});

describe("high-concurrency codex release endpoint set", () => {
  it("releases both /v1/responses and /v1/responses/compact at TTFB", () => {
    expect(isHighConcurrencyCodexReleaseEndpoint("/v1/responses")).toBe(true);
    expect(isHighConcurrencyCodexReleaseEndpoint("/V1/RESPONSES/COMPACT/")).toBe(true);
    expect(isHighConcurrencyCodexReleaseEndpoint("/v1/messages")).toBe(false);
    expect(isHighConcurrencyCodexReleaseEndpoint("/v1/responses/other")).toBe(false);
  });
});
