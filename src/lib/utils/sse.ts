import type { ParsedSSEEvent } from "@/types/message";

export type { ParsedSSEEvent };

/**
 * 解析 SSE 流数据为结构化事件数组
 */
export function parseSSEData(sseText: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = [];

  let eventName = "";
  let dataLines: string[] = [];

  const flushEvent = () => {
    // 修改：支持没有 event: 前缀的纯 data: 格式（Gemini 流式响应）
    // 如果没有 eventName，使用默认值 "message"
    if (dataLines.length === 0) {
      eventName = "";
      dataLines = [];
      return;
    }

    const dataStr = dataLines.join("\n");

    try {
      const data = JSON.parse(dataStr);
      events.push({ event: eventName || "message", data });
    } catch {
      events.push({ event: eventName || "message", data: dataStr });
    }

    eventName = "";
    dataLines = [];
  };

  const lines = sseText.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line) {
      flushEvent();
      continue;
    }

    if (line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.substring(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      let value = line.substring(5);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      dataLines.push(value);
    }
  }

  flushEvent();

  return events;
}

/**
 * 流式 finalization 消费者（策略封锁信号（cyber/bio）/ usage / service_tier /
 * prompt_cache_key）读取的每个字段都位于以下字面 JSON key 之下，因此 data 文本
 * 不含任何标记子串的事件不可能贡献结果，可安全跳过 JSON.parse（保留原始字符串
 * data；消费者对 string data 本就有 `typeof !== "object"` 跳过逻辑）。
 *
 * 已知边界（预存在，非本函数引入）：判定基于原始文本的 ASCII 子串，若上游用
 * \u 转义书写标记文本（如 "cyber_\u0070olicy"），门控不会命中、事件保持未解析。
 * 修复需要先解码再判定，等于恢复被本优化省掉的成本，故记录而不修。
 */
const SSE_FINALIZATION_MARKERS = [
  "usage",
  "service_tier",
  "prompt_cache_key",
  "cyber_policy",
  "bio_policy",
  "safety_buffering",
] as const;

/**
 * parseSSEData 的 finalization 变体：只保留 data 文本命中标记子串的事件
 * （并对其做 JSON.parse），其余事件（占字节大头的文本增量）不进入结果——
 * 四个 finalization 消费者（cyber 信号 / usage / service_tier / prompt_cache_key）
 * 对 string data 本就有 `typeof !== "object"` 跳过逻辑，跳过与丢弃等价，
 * 但丢弃后事件数组不再随响应体大小线性驻留内存。
 * 用于把流结束时对 allContent 的多次独立全量解析合并为一次共享解析。
 *
 * 注意：detectUpstreamErrorFromSseOrJsonText（假 200 检测）需要全部事件的对象 data，
 * 不得消费本函数的结果。
 */
export function parseSSEDataForFinalization(sseText: string): ParsedSSEEvent[] {
  const events: ParsedSSEEvent[] = [];

  let eventName = "";
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) {
      eventName = "";
      dataLines = [];
      return;
    }

    const dataStr = dataLines.join("\n");

    if (SSE_FINALIZATION_MARKERS.some((marker) => dataStr.includes(marker))) {
      try {
        events.push({ event: eventName || "message", data: JSON.parse(dataStr) });
      } catch {
        // 与 parseSSEData 保持一致：解析失败保留原始字符串。
        events.push({ event: eventName || "message", data: dataStr });
      }
    }

    eventName = "";
    dataLines = [];
  };

  const lines = sseText.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line) {
      flushEvent();
      continue;
    }

    if (line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.substring(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      let value = line.substring(5);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
      dataLines.push(value);
    }
  }

  flushEvent();

  return events;
}

/**
 * 严格检测文本是否“看起来像” SSE。
 *
 * 只认行首的 `event:` / `data:`（或前置注释行 `:`），避免 JSON 里包含 "data:" 误判。
 */
export function isSSEText(text: string): boolean {
  let start = 0;

  for (let i = 0; i <= text.length; i += 1) {
    if (i !== text.length && text.charCodeAt(i) !== 10) continue; // '\n'

    const line = text.slice(start, i).trim();
    start = i + 1;

    if (!line) continue;
    if (line.startsWith(":")) continue;

    return line.startsWith("event:") || line.startsWith("data:");
  }

  return false;
}

/**
 * 用于 UI 展示的 SSE 解析（在 parseSSEData 基础上做轻量清洗）。
 */
export function parseSSEDataForDisplay(sseText: string): ParsedSSEEvent[] {
  return parseSSEData(sseText).filter((evt) => {
    if (typeof evt.data !== "string") return true;
    return evt.data.trim() !== "[DONE]";
  });
}
