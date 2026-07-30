import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";

export interface ProxySessionCreationOptions {
  highConcurrencyModeEnabled?: boolean;
}

const DIAGNOSTIC_STRING_MAX_LENGTH = 256;

function summarizeDiagnosticString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, DIAGNOSTIC_STRING_MAX_LENGTH);
}

export function shouldDirectlyConsumeHighConcurrencyCodexRequest(
  pathname: string,
  options: ProxySessionCreationOptions
): boolean {
  return (
    options.highConcurrencyModeEnabled === true &&
    normalizeEndpointPath(pathname) === V1_ENDPOINT_PATHS.RESPONSES
  );
}

export function shouldUseHighConcurrencyCodexSseRetention(
  pathname: string,
  message: Record<string, unknown>,
  options: ProxySessionCreationOptions
): boolean {
  return (
    shouldDirectlyConsumeHighConcurrencyCodexRequest(pathname, options) && message.stream === true
  );
}

export function buildHighConcurrencyCodexRequestSummary(
  message: Record<string, unknown>,
  receivedBodyBytes: number,
  decodedBodyBytes: number
): string {
  return JSON.stringify({
    diagnostic: "high_concurrency_codex_request_body_omitted",
    model: summarizeDiagnosticString(message.model),
    stream: message.stream === true,
    serviceTier: summarizeDiagnosticString(message.service_tier),
    inputItemCount: Array.isArray(message.input) ? message.input.length : null,
    toolCount: Array.isArray(message.tools) ? message.tools.length : null,
    hasInstructions: typeof message.instructions === "string" && message.instructions.length > 0,
    hasPromptCacheKey:
      typeof message.prompt_cache_key === "string" && message.prompt_cache_key.length > 0,
    receivedBodyBytes,
    decodedBodyBytes,
  });
}
