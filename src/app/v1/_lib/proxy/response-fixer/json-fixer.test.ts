import { describe, expect, test } from "vitest";

import { hasRepairableArtifacts, JsonFixer } from "./json-fixer";

function decodeUtf8(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

function makeCountingFixer(): { fixer: JsonFixer; parseCount: () => number } {
  let count = 0;
  const fixer = new JsonFixer({
    maxDepth: 200,
    maxSize: 1024 * 1024,
    onJsonParse: () => {
      count += 1;
    },
  });
  return { fixer, parseCount: () => count };
}

describe("JsonFixer", () => {
  test("有效 JSON 应原样通过（不标记 applied）", () => {
    const input = new TextEncoder().encode('{"a":1}');
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });

    const res = fixer.fix(input);

    expect(res.applied).toBe(false);
    expect(Array.from(res.data)).toEqual(Array.from(input));
  });

  test("结构完整的 data 行应跳过 JSON.parse（快速路径零解析）", () => {
    const { fixer, parseCount } = makeCountingFixer();
    const inputs = [
      '{"type":"response.output_text.delta","delta":"hello"}',
      '{"a":[1,2,{"b":"c,"}]}',
      '{"text":"含逗号, 与冒号: 的字符串"}',
      "[DONE]",
      '{"nested":{"deep":{"deeper":[true,false,null]}}}',
      '{ "spaced" : { "around" : 1 } }',
    ];

    for (const text of inputs) {
      const input = new TextEncoder().encode(text);
      const res = fixer.fix(input);
      expect(res.applied).toBe(false);
      expect(decodeUtf8(res.data)).toBe(text);
    }

    expect(parseCount()).toBe(0);
  });

  test("带可修复痕迹的行应走完整解析路径", () => {
    const { fixer, parseCount } = makeCountingFixer();
    const inputs = [
      '{"a":1,}', // 闭合符前尾逗号
      '{"key":"val', // 未闭合字符串
      "[1, 2", // 未闭合数组
      '{"key":', // 冒号后无值
      '{"a":1}}', // 多余闭合符
    ];

    for (const text of inputs) {
      fixer.fix(new TextEncoder().encode(text));
    }

    expect(parseCount()).toBeGreaterThan(0);
  });

  test("结构完整但内容非法的 JSON 应保持原样（与慢路径输出等价）", () => {
    const { fixer, parseCount } = makeCountingFixer();
    const inputs = ['{"a":bad}', '{"a":"\\x"}', '{"a":01}'];

    for (const text of inputs) {
      const input = new TextEncoder().encode(text);
      const res = fixer.fix(input);
      expect(res.applied).toBe(false);
      expect(decodeUtf8(res.data)).toBe(text);
    }

    expect(parseCount()).toBe(0);
  });

  test("悬空转义与空白间隔的尾逗号应被修复", () => {
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });

    const danglingEscape = fixer.fix(new TextEncoder().encode('{"a":"val\\'));
    expect(() => JSON.parse(decodeUtf8(danglingEscape.data))).not.toThrow();

    const spacedComma = fixer.fix(new TextEncoder().encode('{"a":1 ,  }'));
    expect(() => JSON.parse(decodeUtf8(spacedComma.data))).not.toThrow();
  });

  test("hasRepairableArtifacts 的扫描边界", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(hasRepairableArtifacts(enc('{"a":1}'), 200)).toBe(false);
    expect(hasRepairableArtifacts(enc('{"a":"}"}'), 200)).toBe(false); // 闭合符在字符串内
    expect(hasRepairableArtifacts(enc('{"a":"\\""}'), 200)).toBe(false); // 转义的引号
    expect(hasRepairableArtifacts(enc('{"a":1} '), 200)).toBe(false); // 尾部空白
    expect(hasRepairableArtifacts(enc('{"a":1,}'), 200)).toBe(true);
    expect(hasRepairableArtifacts(enc('{"a":1 ,}'), 200)).toBe(true);
    expect(hasRepairableArtifacts(enc('{"a":1'), 200)).toBe(true);
    expect(hasRepairableArtifacts(enc('{"a":1,'), 200)).toBe(true);
    expect(hasRepairableArtifacts(enc('{"a":'), 200)).toBe(true);
    expect(hasRepairableArtifacts(enc('{"a":"x\\'), 200)).toBe(true);
    expect(hasRepairableArtifacts(enc('{"a":1}}'), 200)).toBe(true);
    expect(hasRepairableArtifacts(enc("[1,]{"), 200)).toBe(true); // 失配闭合符 + 未闭合
    expect(hasRepairableArtifacts(enc('{"a":{"b":1}}'), 1)).toBe(true); // 深度超限（保守走慢路径）
  });

  test("未闭合对象应被补齐括号", () => {
    const input = new TextEncoder().encode('{"key":"value"');
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });

    const res = fixer.fix(input);
    expect(() => JSON.parse(decodeUtf8(res.data))).not.toThrow();
  });

  test("未闭合数组应被补齐括号", () => {
    const input = new TextEncoder().encode("[1, 2, 3");
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });

    const res = fixer.fix(input);
    expect(() => JSON.parse(decodeUtf8(res.data))).not.toThrow();
  });

  test("未闭合字符串应被补齐引号", () => {
    const input = new TextEncoder().encode('{"key":"val');
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });

    const res = fixer.fix(input);
    expect(() => JSON.parse(decodeUtf8(res.data))).not.toThrow();
  });

  test("对象/数组尾随逗号应被移除", () => {
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });
    const inputs = ['{"a": 1,}', "[1, 2,]"];

    for (const text of inputs) {
      const res = fixer.fix(new TextEncoder().encode(text));
      expect(() => JSON.parse(decodeUtf8(res.data))).not.toThrow();
    }
  });

  test("冒号后缺失值应补 null", () => {
    const input = new TextEncoder().encode('{"key":');
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });

    const res = fixer.fix(input);
    expect(JSON.parse(decodeUtf8(res.data))).toEqual({ key: null });
  });

  test("嵌套未闭合结构应被补齐", () => {
    const input = new TextEncoder().encode('{"outer": {"inner": [1, 2');
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 1024 * 1024 });

    const res = fixer.fix(input);
    expect(() => JSON.parse(decodeUtf8(res.data))).not.toThrow();
  });

  test("超过最大深度应保持原样（保护性降级）", () => {
    const input = new TextEncoder().encode('{"a":{"b":{"c":{"d":');
    const fixer = new JsonFixer({ maxDepth: 3, maxSize: 1024 * 1024 });

    const res = fixer.fix(input);
    expect(res.applied).toBe(false);
    expect(decodeUtf8(res.data)).toBe(decodeUtf8(input));
  });

  test("超过最大大小应保持原样（保护性降级）", () => {
    const input = new TextEncoder().encode('{"key":"very long value"}');
    const fixer = new JsonFixer({ maxDepth: 200, maxSize: 10 });

    const res = fixer.fix(input);
    expect(res.applied).toBe(false);
    expect(decodeUtf8(res.data)).toBe(decodeUtf8(input));
  });
});
