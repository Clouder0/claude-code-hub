import { describe, expect, test } from "vitest";
import { detectCyberSecuritySignalsFromText } from "@/lib/security/cyber-security-signals";
import { isSSEText, parseSSEData, parseSSEDataForFinalization } from "@/lib/utils/sse";
import {
  parseServiceTierFromResponseText,
  parseUsageFromResponseText,
} from "@/app/v1/_lib/proxy/response-handler";

function buildSse(events: Array<{ event: string; data: unknown }>): string {
  return events
    .flatMap(({ event, data }) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, ""])
    .join("\n");
}

function buildDataOnlySse(datas: unknown[]): string {
  return datas.flatMap((data) => [`data: ${JSON.stringify(data)}`, ""]).join("\n");
}

// ---------- Fixture 语料：覆盖 finalization 消费者遇到的真实事件形态 ----------

const codexNormal = buildSse([
  {
    event: "response.created",
    data: {
      type: "response.created",
      response: {
        model: "gpt-5.6-codex",
        usage: null,
        service_tier: "default",
        prompt_cache_key: "sess-abc",
      },
    },
  },
  {
    event: "response.output_text.delta",
    data: { type: "response.output_text.delta", delta: "hello world" },
  },
  {
    event: "response.output_text.delta",
    data: { type: "response.output_text.delta", delta: "more tokens" },
  },
  {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: {
        model: "gpt-5.6-codex",
        usage: { input_tokens: 1200, output_tokens: 34 },
        service_tier: "priority",
        prompt_cache_key: "sess-abc",
      },
    },
  },
]);

const codexFailedCyber = buildSse([
  {
    event: "response.created",
    data: { type: "response.created", response: { model: "gpt-5.6-codex", usage: null } },
  },
  {
    event: "response.failed",
    data: {
      type: "response.failed",
      response: { error: { code: "cyber_policy", message: "blocked" } },
    },
  },
]);

const codexSafetyBuffering = buildSse([
  {
    event: "response.safety_buffering",
    data: { type: "response.safety_buffering", safety_buffering: { use_cases: ["cyber"] } },
  },
  {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: { usage: { input_tokens: 10, output_tokens: 2 } },
    },
  },
]);

const openaiChatStream = [
  'data: {"choices":[{"delta":{"content":"part 1"}}]}',
  "",
  'data: {"choices":[{"delta":{"content":"part 2"}}]}',
  "",
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const anthropicStream = buildSse([
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        usage: { input_tokens: 12, cache_read_input_tokens: 171876, output_tokens: 1 },
      },
    },
  },
  { event: "content_block_delta", data: { type: "content_block_delta", delta: { text: "body" } } },
  {
    event: "message_delta",
    data: { type: "message_delta", usage: { input_tokens: 12, output_tokens: 40 } },
  },
  { event: "message_stop", data: { type: "message_stop" } },
]);

const geminiSse = buildDataOnlySse([
  { candidates: [{ content: { parts: [{ text: "hi" }] } }] },
  {
    candidates: [],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  },
]);

// 对抗样本：增量文本里包含 marker 字面词与 error 字样，门控会多解析但结论不得改变。
const adversarialText = buildSse([
  {
    event: "response.output_text.delta",
    data: {
      type: "response.output_text.delta",
      delta: 'the word usage appears here, and "error": true looks like JSON but is string content',
    },
  },
  {
    event: "response.completed",
    data: {
      type: "response.completed",
      response: { usage: { input_tokens: 3, output_tokens: 4 }, service_tier: "standard" },
    },
  },
]);

// 多行 data：JSON 被拆到多个 data: 行（W3C 合并语义）。
const multiLineDataEvent = [
  "event: response.completed",
  "data: {",
  'data:   "response": {',
  'data:     "usage": { "input_tokens": 9, "output_tokens": 8 }',
  "data:   }",
  "data: }",
  "",
].join("\n");

// 纯文本增量（无任何 marker）：门控应跳过 JSON.parse。
const plainDeltas = buildSse([
  {
    event: "response.output_text.delta",
    data: { type: "response.output_text.delta", delta: "plain text one" },
  },
  {
    event: "response.output_text.delta",
    data: { type: "response.output_text.delta", delta: "plain text two" },
  },
]);

const nonSseJsonBody = JSON.stringify({
  model: "gpt-5.6-codex",
  usage: { input_tokens: 5, output_tokens: 6 },
  service_tier: "auto",
});

const sseFixtures: Array<[string, string]> = [
  ["codex normal completion", codexNormal],
  ["codex response.failed cyber_policy", codexFailedCyber],
  ["codex safety_buffering", codexSafetyBuffering],
  ["openai chat completions stream", openaiChatStream],
  ["anthropic messages stream", anthropicStream],
  ["gemini sse", geminiSse],
  ["adversarial marker words in text", adversarialText],
  ["multi-line data event", multiLineDataEvent],
  ["plain deltas only", plainDeltas],
];

// ---------- 等价性：共享事件路径与旧全量路径逐字段一致 ----------

