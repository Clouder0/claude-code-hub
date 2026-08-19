import { type ParsedSSEEvent, parseSSEData } from "@/lib/utils/sse";

export const CYBER_SECURITY_EVENT_TYPES = ["cyber_policy", "cyber_safety_check"] as const;

export type CyberSecurityEventType = (typeof CYBER_SECURITY_EVENT_TYPES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCyberPolicyCode(value: unknown): boolean {
  return isRecord(value) && value.code === "cyber_policy";
}

function hasCyberSafetyBuffering(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const buffering = value.safety_buffering;
  if (!isRecord(buffering) || !Array.isArray(buffering.use_cases)) return false;
  return buffering.use_cases.some((useCase) => useCase === "cyber");
}

export function detectCyberSecuritySignals(
  value: unknown,
  eventName?: string
): CyberSecurityEventType[] {
  if (!isRecord(value)) return [];

  const signals = new Set<CyberSecurityEventType>();
  if (hasCyberPolicyCode(value.error)) {
    signals.add("cyber_policy");
  }

  const response = isRecord(value.response) ? value.response : null;
  if (
    (value.type === "response.failed" || eventName === "response.failed") &&
    hasCyberPolicyCode(response?.error)
  ) {
    signals.add("cyber_policy");
  }

  if (hasCyberSafetyBuffering(value)) {
    signals.add("cyber_safety_check");
  }

  return [...signals];
}

function parseTopLevelJson(text: string): unknown {
  let trimmed = text.trim();
  if (trimmed.charCodeAt(0) === 0xfeff) {
    trimmed = trimmed.slice(1).trimStart();
  }
  if (!trimmed.startsWith("{")) return null;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/**
 * 从响应体文本检测 cyber 信号。
 *
 * `preparsedEvents`：流式 finalization 路径已用 parseSSEDataForFinalization 解析过的
 * 共享事件（string data 事件已被证明不可能携带信号，跳过是安全的）；不传则内部全量
 * 解析，行为与历史版本一致。
 */
export function detectCyberSecuritySignalsFromText(
  text: string,
  preparsedEvents?: ParsedSSEEvent[]
): CyberSecurityEventType[] {
  const signals = new Set<CyberSecurityEventType>();
  const topLevel = parseTopLevelJson(text);
  for (const signal of detectCyberSecuritySignals(topLevel)) {
    signals.add(signal);
  }

  const events = preparsedEvents ?? parseSSEData(text);
  for (const event of events) {
    for (const signal of detectCyberSecuritySignals(event.data, event.event)) {
      signals.add(signal);
    }
  }

  return [...signals];
}

export function containsCyberPolicySignal(value: unknown): boolean {
  return detectCyberSecuritySignals(value).includes("cyber_policy");
}

export function containsCyberPolicySignalInText(text: string): boolean {
  return detectCyberSecuritySignalsFromText(text).includes("cyber_policy");
}
