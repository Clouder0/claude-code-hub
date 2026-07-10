export type CacheWriteAccounting =
  | "reported_positive"
  | "inferred_input_minus_cache_read_v1"
  | "none";

export interface OpenAIUsageAccountingInput {
  observedInputTokens: number;
  cachedTokens?: number | null;
  cacheWriteTokensReported?: number | null;
  inferUnreportedCacheWrite: boolean;
}

export interface OpenAIUsageAllocation {
  observedInputTokens: number;
  ordinaryInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWriteTokensReported: number | null;
  cacheWriteAccounting: CacheWriteAccounting;
}

export interface OpenAICacheWriteInferenceContext {
  modelName: string | null | undefined;
  providerType: string | null | undefined;
  observedInputTokens: number;
  cachedTokensPresent: boolean;
  cacheWriteCostPerToken: number | null | undefined;
  requestBody: unknown;
}

const GPT_56_MODEL_PATTERN =
  /^(?:openai\/)?gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}(?:-\d{2}){0,2})?(?:[:@][a-z0-9._-]+)?$/i;
const OPENAI_SUBSET_PROVIDER_TYPES = new Set(["codex", "openai-compatible"]);
const MAX_CACHE_BREAKPOINT_SCAN_NODES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPromptCacheBreakpoint(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let scanned = 0;

  while (pending.length > 0 && scanned < MAX_CACHE_BREAKPOINT_SCAN_NODES) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    scanned += 1;

    if (isRecord(current) && Object.hasOwn(current, "prompt_cache_breakpoint")) {
      return true;
    }

    if (Array.isArray(current)) {
      pending.push(...current);
    } else {
      pending.push(...Object.values(current));
    }
  }

  return false;
}

function explicitlyDisablesImplicitCaching(requestBody: unknown): boolean {
  if (!isRecord(requestBody)) {
    return false;
  }
  const options = requestBody.prompt_cache_options;
  return isRecord(options) && options.mode === "explicit" && !hasPromptCacheBreakpoint(requestBody);
}

export function isSupportedGpt56ModelName(value: unknown): value is string {
  return typeof value === "string" && GPT_56_MODEL_PATTERN.test(value.trim());
}

export function shouldInferOpenAICacheWrite(context: OpenAICacheWriteInferenceContext): boolean {
  return (
    isSupportedGpt56ModelName(context.modelName) &&
    typeof context.providerType === "string" &&
    OPENAI_SUBSET_PROVIDER_TYPES.has(context.providerType) &&
    normalizeTokenCount(context.observedInputTokens) >= 1024 &&
    context.cachedTokensPresent &&
    typeof context.cacheWriteCostPerToken === "number" &&
    Number.isFinite(context.cacheWriteCostPerToken) &&
    context.cacheWriteCostPerToken > 0 &&
    !explicitlyDisablesImplicitCaching(context.requestBody)
  );
}

function normalizeTokenCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function allocateOpenAIUsage(input: OpenAIUsageAccountingInput): OpenAIUsageAllocation {
  const observedInputTokens = normalizeTokenCount(input.observedInputTokens);
  const cacheReadInputTokens = Math.min(
    normalizeTokenCount(input.cachedTokens),
    observedInputTokens
  );
  const remainingInputTokens = observedInputTokens - cacheReadInputTokens;
  const reportedWriteTokens = normalizeTokenCount(input.cacheWriteTokensReported);
  const hasReportedWrite = reportedWriteTokens > 0;
  const shouldInferWrite = !hasReportedWrite && input.inferUnreportedCacheWrite;
  const cacheWriteInputTokens = hasReportedWrite
    ? Math.min(reportedWriteTokens, remainingInputTokens)
    : shouldInferWrite
      ? remainingInputTokens
      : 0;

  return {
    observedInputTokens,
    ordinaryInputTokens: remainingInputTokens - cacheWriteInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    cacheWriteTokensReported:
      typeof input.cacheWriteTokensReported === "number"
        ? normalizeTokenCount(input.cacheWriteTokensReported)
        : null,
    cacheWriteAccounting: hasReportedWrite
      ? "reported_positive"
      : shouldInferWrite
        ? "inferred_input_minus_cache_read_v1"
        : "none",
  };
}