describe("stream finalization shared events parity", () => {
  test.each(sseFixtures)("usage parity (codex): %s", (_name, text) => {
    const events = parseSSEDataForFinalization(text);
    expect(parseUsageFromResponseText(text, "codex", events)).toEqual(
      parseUsageFromResponseText(text, "codex")
    );
  });

  test.each(sseFixtures)("usage parity (openai-compatible): %s", (_name, text) => {
    const events = parseSSEDataForFinalization(text);
    expect(parseUsageFromResponseText(text, "openai-compatible", events)).toEqual(
      parseUsageFromResponseText(text, "openai-compatible")
    );
  });

  test.each(sseFixtures)("usage parity (claude): %s", (_name, text) => {
    const events = parseSSEDataForFinalization(text);
    expect(parseUsageFromResponseText(text, "claude", events)).toEqual(
      parseUsageFromResponseText(text, "claude")
    );
  });

  test.each(sseFixtures)("usage parity (gemini): %s", (_name, text) => {
    const events = parseSSEDataForFinalization(text);
    expect(parseUsageFromResponseText(text, "gemini", events)).toEqual(
      parseUsageFromResponseText(text, "gemini")
    );
  });

  test.each(sseFixtures)("service tier parity: %s", (_name, text) => {
    const events = parseSSEDataForFinalization(text);
    expect(parseServiceTierFromResponseText(text, events)).toBe(
      parseServiceTierFromResponseText(text)
    );
  });

  test.each(sseFixtures)("cyber signals parity: %s", (_name, text) => {
    const events = parseSSEDataForFinalization(text);
    expect(detectCyberSecuritySignalsFromText(text, events)).toEqual(
      detectCyberSecuritySignalsFromText(text)
    );
  });

  test("expected values are actually extracted (guards against vacuous parity)", () => {
    const codexUsage = parseUsageFromResponseText(
      codexNormal,
      "codex",
      parseSSEDataForFinalization(codexNormal)
    );
    expect(codexUsage.usageMetrics?.input_tokens).toBe(1200);
    expect(codexUsage.usageMetrics?.output_tokens).toBe(34);
    expect(
      parseServiceTierFromResponseText(codexNormal, parseSSEDataForFinalization(codexNormal))
    ).toBe("priority");
    expect(
      detectCyberSecuritySignalsFromText(
        codexFailedCyber,
        parseSSEDataForFinalization(codexFailedCyber)
      )
    ).toContain("cyber_policy");
    expect(
      detectCyberSecuritySignalsFromText(
        codexSafetyBuffering,
        parseSSEDataForFinalization(codexSafetyBuffering)
      )
    ).toContain("cyber_safety_check");
  });

  test("non-SSE JSON body keeps legacy path (events must not be passed for non-SSE text)", () => {
    expect(isSSEText(nonSseJsonBody)).toBe(false);
    expect(parseUsageFromResponseText(nonSseJsonBody, "codex")?.usageMetrics?.input_tokens).toBe(5);
    expect(parseServiceTierFromResponseText(nonSseJsonBody)).toBe("auto");
  });
});

// ---------- 门控行为：无 marker 的事件不做 JSON.parse ----------

describe("parseSSEDataForFinalization marker gating", () => {
  test("skips JSON.parse for plain delta events", () => {
    const events = parseSSEDataForFinalization(plainDeltas);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(typeof event.data).toBe("string");
    }
    // 事件名保留，消费者的事件类型判断不受影响。
    expect(events.every((e) => e.event === "response.output_text.delta")).toBe(true);
  });

  test("parses marker-carrying events, keeps multi-line joining semantics", () => {
    const events = parseSSEDataForFinalization(codexNormal);
    const created = events.find((e) => e.event === "response.created");
    const completed = events.find((e) => e.event === "response.completed");
    expect(created && typeof created.data).toBe("object");
    expect(completed && typeof completed.data).toBe("object");
    expect((completed?.data as Record<string, unknown>)?.response).toMatchObject({
      usage: { input_tokens: 1200, output_tokens: 34 },
    });

    const multiLine = parseSSEDataForFinalization(multiLineDataEvent);
    expect(multiLine[0]?.data).toMatchObject({
      response: { usage: { input_tokens: 9, output_tokens: 8 } },
    });
  });

  test("event set is index-aligned with parseSSEData (same count and names)", () => {
    for (const [_name, text] of sseFixtures) {
      const legacy = parseSSEData(text);
      const gated = parseSSEDataForFinalization(text);
      expect(gated.map((e) => e.event)).toEqual(legacy.map((e) => e.event));
    }
  });

  test("prompt_cache_key read loop works over gated events (codex session binding)", () => {
    const events = parseSSEDataForFinalization(codexNormal);
    const hit = events.find(
      (event) =>
        typeof event.data === "object" &&
        !!(event.data as Record<string, unknown>)?.response &&
        typeof (event.data as Record<string, unknown>).response === "object" &&
        typeof ((event.data as Record<string, unknown>).response as Record<string, unknown>)
          .prompt_cache_key === "string"
    );
    expect(
      hit &&
        ((hit.data as Record<string, unknown>).response as Record<string, unknown>).prompt_cache_key
    ).toBe("sess-abc");
  });
});
