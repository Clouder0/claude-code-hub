import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";

export interface ProxySessionCreationOptions {
  highConcurrencyModeEnabled?: boolean;
}

const DIAGNOSTIC_STRING_MAX_LENGTH = 256;

function summarizeDiagnosticString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, DIAGNOSTIC_STRING_MAX_LENGTH);
}

// 摄入侧人群（直读原始流 + parse 即丢 buffer + 摘要日志）：仅标准 /v1/responses。
// /v1/responses/compact 是 raw_passthrough 端点——其转发通货就是 request.buffer，
// 且契约要求 c.req.raw 保持未消费（bodyUsed=false），不能进本人群。
const HIGH_CONCURRENCY_CODEX_INTAKE_ENDPOINTS = new Set<string>([V1_ENDPOINT_PATHS.RESPONSES]);

// 释放侧人群（TTFB 释放/资格门控）：compact 一并纳入——它是流式 codex
// （生产实测 TTFB 1-7s ≪ duration 29-168s），此前因精确匹配错过释放，
// 树+buffer 持有到整个 compact 生命周期（~4×）。
const HIGH_CONCURRENCY_CODEX_RELEASE_ENDPOINTS = new Set<string>([
  V1_ENDPOINT_PATHS.RESPONSES,
  V1_ENDPOINT_PATHS.RESPONSES_COMPACT,
]);

export function shouldDirectlyConsumeHighConcurrencyCodexRequest(
  pathname: string,
  options: ProxySessionCreationOptions
): boolean {
  return (
    options.highConcurrencyModeEnabled === true &&
    HIGH_CONCURRENCY_CODEX_INTAKE_ENDPOINTS.has(normalizeEndpointPath(pathname))
  );
}

/** TTFB 释放/资格门控的端点判定：摄入人群是其子集，杜绝两处漂移。 */
export function isHighConcurrencyCodexReleaseEndpoint(pathname: string): boolean {
  return HIGH_CONCURRENCY_CODEX_RELEASE_ENDPOINTS.has(normalizeEndpointPath(pathname));
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

/**
 * 快速路径的等价摘要：由扫描事实直接构造，字段与树路径摘要一一对应。
 * （model/service_tier 经扫描器解码上限保护，slice(0,256) 语义不变。）
 */
export function buildHighConcurrencyCodexRequestSummaryFromScan(
  scan: import("./body-scanner").BodyScanResult,
  receivedBodyBytes: number,
  decodedBodyBytes: number
): string {
  return JSON.stringify({
    diagnostic: "high_concurrency_codex_request_body_omitted",
    model: summarizeDiagnosticString(
      typeof scan.fields.model?.value === "string" ? scan.fields.model.value : null
    ),
    stream: scan.fields.stream?.value === true,
    serviceTier: summarizeDiagnosticString(
      typeof scan.fields.service_tier?.value === "string" ? scan.fields.service_tier.value : null
    ),
    inputItemCount: scan.facts.inputItemCount,
    toolCount: scan.facts.toolCount,
    hasInstructions: scan.facts.hasInstructions,
    hasPromptCacheKey:
      typeof scan.fields.prompt_cache_key?.value === "string" &&
      scan.fields.prompt_cache_key.value.length > 0,
    receivedBodyBytes,
    decodedBodyBytes,
  });
}
