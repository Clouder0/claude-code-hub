import type { BodyScanResult } from "./body-scanner";

/**
 * codex /v1/responses 零变换快速路径：编辑表合成器。
 *
 * 出站体 = 原始通货字节 ± 有序编辑表。每次 attempt 单次分配输出缓冲；无编辑时
 * 直接返回通货本体（零拷贝，fetch 可原样消费）。替换以整个 value token 为单位
 * （字符串含引号），replacement 一律为 JSON.stringify(受控内部值)——不受原串
 * 转义形式影响，且值域受 CCH 配置/UUID 生成器控制，结构恒合法。
 */

export interface BodyEdit {
  /** [start, end) 相对通货字节；插入时 start === end。 */
  start: number;
  end: number;
  replacement: Uint8Array;
}

const EDIT_ENCODER = new TextEncoder();

export function encodeJsonFragment(fragment: string): Uint8Array {
  return EDIT_ENCODER.encode(fragment);
}

/**
 * 合成出站体。编辑表必须按 start 升序、互不重叠（越界/重叠是编程错误，抛错）。
 */
export function composeBody(source: Uint8Array, edits: readonly BodyEdit[]): Uint8Array {
  if (edits.length === 0) return source;
  let delta = 0;
  let prevEnd = 0;
  for (const edit of edits) {
    if (edit.start < prevEnd) {
      throw new Error(`composeBody: overlapping edits at ${edit.start}`);
    }
    if (edit.start > edit.end || edit.end > source.length) {
      throw new Error(`composeBody: edit out of bounds [${edit.start},${edit.end})`);
    }
    delta += edit.replacement.length - (edit.end - edit.start);
    prevEnd = edit.end;
  }
  const out = new Uint8Array(source.length + delta);
  let src = 0;
  let dst = 0;
  for (const edit of edits) {
    if (edit.start > src) {
      out.set(source.subarray(src, edit.start), dst);
      dst += edit.start - src;
    }
    out.set(edit.replacement, dst);
    dst += edit.replacement.length;
    src = edit.end;
  }
  if (src < source.length) {
    out.set(source.subarray(src), dst);
  }
  return out;
}

/** model 重定向：替换整个 model value token（含引号）。 */
export function buildModelRedirectEdit(scan: BodyScanResult, redirectedModel: string): BodyEdit {
  const field = scan.fields.model;
  if (!field) {
    throw new Error("fast body path: model redirect without a model field");
  }
  return {
    start: field.start,
    end: field.end,
    replacement: encodeJsonFragment(JSON.stringify(redirectedModel)),
  };
}

/**
 * prompt_cache_key 补全：已有值（含无效值，调用方按 normalizeCodexSessionId
 * 语义裁决）→ 替换 value token；缺失 → 在顶层 '{' 后插入带尾逗号的键值对
 * （键序对上游无语义；顶层必有键，故尾逗号安全——空对象无 input，不可能进入
 * 快速路径，此处仍防御性回退为整文替换）。
 */
export function buildPromptCacheKeyEdit(scan: BodyScanResult, sessionId: string): BodyEdit {
  const field = scan.fields.prompt_cache_key;
  const valueToken = JSON.stringify(sessionId);
  if (field) {
    return { start: field.start, end: field.end, replacement: encodeJsonFragment(valueToken) };
  }
  if (!scan.facts.topLevelHasKeys || scan.bytes[0] !== 0x7b) {
    // 防御：空顶层对象（理论上不可达——快速路径要求 inputIsArray）。
    return {
      start: 0,
      end: scan.bytes.length,
      replacement: encodeJsonFragment(`{"prompt_cache_key":${valueToken}}`),
    };
  }
  return {
    start: 1,
    end: 1,
    replacement: encodeJsonFragment(`"prompt_cache_key":${valueToken},`),
  };
}
