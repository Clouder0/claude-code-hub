import { describe, expect, test } from "vitest";
import { scanJsonRequestBody } from "@/app/v1/_lib/proxy/body-scanner";
import { composeBody } from "@/app/v1/_lib/proxy/body-composer";
import { mulberry32, randomCodexBody, serializeValueForFuzz } from "./fast-body-fuzz";

/**
 * 下划线删除编辑差分对拍：oracle = filterPrivateParameters（forwarder.ts 的
 * 生产语义镜像）。不变量：
 *  D-合法  删除后产物恒为合法 JSON（parse 不抛）
 *  D-等价  parse(原始字节 − 删除区间) ≡ filterPrivateParameters(parse(原文))
 *  D-截断  游程数超上限 → truncated=true（调用方降解，不用区间）
 */

/** 生产 filterPrivateParameters 的判定镜像（forwarder.ts:594-627）。 */
function filterPrivateRef(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => filterPrivateRef(item));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("_")) continue;
    out[key] = filterPrivateRef(child);
  }
  return out;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function composedWithoutPrivate(text: string): string {
  const bytes = encode(text);
  const scan = scanJsonRequestBody(bytes);
  expect(scan.ok, `scan ok (${scan.anomaly})`).toBe(true);
  if (!scan.ok) throw new Error("unreachable");
  expect(scan.facts.underscoreDeletionsTruncated, "not truncated").toBe(false);
  const edits = scan.facts.underscoreDeletionRanges.map((r) => ({
    start: r.start,
    end: r.end,
    replacement: new Uint8Array(0),
  }));
  return new TextDecoder().decode(composeBody(bytes, edits));
}

function assertDeletionParity(text: string, context: string): void {
  const composed = composedWithoutPrivate(text);
  // oracle 在编码后的字节域取树（lone surrogate 经 TextEncoder 折算 U+FFFD），
  // 与合成产物同域比较。
  const expected = filterPrivateRef(JSON.parse(new TextDecoder().decode(encode(text))));
  const actual = JSON.parse(composed);
  expect(actual, `${context}: filtered parity`).toEqual(expected);
}

