import { describe, expect, test } from "vitest";
import {
  buildModelRedirectEdit,
  buildPromptCacheKeyEdit,
  composeBody,
} from "@/app/v1/_lib/proxy/body-composer";
import { scanJsonRequestBody } from "@/app/v1/_lib/proxy/body-scanner";
import { mulberry32, randomCodexBody, serializeValueForFuzz } from "./fast-body-fuzz";

/**
 * 编辑表合成器不变量：
 *  C1 无编辑 → 输出即通货本体（同引用，逐字节不变）
 *  C2 model 重定向后 JSON.parse(composed) ≡ {...parsed, model: redirected}（语义 parity；
 *     字节级与 legacy stringify 允许格式差异——上游只解析 JSON）
 *  C3 prompt_cache_key 插入/替换后语义 parity，且其余字节原样保留
 *  C4 多编辑（pck 插入 + model 替换）组合正确
 *  C5 编辑表越界/重叠 → 抛错（编程错误，非路由结果）
 */

const encoder = new TextEncoder();

function scan(text: string) {
  const bytes = encoder.encode(text);
  const result = scanJsonRequestBody(bytes);
  expect(result.ok).toBe(true);
  return result;
}

describe("body-composer edit-list composition", () => {
  test("C1: no edits returns the currency itself", () => {
    const bytes = encoder.encode('{"model":"a","input":[]}');
    expect(composeBody(bytes, [])).toBe(bytes);
  });

  test("C2: model redirect splice parity", () => {
    const text =
      ' { "model" : "gpt-5.2-codex" , "stream":true, "input":[{"type":"message","content":"hi"}] } ';
    const result = scan(text);
    const edit = buildModelRedirectEdit(result, "gpt-5.3-codex");
    const composed = composeBody(result.bytes, [edit]);
    const parsed = JSON.parse(new TextDecoder().decode(composed)) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.stream).toBe(true);
    expect(parsed.input).toEqual([{ type: "message", content: "hi" }]);
    // 原始字节在编辑区之外逐字节保留。
    const decoded = new TextDecoder().decode(composed);
    expect(decoded).toContain('"stream":true');
    expect(decoded).toContain('"content":"hi"');
  });

  test("C3: prompt_cache_key insert parity", () => {
    const text = '{"model":"gpt-5.2-codex","input":[{"type":"message","content":"x"}]}';
    const result = scan(text);
    expect(result.fields.prompt_cache_key).toBeUndefined();
    const edit = buildPromptCacheKeyEdit(result, "11111111-2222-4333-8444-555555555555");
    const composed = composeBody(result.bytes, [edit]);
    const parsed = JSON.parse(new TextDecoder().decode(composed)) as Record<string, unknown>;
    expect(parsed.prompt_cache_key).toBe("11111111-2222-4333-8444-555555555555");
    expect(parsed.model).toBe("gpt-5.2-codex");
    expect(parsed.input).toEqual([{ type: "message", content: "x" }]);
  });

  test("C3b: prompt_cache_key replace parity", () => {
    const text = '{"model":"a","prompt_cache_key":"invalid-value","input":[]}';
    const result = scan(text);
    expect(result.fields.prompt_cache_key?.value).toBe("invalid-value");
    const edit = buildPromptCacheKeyEdit(result, "11111111-2222-4333-8444-555555555555");
    const composed = composeBody(result.bytes, [edit]);
    const parsed = JSON.parse(new TextDecoder().decode(composed)) as Record<string, unknown>;
    expect(parsed.prompt_cache_key).toBe("11111111-2222-4333-8444-555555555555");
    expect(parsed.model).toBe("a");
  });

  test("C4: combined edits (insert at anchor + model replace) stay sorted and valid", () => {
    const text = '{"model":"gpt-5.2-codex","stream":false,"input":[]}';
    const result = scan(text);
    const edits = [
      buildPromptCacheKeyEdit(result, "11111111-2222-4333-8444-555555555555"),
      buildModelRedirectEdit(result, "gpt-5.3-codex"),
    ].sort((a, b) => a.start - b.start);
    const composed = composeBody(result.bytes, edits);
    const parsed = JSON.parse(new TextDecoder().decode(composed)) as Record<string, unknown>;
    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.prompt_cache_key).toBe("11111111-2222-4333-8444-555555555555");
    expect(parsed.stream).toBe(false);
  });

  test("C5: overlapping and out-of-bounds edits throw", () => {
    const bytes = encoder.encode('{"model":"a","input":[]}');
    expect(() =>
      composeBody(bytes, [
        { start: 1, end: 10, replacement: encoder.encode("x") },
        { start: 5, end: 12, replacement: encoder.encode("y") },
      ])
    ).toThrow(/overlapping/);
    expect(() =>
      composeBody(bytes, [{ start: 1, end: 999, replacement: encoder.encode("x") }])
    ).toThrow(/out of bounds/);
  });

  test("fuzz: random bodies × model redirect × pck insert compose to semantic parity", () => {
    const rng = mulberry32(20260903 + 99);
    const redirected = "gpt-5.3-codex";
    const sessionId = "11111111-2222-4333-8444-555555555555";
    for (let iteration = 0; iteration < 800; iteration++) {
      const body = randomCodexBody(rng);
      body.model = "gpt-5.2-codex"; // 重定向前提：model 存在且为字符串
      const text = serializeValueForFuzz(body, rng);
      const bytes = encoder.encode(text);
      const scanResult = scanJsonRequestBody(bytes);
      expect(scanResult.ok, `iter=${iteration}`).toBe(true);
      if (!scanResult.ok) continue;
      const edits = [
        buildPromptCacheKeyEdit(scanResult, sessionId),
        buildModelRedirectEdit(scanResult, redirected),
      ].sort((a, b) => a.start - b.start);
      const composed = composeBody(bytes, edits);
      const parsed = JSON.parse(new TextDecoder().decode(composed)) as Record<string, unknown>;
      // oracle 从编码后的字节解析：lone surrogate 经 TextEncoder 已折算 U+FFFD，
      // 两边必须在同一编码域内比较（这是 encodeBody 的既成语义，非合成器行为）。
      const oracleBody = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      expect(parsed.model, `iter=${iteration} model`).toBe(redirected);
      expect(parsed.prompt_cache_key, `iter=${iteration} pck`).toBe(sessionId);
      // 其余字段语义不变。
      for (const [key, value] of Object.entries(oracleBody)) {
        if (key === "model" || key === "prompt_cache_key") continue;
        expect(parsed[key], `iter=${iteration} key=${key}`).toEqual(value);
      }
      for (const key of Object.keys(parsed)) {
        if (key === "model" || key === "prompt_cache_key") continue;
        expect(oracleBody[key], `iter=${iteration} extra key=${key}`).toBeDefined();
      }
    }
  });
});
