import { describe, expect, test } from "vitest";
import { scanJsonRequestBody, type BodyScanResult } from "@/app/v1/_lib/proxy/body-scanner";
import {
  buildHighConcurrencyCodexRequestSummary,
  buildHighConcurrencyCodexRequestSummaryFromScan,
} from "@/app/v1/_lib/proxy/request-retention";
import { extractInitialMessageTextHash } from "@/app/v1/_lib/codex/session-completer";
import {
  mulberry32,
  mutateText,
  randomCodexBody,
  serializeValueForFuzz,
  type Rng,
} from "./fast-body-fuzz";

/**
 * body-scanner 差分对拍：oracle 一律是生产 legacy 函数（JSON.parse 树路径）。
 * 不变量：
 *  I-接受  scan.ok === true ⟹ JSON.parse 成功（无假接受）
 *  I-指纹  scan.fingerprintHash ≡ extractInitialMessageTextHash(JSON.parse(body))
 *  I-事实  input/tools/instructions/顶层键 等事实 ≡ 树路径语义
 *  I-值    受控标量解码值 ≡ JSON.parse 值
 *  I-拒绝  已知病态（重复受控键/键内转义/坏语法/坏 UTF-8）⟹ scan.ok === false
 */

const FUZZ_SEED = Number(process.env.FAST_BODY_FUZZ_SEED ?? 20260903);
const FUZZ_ITERATIONS = Number(process.env.FAST_BODY_FUZZ_ITERATIONS ?? 1500);

function encodeBody(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function walkHasUnderscoreKeys(value: unknown): boolean {
  // 镜像 forwarder.ts filterPrivateParameters 的判定：任意深度 "_" 前缀键。
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((item) => walkHasUnderscoreKeys(item));
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("_")) return true;
    if (walkHasUnderscoreKeys(child)) return true;
  }
  return false;
}

function kindOfValue(
  value: unknown
): "string" | "number" | "boolean" | "null" | "object" | "array" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value as "string" | "number" | "boolean";
}

const TRACKED_KEYS = [
  "model",
  "stream",
  "service_tier",
  "prompt_cache_key",
  "max_tokens",
  "temperature",
  "top_p",
  "reasoning_effort",
  "previous_response_id",
] as const;

/** 对单个 body 的全量差分断言。 */
function assertScanParity(text: string, context: string): BodyScanResult {
  const bytes = encodeBody(text);
  const scan = scanJsonRequestBody(bytes);
  const parsed = JSON.parse(text) as Record<string, unknown>;

  expect(scan.ok, `${context}: scan should accept a valid body`).toBe(true);
  if (!scan.ok) throw new Error("unreachable");

  // I-指纹
  const oracleHash = extractInitialMessageTextHash(parsed);
  expect(scan.fingerprintHash, `${context}: fingerprint parity`).toBe(oracleHash);

  // I-事实
  expect(scan.facts.inputIsArray, `${context}: inputIsArray`).toBe(Array.isArray(parsed.input));
  expect(scan.facts.inputItemCount, `${context}: inputItemCount`).toBe(
    Array.isArray(parsed.input) ? parsed.input.length : null
  );
  expect(scan.facts.toolCount, `${context}: toolCount`).toBe(
    Array.isArray(parsed.tools) ? parsed.tools.length : null
  );
  expect(scan.facts.hasInstructions, `${context}: hasInstructions`).toBe(
    typeof parsed.instructions === "string" && parsed.instructions.length > 0
  );
  expect(scan.facts.topLevelHasKeys, `${context}: topLevelHasKeys`).toBe(
    Object.keys(parsed).length > 0
  );
  expect(scan.facts.hasUnderscoreKeys, `${context}: hasUnderscoreKeys`).toBe(
    walkHasUnderscoreKeys(parsed)
  );

  // I-值
  for (const key of TRACKED_KEYS) {
    const field = scan.fields[key];
    const expected = parsed[key];
    if (expected === undefined) {
      expect(field, `${context}: ${key} absent`).toBeUndefined();
      continue;
    }
    expect(field, `${context}: ${key} present`).toBeDefined();
    expect(field?.kind, `${context}: ${key} kind`).toBe(kindOfValue(expected));
    if (
      field?.kind === "string" ||
      field?.kind === "number" ||
      field?.kind === "boolean" ||
      field?.kind === "null"
    ) {
      expect(field?.value, `${context}: ${key} value`).toEqual(expected);
    }
  }
  expect(scan.thinkingValue, `${context}: thinking value`).toEqual(parsed.thinking ?? null);
  expect(scan.metadataValue, `${context}: metadata value`).toEqual(parsed.metadata ?? null);

  // I-摘要（buildHighConcurrencyCodexRequestSummary 的 message 派生字段）
  const oracleSummary = JSON.parse(buildHighConcurrencyCodexRequestSummary(parsed, 0, 0)) as {
    inputItemCount: number | null;
    toolCount: number | null;
    hasInstructions: boolean;
  };
  expect(scan.facts.inputItemCount, `${context}: summary inputItemCount`).toBe(
    oracleSummary.inputItemCount
  );
  expect(scan.facts.toolCount, `${context}: summary toolCount`).toBe(oracleSummary.toolCount);
  expect(scan.facts.hasInstructions, `${context}: summary hasInstructions`).toBe(
    oracleSummary.hasInstructions
  );

  return scan;
}

