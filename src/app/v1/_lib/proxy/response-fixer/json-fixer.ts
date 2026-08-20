import type { FixResult } from "./types";

const UTF8_DECODER = new TextDecoder();

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function looksLikeJson(data: Uint8Array): boolean {
  for (const b of data) {
    if (isWhitespace(b)) continue;
    return b === 0x7b /* { */ || b === 0x5b /* [ */;
  }
  return false;
}

function removeTrailingComma(bytes: number[]): void {
  let idx = bytes.length - 1;
  while (idx >= 0 && isWhitespace(bytes[idx])) idx -= 1;
  if (idx >= 0 && bytes[idx] === 0x2c /* , */) {
    bytes.length = idx;
  }
}

function needsNullValue(bytes: number[], stack: number[]): boolean {
  // 仅对象内（等待闭合 '}'）才可能出现 "key":<EOF> 这种情况
  if (stack.length === 0 || stack[stack.length - 1] !== 0x7d /* } */) {
    return false;
  }

  let idx = bytes.length - 1;
  while (idx >= 0 && isWhitespace(bytes[idx])) idx -= 1;
  return idx >= 0 && bytes[idx] === 0x3a /* : */;
}

export type JsonFixerConfig = {
  maxDepth: number;
  maxSize: number;
  /** 测试观测钩子：每次实际执行 JSON.parse 前调用（结构快速路径跳过时不计） */
  onJsonParse?: () => void;
};

/**
 * 单遍字节扫描：检测 repair() 能实际改动数据的全部痕迹。
 *
 * 等价性论证：repair() 仅在以下情况产生与输入不同的输出——
 * 1. 字符串未闭合（补引号）/ 末尾悬空转义（删反斜杠）
 * 2. EOF 处括号栈非空（补闭合符）
 * 3. 闭合符前的尾随逗号（删除），含 EOF 处裸逗号
 * 4. 对象内冒号后无值（补 null）
 * 5. 失配/多余的闭合符（丢弃该闭合符）
 * 6. 深度超过 maxDepth（repair 返回 null）
 *
 * 无以上痕迹时 repair() 是恒等变换：parse 成功则原样返回；parse 失败
 * （非法转义、坏数字等——repair 不处理这类错误）时修复结果同样无法通过
 * 校验。两种结局都返回原文，因此扫描干净即可跳过 decode+parse 直接透传。
 * 深度超限会被保守地视为"有痕迹"走慢路径，输出仍等价。
 */
export function hasRepairableArtifacts(data: Uint8Array, maxDepth: number): boolean {
  const stack: number[] = [];
  let inString = false;
  let escapeNext = false;
  let depth = 0;
  // 最近一个结构性（字符串外、非空白）字节，用于尾逗号/尾冒号检测
  let lastSignificant = -1;

  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (inString) {
      if (byte === 0x5c /* \ */) {
        escapeNext = true;
      } else if (byte === 0x22 /* " */) {
        inString = false;
        lastSignificant = byte;
      }
      continue;
    }

    if (isWhitespace(byte)) continue;

    if (byte === 0x22 /* " */) {
      inString = true;
      lastSignificant = byte;
      continue;
    }

    if (byte === 0x7b /* { */) {
      depth += 1;
      if (depth > maxDepth) return true;
      stack.push(0x7d /* } */);
      lastSignificant = byte;
      continue;
    }

    if (byte === 0x5b /* [ */) {
      depth += 1;
      if (depth > maxDepth) return true;
      stack.push(0x5d /* ] */);
      lastSignificant = byte;
      continue;
    }

    if (byte === 0x7d /* } */ || byte === 0x5d /* ] */) {
      // 闭合符前尾随逗号（repair 会删除）或多余/失配闭合符（repair 会丢弃）
      if (lastSignificant === 0x2c /* , */) return true;
      if (stack.length === 0 || stack[stack.length - 1] !== byte) return true;
      stack.pop();
      depth = Math.max(0, depth - 1);
      lastSignificant = byte;
      continue;
    }

    lastSignificant = byte;
  }

  // EOF 痕迹：悬空转义 / 未闭合字符串 / 未闭合结构 / 尾冒号 / 尾逗号
  if (escapeNext || inString || stack.length > 0) return true;
  if (lastSignificant === 0x3a /* : */ || lastSignificant === 0x2c /* , */) return true;

  return false;
}