describe("underscore deletion edits (run-coalesced member removal)", () => {
  test("comma matrix: curated member positions", () => {
    const cases: Array<[string, string]> = [
      ['{"_a":1,"b":2}', "first member with successor"],
      ['{"b":2,"_a":1}', "last member with predecessor"],
      ['{"b":2,"_a":1,"c":3}', "middle member"],
      ['{"_a":1}', "sole member"],
      ['{"_a":1,"_b":2,"c":3}', "adjacent run at head"],
      ['{"x":0,"_a":1,"_b":2}', "adjacent run at tail"],
      ['{"x":0,"_a":1,"_b":2,"c":3}', "adjacent run in middle"],
      ['{"_a":1,"_b":2}', "run covers whole object"],
      ['{ "_a" : 1 , "b" : 2 }', "whitespace heavy"],
      ['{"b":1\n, "_a":[1,2]\n, "c":3}', "multiline whitespace"],
      ['{"x":{"_i":1},"_a":{"_y":2},"z":3}', "nested subsumption"],
      ['{"arr":[{"_a":1},{"b":2,"_c":3}]}', "objects inside array"],
      ['{"_a":1,"_a":2,"b":3}', "duplicate underscore keys"],
      ['{"b":1,"_a":"x,y","c":3}', "comma inside string value"],
      ['{"b":1,"_a":{"q":{"_deep":9}}}', "deeply nested run in value"],
      ['{"_":1,"b":2}', "bare underscore key"],
      ['{"_a":[1,{"_inner":2}],"b":3}', "run value containing nested object"],
      ['{"a":1,"_x":{"p":1},"_y":2,"b":{"_z":3}}', "multiple runs across levels"],
    ];
    for (const [text, name] of cases) {
      assertDeletionParity(text, name);
    }
  });

  test("underscore in values (not keys) is untouched and produces no ranges", () => {
    const text = '{"b":["x_y","_z"],"c":{"d":"_leading"},"_e":1}';
    const bytes = encode(text);
    const scan = scanJsonRequestBody(bytes);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.facts.hasUnderscoreKeys).toBe(true);
    expect(scan.facts.underscoreKeyNames).toEqual(["_e"]);
    const edits = scan.facts.underscoreDeletionRanges.map((r) => ({
      start: r.start,
      end: r.end,
      replacement: new Uint8Array(0),
    }));
    const composed = new TextDecoder().decode(composeBody(bytes, edits));
    expect(JSON.parse(composed)).toEqual({ b: ["x_y", "_z"], c: { d: "_leading" } });
  });

  test("fuzz: random bodies with injected underscore keys at random depths", () => {
    const rng = mulberry32(20260904);
    let withUnderscore = 0;
    for (let iteration = 0; iteration < 800; iteration++) {
      const body = randomCodexBody(rng);
      const injection = Math.floor(rng() * 4);
      if (injection === 0) body._internal = { a: 1 };
      else if (injection === 1) {
        (body.input as unknown[]).push({ type: "message", content: "x", _secret: 1 });
        (body.input as unknown[]).push({ type: "message", content: "y", _extra: [1, 2] });
      } else if (injection === 2) {
        body.tools = [{ type: "function", name: "f", parameters: { type: "object", _priv: true } }];
      } else {
        // 相邻游程：模拟 __schema 类客户端
        const schemaHolder: Record<string, unknown> = {};
        for (let k = 0; k < 6; k++) schemaHolder[`__schema${k}`] = { type: "object" };
        (body.input as unknown[]).push({ type: "message", content: "s", ...schemaHolder });
      }
      if (injection < 3) withUnderscore += 1;
      const text = serializeValueForFuzz(body, rng);
      assertDeletionParity(text, `iter=${iteration}`);
    }
    expect(withUnderscore).toBeGreaterThan(500);
  });

  test("truncation: beyond the run cap flags truncated", () => {
    const items: unknown[] = [];
    for (let k = 0; k < 200; k++) {
      items.push({ _k: k, v: k }); // 每对象一条游程 → 200 条 > 128
    }
    const text = JSON.stringify({ model: "m", stream: true, input: items });
    const scan = scanJsonRequestBody(encode(text));
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.facts.hasUnderscoreKeys).toBe(true);
    expect(scan.facts.underscoreDeletionsTruncated).toBe(true);
  });

  test("composed deletions stay valid JSON when combined with insert-at-1 + model replace", () => {
    // __schema 游程为顶层首成员：pck 插入 [1,1) 与删除 [1,X) 同起点——排序 tiebreak 生效。
    const schemaTail: Record<string, unknown> = {};
    for (let k = 0; k < 5; k++) schemaTail[`__schema${k}`] = { type: "object" };
    const body = {
      ...schemaTail,
      model: "gpt-5.2-codex",
      stream: true,
      input: [{ type: "message", role: "user", content: "hi" }],
    };
    const text = JSON.stringify(body);
    const bytes = encode(text);
    const scan = scanJsonRequestBody(bytes);
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;

    const edits = [
      { start: 1, end: 1, replacement: new TextEncoder().encode('"prompt_cache_key":"sid-1",') },
      {
        start: scan.fields.model!.start,
        end: scan.fields.model!.end,
        replacement: new TextEncoder().encode('"gpt-5.3-codex"'),
      },
      ...scan.facts.underscoreDeletionRanges.map((r) => ({
        start: r.start,
        end: r.end,
        replacement: new Uint8Array(0),
      })),
    ].sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start));
    const composed = new TextDecoder().decode(composeBody(bytes, edits));
    const parsed = JSON.parse(composed) as Record<string, unknown>;
    // 语义 = filterPrivate(原树) + pck + model 改写。
    const oracle = filterPrivateRef(JSON.parse(text)) as Record<string, unknown>;
    oracle.prompt_cache_key = "sid-1";
    oracle.model = "gpt-5.3-codex";
    expect(parsed).toEqual(oracle);
  });
});
