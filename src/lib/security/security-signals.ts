import { type ParsedSSEEvent, parseSSEData } from "@/lib/utils/sse";

// 结构化上游安全信号的闭合类型：确认的策略拒绝（cyber/bio）+ cyber 附加检查。
// 不识别 bio 的 safety_buffering 变体（暂无协议证据，观察到后再扩展）。
export const SECURITY_EVENT_TYPES = ["cyber_policy", "cyber_safety_check", "bio_policy"] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

// 确认的上游策略拒绝：请求级结果，绝非供应商健康问题。
// 数组顺序即优先级：多处取"第一个命中"时 cyber 在前，保证既有 cyber 行为不变。
export const POLICY_REJECTION_CODES = ["cyber_policy", "bio_policy"] as const;

export type PolicyRejectionCode = (typeof POLICY_REJECTION_CODES)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasPolicyRejectionCode(value: unknown, code: PolicyRejectionCode): boolean {
  return isRecord(value) && value.code === code;
}

function hasCyberSafetyBuffering(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const buffering = value.safety_buffering;
  if (!isRecord(buffering) || !Array.isArray(buffering.use_cases)) return false;
  return buffering.use_cases.some((useCase) => useCase === "cyber");
}

export function detectSecuritySignals(value: unknown, eventName?: string): SecurityEventType[] {
  if (!isRecord(value)) return [];

  const signals = new Set<SecurityEventType>();
  for (const code of POLICY_REJECTION_CODES) {
    if (hasPolicyRejectionCode(value.error, code)) {
      signals.add(code);
    }
  }

  const response = isRecord(value.response) ? value.response : null;
  if (value.type === "response.failed" || eventName === "response.failed") {
    for (const code of POLICY_REJECTION_CODES) {
      if (hasPolicyRejectionCode(response?.error, code)) {
        signals.add(code);
      }
    }
  }

  if (hasCyberSafetyBuffering(value)) {
    signals.add("cyber_safety_check");
  }

  return [...signals];
}

export function isPolicyRejectionType(type: SecurityEventType): type is PolicyRejectionCode {
  return (POLICY_REJECTION_CODES as readonly string[]).includes(type);
}

/** 取第一个命中的策略码（cyber 优先）；无命中返回 null。 */
export function firstPolicyRejectionCode(signals: SecurityEventType[]): PolicyRejectionCode | null {
  for (const code of POLICY_REJECTION_CODES) {
    if (signals.includes(code)) {
      return code;
    }
  }
  return null;
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
 * 从响应体文本检测结构化安全信号。
 *
 * `preparsedEvents`：流式 finalization 路径已用 parseSSEDataForFinalization 解析过的
 * 共享事件（string data 事件已被证明不可能携带信号，跳过是安全的）；不传则内部全量
 * 解析，行为与历史版本一致。
 */
export function detectSecuritySignalsFromText(
  text: string,
  preparsedEvents?: ParsedSSEEvent[]
): SecurityEventType[] {
  const signals = new Set<SecurityEventType>();
  const topLevel = parseTopLevelJson(text);
  for (const signal of detectSecuritySignals(topLevel)) {
    signals.add(signal);
  }

  const events = preparsedEvents ?? parseSSEData(text);
  for (const event of events) {
    for (const signal of detectSecuritySignals(event.data, event.event)) {
      signals.add(signal);
    }
  }

  return [...signals];
}

export function detectPolicyRejectionCodeFromText(
  text: string,
  preparsedEvents?: ParsedSSEEvent[]
): PolicyRejectionCode | null {
  return firstPolicyRejectionCode(detectSecuritySignalsFromText(text, preparsedEvents));
}

/** 从已解析的 JSON 检测确认策略码（cyber 优先）；无命中返回 null。 */
export function detectPolicyRejectionCode(
  value: unknown,
  eventName?: string
): PolicyRejectionCode | null {
  return firstPolicyRejectionCode(detectSecuritySignals(value, eventName));
}

export function containsPolicyRejection(value: unknown): boolean {
  return detectPolicyRejectionCode(value) !== null;
}

export function containsPolicyRejectionInText(text: string): boolean {
  return detectPolicyRejectionCodeFromText(text) !== null;
}
