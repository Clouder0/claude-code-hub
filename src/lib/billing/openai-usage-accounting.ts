export type CacheWriteAccounting =
  | "reported_positive"
  | "inferred_input_minus_cache_read_v1"
  | "none";

export interface OpenAIUsageAccountingInput {
  observedInputTokens: number;
  cachedTokens?: number | null;
  cacheWriteTokensReported?: number | null;
}

export interface OpenAIUsageAllocation {
  observedInputTokens: number;
  ordinaryInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  cacheWriteTokensReported: number | null;
  cacheWriteAccounting: CacheWriteAccounting;
}

const GPT_56_MODEL_PATTERN =
  /^(?:openai\/)?gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}(?:-\d{2}){0,2})?(?:[:@][a-z0-9._-]+)?$/i;

export function isSupportedGpt56ModelName(value: unknown): value is string {
  return typeof value === "string" && GPT_56_MODEL_PATTERN.test(value.trim());
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
  const cacheWriteInputTokens = hasReportedWrite
    ? Math.min(reportedWriteTokens, remainingInputTokens)
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
    cacheWriteAccounting: hasReportedWrite ? "reported_positive" : "none",
  };
}
