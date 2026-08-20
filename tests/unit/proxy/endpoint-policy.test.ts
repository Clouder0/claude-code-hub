import { describe, expect, test } from "vitest";
import {
  isRawPassthroughEndpointPath,
  isRawPassthroughEndpointPolicy,
  resolveEndpointPolicy,
  shouldEnforceStrictEndpointPoolPolicy,
} from "@/app/v1/_lib/proxy/endpoint-policy";
import { V1_ENDPOINT_PATHS } from "@/app/v1/_lib/proxy/endpoint-paths";

describe("endpoint-policy", () => {
  test("raw passthrough endpoints resolve to identical strict policy", () => {
    const countTokensPolicy = resolveEndpointPolicy(V1_ENDPOINT_PATHS.MESSAGES_COUNT_TOKENS);
    const compactPolicy = resolveEndpointPolicy(V1_ENDPOINT_PATHS.RESPONSES_COMPACT);

    expect(countTokensPolicy).toBe(compactPolicy);
    expect(isRawPassthroughEndpointPolicy(countTokensPolicy)).toBe(true);
    expect(countTokensPolicy).toEqual({
      kind: "raw_passthrough",
      guardPreset: "raw_passthrough",
      allowRetry: false,
      allowProviderSwitch: false,
      allowRawCrossProviderFallback: true,
      allowCircuitBreakerAccounting: false,
      trackConcurrentRequests: false,
      bypassRequestFilters: true,
      bypassForwarderPreprocessing: true,
      bypassSpecialSettings: true,
      bypassResponseRectifier: true,
      endpointPoolStrictness: "strict",
      providerSelection: "normal",
    });
  });

  test.each([
    "/v1/messages/count_tokens/",
    "/V1/MESSAGES/COUNT_TOKENS",
    "/v1/responses/compact/",
    "/V1/RESPONSES/COMPACT",
  ])("raw passthrough endpoints path helper matches variant %s", (pathname) => {
    expect(isRawPassthroughEndpointPath(pathname)).toBe(true);
    expect(isRawPassthroughEndpointPolicy(resolveEndpointPolicy(pathname))).toBe(true);
  });

  test("default policy stays on non-target endpoints", () => {
    const messagesPolicy = resolveEndpointPolicy(V1_ENDPOINT_PATHS.MESSAGES);
    const responsesPolicy = resolveEndpointPolicy(V1_ENDPOINT_PATHS.RESPONSES);

    expect(messagesPolicy).toBe(responsesPolicy);
    expect(isRawPassthroughEndpointPolicy(messagesPolicy)).toBe(false);
    expect(messagesPolicy).toEqual({
      kind: "default",
      guardPreset: "chat",
      allowRetry: true,
      allowProviderSwitch: true,
      allowRawCrossProviderFallback: false,
      allowCircuitBreakerAccounting: true,
      trackConcurrentRequests: true,
      bypassRequestFilters: false,
      bypassForwarderPreprocessing: false,
      bypassSpecialSettings: false,
      bypassResponseRectifier: false,
      endpointPoolStrictness: "inherit",
      providerSelection: "normal",
    });
  });

  test("alpha search is strict sticky-only raw passthrough", () => {
    const policy = resolveEndpointPolicy(V1_ENDPOINT_PATHS.ALPHA_SEARCH);

    expect(isRawPassthroughEndpointPolicy(policy)).toBe(true);
    expect(policy).toEqual({
      kind: "alpha_search",
      guardPreset: "alpha_search",
      allowRetry: false,
      allowProviderSwitch: false,
      allowRawCrossProviderFallback: false,
      allowCircuitBreakerAccounting: false,
      trackConcurrentRequests: true,
      bypassRequestFilters: true,
      bypassForwarderPreprocessing: true,
      bypassSpecialSettings: true,
      bypassResponseRectifier: true,
      endpointPoolStrictness: "strict",
      providerSelection: "sticky_only",
    });
  });

  test("inherited endpoint pool policy still enforces strict endpoint selection", () => {
    expect(
      shouldEnforceStrictEndpointPoolPolicy(resolveEndpointPolicy(V1_ENDPOINT_PATHS.MESSAGES))
    ).toBe(true);
    expect(
      shouldEnforceStrictEndpointPoolPolicy(
        resolveEndpointPolicy(V1_ENDPOINT_PATHS.CHAT_COMPLETIONS)
      )
    ).toBe(true);
  });
});
