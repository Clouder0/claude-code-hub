const OPENAI_COMPATIBLE_PROVIDER_TYPES = new Set(["openai-compatible"]);

/**
 * ensureOpenAIChatStreamUsageOption 是否可能改写该 body。
 * 保守判断（不检查 stream_options 细节），供 forwarder 的 scan-first 透传
 * 作为守卫条件使用；误报只会回退到重建路径，不改变行为。
 */
export function mayInjectOpenAIChatStreamUsage(
  providerType: string | null | undefined,
  requestPath: string,
  body: Record<string, unknown>
): boolean {
  if (!OPENAI_COMPATIBLE_PROVIDER_TYPES.has(providerType ?? "")) {
    return false;
  }
  if (requestPath !== "/v1/chat/completions") {
    return false;
  }
  return body.stream === true;
}

export function ensureOpenAIChatStreamUsageOption(
  body: Record<string, unknown>,
  providerType: string | null | undefined,
  requestPath: string
): boolean {
  if (!OPENAI_COMPATIBLE_PROVIDER_TYPES.has(providerType ?? "")) {
    return false;
  }

  if (requestPath !== "/v1/chat/completions" || body.stream !== true) {
    return false;
  }

  const streamOptions = body.stream_options;
  if (streamOptions == null) {
    body.stream_options = { include_usage: true };
    return true;
  }

  if (typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    return false;
  }

  const streamOptionsRecord = streamOptions as Record<string, unknown>;
  if (streamOptionsRecord.include_usage === true) {
    return false;
  }

  body.stream_options = {
    ...streamOptionsRecord,
    include_usage: true,
  };
  return true;
}