export class JsonFixer {
  private readonly maxDepth: number;
  private readonly maxSize: number;
  private readonly onJsonParse: (() => void) | undefined;

  constructor(config: JsonFixerConfig) {
    this.maxDepth = config.maxDepth;
    this.maxSize = config.maxSize;
    this.onJsonParse = config.onJsonParse;
  }

  canFix(data: Uint8Array): boolean {
    return looksLikeJson(data);
  }

  fix(data: Uint8Array): FixResult<Uint8Array> {
    if (data.length > this.maxSize) {
      return { data, applied: false, details: "exceeded_max_size" };
    }

    if (!this.canFix(data)) {
      return { data, applied: false };
    }

    // 结构快速路径：无任何可修复痕迹时，无论 parse 成败，结果都是原文透传
    // （见 hasRepairableArtifacts 的等价性论证）。SSE 流中绝大多数 data 行
    // 是完整的 delta 事件，这里省掉每事件一次 decode+JSON.parse。
    if (!hasRepairableArtifacts(data, this.maxDepth)) {
      return { data, applied: false };
    }

    // 快速路径：有效 JSON 直接返回
    try {
      this.onJsonParse?.();
      JSON.parse(UTF8_DECODER.decode(data));
      return { data, applied: false };
    } catch {
      // fallthrough
    }

    // 慢速路径：修复并验证
    const repaired = this.repair(data);
    if (!repaired) {
      return { data, applied: false, details: "repair_failed" };
    }

    try {
      this.onJsonParse?.();
      JSON.parse(UTF8_DECODER.decode(repaired));
      return { data: repaired, applied: true };
    } catch {
      return { data, applied: false, details: "validate_repaired_failed" };
    }
  }

  private repair(data: Uint8Array): Uint8Array | null {
    const out: number[] = [];
    const stack: number[] = [];

    let inString = false;
    let escapeNext = false;
    let depth = 0;

    for (const byte of data) {
      if (escapeNext) {
        escapeNext = false;
        out.push(byte);
        continue;
      }

      if (inString && byte === 0x5c /* \\ */) {
        escapeNext = true;
        out.push(byte);
        continue;
      }

      if (byte === 0x22 /* \" */) {
        inString = !inString;
        out.push(byte);
        continue;
      }

      if (!inString) {
        if (byte === 0x7b /* { */) {
          depth += 1;
          if (depth > this.maxDepth) {
            return null;
          }
          stack.push(0x7d /* } */);
          out.push(byte);
          continue;
        }

        if (byte === 0x5b /* [ */) {
          depth += 1;
          if (depth > this.maxDepth) {
            return null;
          }
          stack.push(0x5d /* ] */);
          out.push(byte);
          continue;
        }

        if (byte === 0x7d /* } */) {
          removeTrailingComma(out);
          if (stack.length > 0 && stack[stack.length - 1] === byte) {
            stack.pop();
            depth = Math.max(0, depth - 1);
            out.push(byte);
          }
          continue;
        }

        if (byte === 0x5d /* ] */) {
          removeTrailingComma(out);
          if (stack.length > 0 && stack[stack.length - 1] === byte) {
            stack.pop();
            depth = Math.max(0, depth - 1);
            out.push(byte);
          }
          continue;
        }
      }

      out.push(byte);
    }

    // 末尾不完整的转义序列：去掉最后一个反斜杠
    if (escapeNext) {
      out.pop();
    }

    // 闭合未关闭的字符串
    if (inString) {
      out.push(0x22 /* \" */);
    }

    removeTrailingComma(out);

    // 对象末尾冒号无值：补 null
    if (needsNullValue(out, stack)) {
      out.push(0x6e /* n */);
      out.push(0x75 /* u */);
      out.push(0x6c /* l */);
      out.push(0x6c /* l */);
    }

    // 闭合所有未关闭结构
    while (stack.length > 0) {
      removeTrailingComma(out);
      out.push(stack.pop() as number);
    }

    return Uint8Array.from(out);
  }
}