describe("body-scanner differential parity (oracle = production legacy path)", () => {
  test("fuzz: random codex-shaped bodies serialize→scan→compare", () => {
    const rng = mulberry32(FUZZ_SEED);
    for (let iteration = 0; iteration < FUZZ_ITERATIONS; iteration++) {
      const body = randomCodexBody(rng);
      const text = serializeValueForFuzz(body, rng);
      // 序列化器自检：解析回去必须等价（含代理对组合语义）。
      const roundtrip = JSON.parse(text);
      expect(roundtrip).toEqual(body);
      assertScanParity(text, `seed=${FUZZ_SEED} iter=${iteration}`);
    }
  });

  test("fuzz: underscore keys at random depths are detected", () => {
    const rng = mulberry32(FUZZ_SEED + 7);
    for (let iteration = 0; iteration < 200; iteration++) {
      const body = randomCodexBody(rng);
      const injectionDepth = Math.floor(rng() * 3);
      if (injectionDepth === 0) body._internal = "x";
      else if (injectionDepth === 1) {
        (body.input as unknown[]).push({ type: "message", content: "x", _secret: 1 });
      } else {
        body.tools = [{ type: "function", name: "f", parameters: { _priv: true } }];
      }
      const text = serializeValueForFuzz(body, rng);
      const scan = scanJsonRequestBody(encodeBody(text));
      expect(scan.ok, `iter=${iteration}`).toBe(true);
      expect(scan.facts.hasUnderscoreKeys, `iter=${iteration}`).toBe(true);
    }
  });

  test("curated fingerprint edge cases", () => {
    const cases: string[] = [
      '{"input":[{"type":"message","content":"a\\nb\\tc\\"d\\\\e"}]}',
      '{"input":[{"type":"message","content":"\\u0041\\u0042\\u0043"}]}',
      '{"input":[{"type":"message","content":"\\u0020\\u0009\\n"}]}',
      '{"input":[{"type":"message","content":"\\ud83d\\ude00 emoji"}]}',
      '{"input":[{"type":"message","content":"\\ud800 lone"}]}',
      '{"input":[{"type":"message","content":"\\ud800"}]}',
      '{"input":[{"type":"message","content":"\\udc00 low first"}]}',
      '{"input":[{"type":"","content":"text-a"}]}',
      '{"input":[{"type":7,"content":"text-a"}]}',
      '{"input":[{"type":"reasoning","content":"skip-me"},{"type":"message","content":"kept"}]}',
      `{"input":[
        {"type":"message","content":"t1"},
        {"type":"message","content":"t2"},
        {"type":"message","content":"t3"},
        {"type":"message","content":"t4-ignored"}
      ]}`,
      `{"input":[{"type":"message","content":[
        {"text":""},{"text":"alpha"},{"text":"  "},{"text":"beta"}
      ]}]}`,
      '{"input":[{"type":"message","content":[{"text":" "},{"text":"x"}]}]}',
      '{"input":[{"type":"message","content":[{"text":" "},{"text":"\\t"}]}]}',
      `{"input":["plain",null,42,{"type":"message","content":"only-this"}]}`,
      '{"input":[{"type":"reasoning","content":"nope"}]}',
      '{"input":[{"type":"message","content":"a|b"}]}',
      '{"input":[]}',
      `{"input":[{"type":"message","content":"\u3000"}]}`,
      '{"input":[{"type":"message","content":[{"text":"\\ud83d"},{"text":"\\ude00 pair-across-parts"}]}]}',
    ];
    const caseNames = [
      "content string with escapes",
      "escaped unicode text",
      "escaped whitespace-only content is not counted",
      "surrogate pair via escapes",
      "unpaired high surrogate via escape",
      "unpaired high surrogate at end",
      "unpaired low surrogate first",
      "type empty string counts as untyped",
      "non-string type counts as untyped",
      "typed non-message items skipped",
      "cap at three texts",
      "parts join with empty strings dropped",
      "whitespace-only parts kept in join",
      "all-whitespace parts produce empty join",
      "non-object and string input items ignored",
      "no texts at all",
      "escaped separators inside content are data",
      "empty input array",
      "raw multibyte whitespace ideographic space",
      "surrogate pair spanning part boundary",
    ];
    for (let k = 0; k < cases.length; k++) {
      const parsed = JSON.parse(cases[k]) as Record<string, unknown>;
      const scan = scanJsonRequestBody(encodeBody(cases[k]));
      expect(scan.ok, `${caseNames[k]}: ok`).toBe(true);
      expect(scan.fingerprintHash, `${caseNames[k]}: hash`).toBe(
        extractInitialMessageTextHash(parsed)
      );
    }
  });

  test("trim-set parity: every BMP codepoint as single-char content", () => {
    // 单码点 content：legacy trim 后非空 ⟺ 计入指纹。逐码点对比 null-ness 与哈希。
    const start = Number(process.env.FAST_BODY_TRIM_START ?? 0x0000);
    const end = Number(process.env.FAST_BODY_TRIM_END ?? 0x3000);
    for (let code = start; code <= end; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue; // 代理区单独测
      const escaped = `{"input":[{"type":"message","content":"\\u${code
        .toString(16)
        .padStart(4, "0")}"}]}`;
      const parsed = JSON.parse(escaped) as Record<string, unknown>;
      const oracle = extractInitialMessageTextHash(parsed);
      const scan = scanJsonRequestBody(encodeBody(escaped));
      expect(scan.ok, `code=U+${code.toString(16)}`).toBe(true);
      expect(scan.fingerprintHash !== null, `code=U+${code.toString(16)} counted`).toBe(
        oracle !== null
      );
      if (oracle !== null) {
        expect(scan.fingerprintHash, `code=U+${code.toString(16)} hash`).toBe(oracle);
      }
    }
  });

  test("trim-set parity: escaped surrogates", () => {
    for (const code of [0xd800, 0xdbff, 0xdc00, 0xdfff, 0xd83d]) {
      const escaped = `{"input":[{"type":"message","content":"\\u${code
        .toString(16)
        .padStart(4, "0")}"}]}`;
      const parsed = JSON.parse(escaped) as Record<string, unknown>;
      const oracle = extractInitialMessageTextHash(parsed);
      const scan = scanJsonRequestBody(encodeBody(escaped));
      expect(scan.ok).toBe(true);
      expect(scan.fingerprintHash).toBe(oracle);
    }
  });

  test("rejection corpus: scan must reject known pathological forms", () => {
    const rejections: string[] = [
      '{"model":"a","model":"b","input":[]}',
      '{"input":[],"input":[]}',
      '{"instructions":"a","instructions":2,"input":[]}',
      '{"model":"a",}',
      '{"input":[1,]}',
      "{'model':'a'}",
      '{"model":"a" /* c */}',
      '{"max_tokens":NaN}',
      '{"max_tokens":+1}',
      '{"max_tokens":01}',
      '{"max_tokens":.5}',
      '{"max_tokens":1.}',
      '{"max_tokens":0x10}',
      '{"model":"abc}',
      '{"model":"a\x01b"}',
      '{"model":"a\\qb"}',
      '{"model":"a\\u00ZZ"}',
      '{"model":"a"',
      '[{"model":"a"}]',
      '"just a string"',
      '{"model":"a"} extra',
      '{"model"::"a"}',
      '{"model" "a"}',
      "",
    ];
    const names = [
      "duplicate model key",
      "duplicate input key",
      "duplicate instructions key",
      "trailing comma object",
      "trailing comma array",
      "single quotes",
      "comment",
      "NaN literal",
      "leading plus number",
      "leading zero number",
      "bare fraction",
      "trailing dot",
      "hex number",
      "unclosed string",
      "raw control char in string",
      "bad escape",
      "bad unicode escape",
      "unbalanced brace",
      "top-level array",
      "top-level string",
      "trailing garbage",
      "double colon",
      "missing colon",
      "empty body",
    ];
    for (let k = 0; k < rejections.length; k++) {
      const scan = scanJsonRequestBody(encodeBody(rejections[k]));
      expect(scan.ok, `${names[k]}: should reject`).toBe(false);
      expect(scan.anomaly, `${names[k]}: reason present`).toBeDefined();
    }
  });

  test("invalid UTF-8 falls back rather than accepting", () => {
    const bytes = new Uint8Array([
      0x7b, 0x22, 0x6d, 0x6f, 0x64, 0x65, 0x6c, 0x22, 0x3a, 0x22, 0x61, 0xef, 0xc3, 0x28, 0x22,
      0x2c, 0x22, 0x69, 0x6e, 0x70, 0x75, 0x74, 0x22, 0x3a, 0x5b, 0x5d, 0x7d,
    ]);
    const scan = scanJsonRequestBody(bytes);
    expect(scan.ok).toBe(false);
    expect(scan.anomaly).toBe("invalid_utf8");
  });

  test("acceptance implies JSON.parse succeeds (mutation fuzz)", () => {
    const rng = mulberry32(FUZZ_SEED + 13);
    let accepted = 0;
    for (let iteration = 0; iteration < 400; iteration++) {
      const body = randomCodexBody(rng);
      const text = serializeValueForFuzz(body, rng);
      const mutated = mutateText(text, rng);
      const scan = scanJsonRequestBody(encodeBody(mutated));
      if (scan.ok) {
        accepted += 1;
        expect(() => JSON.parse(mutated), `iter=${iteration} no false accept`).not.toThrow();
      }
    }
    expect(accepted, "mutations must not be rejected wholesale").toBeGreaterThan(0);
  });

  test("duplicate fingerprint keys inside items are rejected", () => {
    const scan = scanJsonRequestBody(
      encodeBody('{"input":[{"type":"message","type":"message","content":"x"}]}')
    );
    expect(scan.ok).toBe(false);
    expect(scan.anomaly).toBe("duplicate_fingerprint_key");
    const scan2 = scanJsonRequestBody(
      encodeBody('{"input":[{"type":"message","content":[{"text":"a","text":"b"}]}]}')
    );
    expect(scan2.ok).toBe(false);
    expect(scan2.anomaly).toBe("duplicate_fingerprint_key");
  });

  test("oversized tracked values fall back", () => {
    const bigModel = "a".repeat(5000);
    const scan = scanJsonRequestBody(encodeBody(`{"model":"${bigModel}","input":[]}`));
    expect(scan.ok).toBe(false);
    expect(scan.anomaly).toBe("oversized_tracked_value");
  });

  test("escaped item type decodes exactly like legacy (no fallback)", () => {
    const text =
      '{"input":[{"type":"\\u006dessage","content":"x"},{"type":"lo\\u0063al_shell_call","content":"y"}]}';
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const scan = scanJsonRequestBody(encodeBody(text));
    expect(scan.ok).toBe(true);
    // 第一个 item 的 type 解码为 "message" → 计入；第二个为 local_shell_call → 跳过。
    expect(scan.fingerprintHash).toBe(extractInitialMessageTextHash(parsed));
    expect(scan.facts.input0Type).toBe("message");
  });

  test("number edge values match JSON.parse", () => {
    const numbers = [
      "0",
      "-0",
      "1e999",
      "-1e999",
      "1E+5",
      "0.0001",
      "123456789012345678901234567890",
    ];
    for (const num of numbers) {
      const text = `{"max_tokens":${num},"input":[]}`;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const scan = scanJsonRequestBody(encodeBody(text));
      expect(scan.ok, `num=${num}`).toBe(true);
      expect(scan.fields.max_tokens?.value, `num=${num}`).toEqual(parsed.max_tokens);
    }
  });

  test("deep nesting beyond limit falls back", () => {
    const depth = 600;
    let text = '{"input":';
    for (let k = 0; k < depth; k++) text += "[";
    for (let k = 0; k < depth; k++) text += "]";
    text += "}";
    const scan = scanJsonRequestBody(encodeBody(text));
    expect(scan.ok).toBe(false);
    expect(scan.anomaly).toBe("depth_limit_exceeded");
  });

  test("summary-from-scan is byte-identical to the tree-path summary", () => {
    const rng = mulberry32(FUZZ_SEED + 5);
    for (let iteration = 0; iteration < 300; iteration++) {
      const body = randomCodexBody(rng);
      body.stream = true; // 快速路径人群 = stream:true
      const text = serializeValueForFuzz(body, rng);
      const scan = scanJsonRequestBody(encodeBody(text));
      if (!scan.ok) continue;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(
        buildHighConcurrencyCodexRequestSummaryFromScan(scan, 11, 22),
        `iter=${iteration}`
      ).toBe(buildHighConcurrencyCodexRequestSummary(parsed, 11, 22));
    }
  });

  test("nested input-like structures are not fingerprinted", () => {
    const text = `{"input":[{"type":"message","content":"real"}],
      "tools":[{"input":[{"type":"message","content":"fake"}]}]}`;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const scan = scanJsonRequestBody(encodeBody(text));
    expect(scan.ok).toBe(true);
    expect(scan.fingerprintHash).toBe(extractInitialMessageTextHash(parsed));
  });
});

void (0 as unknown as Rng); // 保持 Rng 类型导入被使用（生成器契约由 fast-body-fuzz 承载）
