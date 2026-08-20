import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";

export type EndpointGuardPreset = "chat" | "raw_passthrough" | "alpha_search";

export type EndpointPoolStrictness = "inherit" | "strict";

export type EndpointProviderSelection = "normal" | "sticky_only";

export interface EndpointPolicy {
  readonly kind: "default" | "raw_passthrough" | "alpha_search";
  readonly guardPreset: EndpointGuardPreset;
  readonly allowRetry: boolean;
  readonly allowProviderSwitch: boolean;
  readonly allowRawCrossProviderFallback: boolean;
  readonly allowCircuitBreakerAccounting: boolean;
  readonly trackConcurrentRequests: boolean;
  readonly bypassRequestFilters: boolean;
  readonly bypassForwarderPreprocessing: boolean;
  readonly bypassSpecialSettings: boolean;
  readonly bypassResponseRectifier: boolean;
  readonly endpointPoolStrictness: EndpointPoolStrictness;
  readonly providerSelection: EndpointProviderSelection;
}

const DEFAULT_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
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

const RAW_PASSTHROUGH_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
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

const ALPHA_SEARCH_ENDPOINT_POLICY: EndpointPolicy = Object.freeze({
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

const rawPassthroughEndpointPathSet = new Set<string>([
  V1_ENDPOINT_PATHS.MESSAGES_COUNT_TOKENS,
  V1_ENDPOINT_PATHS.RESPONSES_COMPACT,
]);

export function isRawPassthroughEndpointPath(pathname: string): boolean {
  return rawPassthroughEndpointPathSet.has(normalizeEndpointPath(pathname));
}

export function isRawPassthroughEndpointPolicy(policy: EndpointPolicy): boolean {
  return policy.kind === "raw_passthrough" || policy.kind === "alpha_search";
}

export function isStrictEndpointPoolPolicy(policy: Pick<EndpointPolicy, "endpointPoolStrictness">) {
  return policy.endpointPoolStrictness === "strict";
}

export function shouldEnforceStrictEndpointPoolPolicy(
  policy: Pick<EndpointPolicy, "endpointPoolStrictness">
) {
  return policy.endpointPoolStrictness === "strict" || policy.endpointPoolStrictness === "inherit";
}

export function resolveEndpointPolicy(pathname: string): EndpointPolicy {
  const normalizedPath = normalizeEndpointPath(pathname);

  if (normalizedPath === V1_ENDPOINT_PATHS.ALPHA_SEARCH) {
    return ALPHA_SEARCH_ENDPOINT_POLICY;
  }

  if (rawPassthroughEndpointPathSet.has(normalizedPath)) {
    return RAW_PASSTHROUGH_ENDPOINT_POLICY;
  }

  return DEFAULT_ENDPOINT_POLICY;
}
