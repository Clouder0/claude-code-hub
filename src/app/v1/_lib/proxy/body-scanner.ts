import { createHash } from "node:crypto";

/**
 * codex /v1/responses 零变换快速路径：验证性 JSON 字节扫描器。
 *
 * 单遍扫描解码后的请求体字节，产出下游全部所需事实，而不再构建 JSON 树：
 * - 顶层受控标量的字节区间 + 解码值（model/stream/service_tier/prompt_cache_key/
 *   max_tokens/temperature/top_p/reasoning_effort/previous_response_id）
 * - thinking / metadata 小对象区间与解码值（计费投影与 codex session 提取所需）
 * - 结构事实（input 数量、tools 数量、instructions 非空、顶层键存在性）
 * - 会话指纹：与 session-completer 的 extractInitialMessageTextHash bit-exact 的
 *   流式哈希（前 ≤3 条 message 文本，未 trim、'|' 连接、sha256 前 16 hex）
 * - 任意深度下划线键检测（对应 filterPrivateParameters 的判定面）
 *
 * 扫描器同时是验证器：接受 ⟹ JSON.parse 可解析（UTF-8 层面比 legacy 更严：
 * 无效序列一律回退而非替换成 U+FFFD）。任何异常（语法、UTF-8、重复受控键、
 * 键内转义、超限受控值、深度超限）都返回 ok=false + 原因，调用方回退 legacy
 * JSON.parse 路径——fallback 是路由结果而非错误，legacy 会产生与今天完全一致
 * 的行为（包括错误语义）。
 *
 * 分配纪律：除结果对象（小）与 ≤3 组指纹区间外零分配；字符串值仅在受控上限内
 * 解码；指纹哈希在扫描结束后按区间喂入，原始段零拷贝（hash.update(subarray)）。
 */

export type TrackedFieldName =
  | "model"
  | "stream"
  | "service_tier"
  | "prompt_cache_key"
  | "max_tokens"
  | "temperature"
  | "top_p"
  | "reasoning_effort"
  | "previous_response_id";

export type FastBodyAnomalyReason =
  | "invalid_json"
  | "invalid_utf8"
  | "escape_in_key"
  | "duplicate_tracked_key"
  | "duplicate_fingerprint_key"
  | "top_level_not_object"
  | "oversized_tracked_value"
  | "depth_limit_exceeded";

/** [start, end) 字节区间：值 token 全量（字符串含引号）。 */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ScannedField extends ByteRange {
  kind: "string" | "number" | "boolean" | "null" | "object" | "array";
  /** 受控上限内解码出的值；object/array 不在此解码（见 thinkingValue/metadataValue）。 */
  value?: unknown;
}

export interface BodyScanFacts {
  inputIsArray: boolean;
  /** Array.isArray(input) ? input.length : null —— 与摘要器语义一致。 */
  inputItemCount: number | null;
  /** 首个 input item 的 type 字符串（观测用；超限时不记录）。 */
  input0Type: string | null;
  /**
   * input 恰一条且其 content 为字符串 "foo"/"count"（trim+lower 后精确匹配）——
   * 复刻 isProbeRequest 对 codex input 的拦截语义。
   */
  input0ProbeWord: boolean;
  /** Array.isArray(tools) ? tools.length : null */
  toolCount: number | null;
  /** typeof instructions === "string" && instructions.length > 0 */
  hasInstructions: boolean;
  /** 顶层对象至少有一个键（prompt_cache_key 插入锚点的前提）。 */
  topLevelHasKeys: boolean;
  /** 任意深度存在 "_" 前缀键（filterPrivateParameters 的判定面）。 */
  hasUnderscoreKeys: boolean;
  /**
   * 下划线成员的游程合并删除区间（按对象聚合，相邻连续 `_` 成员并为单区间，
   * 恰好吃掉一个边界逗号）。与 filterPrivateParameters 的递归剥除语义等价：
   * 成员级整删，被删成员内部的嵌套 `_` 键随之外消（区间已在产出时吞并）。
   */
  underscoreDeletionRanges: ByteRange[];
  /** 区间数超上限（病态输入）：true 时调用方必须按旧语义降解。 */
  underscoreDeletionsTruncated: boolean;
  /** 观测样本：前若干个下划线键名（与 legacy removedKeys 调试钩子对齐）。 */
  underscoreKeyNames: string[];
}

export interface BodyScanResult {
  ok: boolean;
  anomaly?: FastBodyAnomalyReason;
  bytes: Uint8Array;
  fields: Partial<Record<TrackedFieldName, ScannedField>>;
  thinkingRange: ByteRange | null;
  /** thinking 配置对象（token > SMALL_OBJECT_LIMIT 时按异常回退）。 */
  thinkingValue: Record<string, unknown> | null;
  metadataValue: Record<string, unknown> | null;
  /** client_metadata 小对象（cyberScopeBlock 的 installation 封禁判定读取）。 */
  clientMetadataValue: Record<string, unknown> | null;
  facts: BodyScanFacts;
  /** 与 legacy extractInitialMessageTextHash bit-exact 的 16-hex 指纹；无文本时 null。 */
  fingerprintHash: string | null;
}

const DEPTH_LIMIT = 512;
/** 受控标量字符串的解码上限（model/service_tier/pck/reasoning_effort/previous_response_id）。 */
const STRING_VALUE_LIMIT = 4096;
/** thinking/metadata 小对象的解码上限。 */
const SMALL_OBJECT_LIMIT = 2048;
/** input item 的 type 值解码上限（正常为短字符串；超限属病态输入）。 */
const TYPE_VALUE_LIMIT = 256;
const MAX_FINGERPRINT_TEXTS = 3;
/** 下划线删除游程上限：__schema 类客户端一次 ~25 个相邻键合并为 1 游程；超限属病态。 */
const MAX_UNDERSCORE_DELETION_RANGES = 128;
/** 观测键名样本上限（与 legacy removedKeys 调试面同级）。 */
const MAX_UNDERSCORE_KEY_NAME_SAMPLES = 32;

// 容器栈帧角色（决定指纹收集与事实提取的上下文）。
const ROLE_OTHER = 0;
const ROLE_TOP = 1;
const ROLE_INPUT_ARRAY = 2;
const ROLE_ITEM_OBJ = 3;
const ROLE_CONTENT_ARRAY = 4;
const ROLE_PART_OBJ = 5;
const ROLE_TOOLS_ARRAY = 6;

// 对象帧阶段。
const OBJ_WANT_KEY_OR_END = 0;
const OBJ_WANT_KEY = 1; // 逗号之后：必须有键，'}' 非法（拒绝尾随逗号）
const OBJ_WANT_COLON = 2;
const OBJ_WANT_VALUE = 3;
const OBJ_WANT_COMMA_OR_END = 4;
// 数组帧阶段。
const ARR_WANT_VALUE_OR_END = 0;
const ARR_WANT_VALUE = 1; // 逗号之后：必须有值，']' 非法（拒绝尾随逗号）
const ARR_WANT_COMMA_OR_END = 2;

const CONTAINER_OBJECT = 0;
const CONTAINER_ARRAY = 1;

const RAW_DECODER = new TextDecoder();

/** ECMAScript String.prototype.trim 的空白集（含 Zs 与行终止符；不含 U+0085）。 */
function isTrimWhitespace(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    codePoint === 0x20 ||
    codePoint === 0xa0 ||
    codePoint === 0xfeff ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30; // 0-9
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37; // A-F
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57; // a-f
  return -1;
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function rangeEqualsAscii(bytes: Uint8Array, start: number, end: number, literal: string): boolean {
  if (end - start !== literal.length) return false;
  for (let k = 0; k < literal.length; k++) {
    if (bytes[start + k] !== literal.charCodeAt(k)) return false;
  }
  return true;
}

function rangeHasBackslash(bytes: Uint8Array, start: number, end: number): boolean {
  for (let k = start; k < end; k++) {
    if (bytes[k] === 0x5c) return true;
  }
  return false;
}

interface FingerprintTextRange {
  start: number;
  end: number;
}

const TRACKED_FIELD_NAMES: readonly TrackedFieldName[] = [
  "model",
  "stream",
  "service_tier",
  "prompt_cache_key",
  "max_tokens",
  "temperature",
  "top_p",
  "reasoning_effort",
  "previous_response_id",
];

export function scanJsonRequestBody(bytes: Uint8Array): BodyScanResult {
  const n = bytes.length;
  const facts: BodyScanFacts = {
    inputIsArray: false,
    inputItemCount: null,
    input0Type: null,
    input0ProbeWord: false,
    toolCount: null,
    hasInstructions: false,
    topLevelHasKeys: false,
    hasUnderscoreKeys: false,
    underscoreDeletionRanges: [],
    underscoreDeletionsTruncated: false,
    underscoreKeyNames: [],
  };
  const fields: Partial<Record<TrackedFieldName, ScannedField>> = {};
  let thinkingRange: ByteRange | null = null;
  let metadataRange: ByteRange | null = null;
  let clientMetadataRange: ByteRange | null = null;
  // 首 item 的 content 字符串区间（probe 词判定用；与指纹收集独立）。
  let item1ContentInner: { start: number; end: number } | null = null;

  const anomaly = (reason: FastBodyAnomalyReason): BodyScanResult => ({
    ok: false,
    anomaly: reason,
    bytes,
    fields,
    thinkingRange,
    facts,
    fingerprintHash: null,
    thinkingValue: null,
    metadataValue: null,
    clientMetadataValue: null,
  });

  if (n === 0) return anomaly("invalid_json");

  // —— 容器栈（按深度上限预分配；帧 0 恒为顶层对象）——
  const kindOf = new Uint8Array(DEPTH_LIMIT + 1);
  const phaseOf = new Uint8Array(DEPTH_LIMIT + 1);
  const roleOf = new Uint8Array(DEPTH_LIMIT + 1);
  const startOf = new Int32Array(DEPTH_LIMIT + 1); // 容器值 token 起始
  const itemCountOf = new Int32Array(DEPTH_LIMIT + 1);
  const keyCountOf = new Int32Array(DEPTH_LIMIT + 1);
  const keyStartOf = new Int32Array(DEPTH_LIMIT + 1); // 各帧 pending key 区间
  const keyEndOf = new Int32Array(DEPTH_LIMIT + 1);
  // 下划线删除游程状态（按对象帧）：相邻 `_` 成员合并为单区间，恰好吃一个边界逗号。
  const runOpenOf = new Uint8Array(DEPTH_LIMIT + 1);
  const runHasPredOf = new Uint8Array(DEPTH_LIMIT + 1);
  const runStartKeyOf = new Int32Array(DEPTH_LIMIT + 1); // 首成员键引号位
  const runStartMemberOf = new Int32Array(DEPTH_LIMIT + 1); // 首成员起始（前成员值结束处）
  const runEndOf = new Int32Array(DEPTH_LIMIT + 1); // 末成员值结束
  const prevValueEndOf = new Int32Array(DEPTH_LIMIT + 1);
  const pendingKeyIsUnderscoreOf = new Uint8Array(DEPTH_LIMIT + 1);

  // —— 顶层受控键的重复检测 ——
  const seenTopKeys = new Set<string>();

  // —— 指纹收集（input 血统内；收满 3 条或 input 结束后停采但状态仍复位）——
  let collectFingerprint = false;
  const fingerprintTexts: FingerprintTextRange[][] = [];
  let itemOrdinal = 0; // 已进入的 input item 计数（input0Type 用）
  let item0TypeRecorded = false;
  // 当前 input item 的收集状态（item 键序任意，item 结束时统一裁决）。
  let itemTypeSeen = false;
  let itemIsMessage = false;
  let itemTypeIsString = false;
  let itemTypeNonEmpty = false;
  let contentSeen = false;
  let contentIsString = false;
  let contentStringRange: FingerprintTextRange | null = null;
  let contentStringHasNonWs = false;
  let contentPartRanges: FingerprintTextRange[] = [];
  let contentHasNonWs = false;
  // 当前 content part 的收集状态。
  let partTextSeen = false;
  let partTextRange: FingerprintTextRange | null = null;
  let partTextHasNonWs = false;

  let i = 0;
  let top = -1; // 栈顶帧下标

  /** 在 [from, to) 定位成员分隔逗号（JSON 文法保证恰好一个；缺失按防御性截断）。 */
  function findSeparatorComma(from: number, to: number): number {
    for (let p = from; p < to; p++) {
      if (bytes[p] === 0x2c) return p;
    }
    return -1;
  }

  /**
   * 产出一条游程删除区间：
   * - 有前驱成员：吃前逗号 [comma, runEnd)；
   * - 无前驱有后继：吃后逗号 [firstKey, comma+1)；
   * - 唯一成员：[firstKey, runEnd)。
   * 恰好吃一个逗号 ⇒ 产物恒为合法 JSON，且与 filterPrivateParameters 的键集等价。
   * 嵌套吞并：被本区间完全包含的既有区间（来自已删成员内部）丢弃，杜绝重叠。
   */
  function emitRun(frame: number, successorKeyQuote: number | null): void {
    if (
      facts.underscoreDeletionsTruncated ||
      facts.underscoreDeletionRanges.length >= MAX_UNDERSCORE_DELETION_RANGES
    ) {
      facts.underscoreDeletionsTruncated = true;
      return;
    }
    const firstKey = runStartKeyOf[frame];
    let start: number;
    let end: number;
    if (runHasPredOf[frame] === 1) {
      const comma = findSeparatorComma(runStartMemberOf[frame], firstKey);
      if (comma < 0) {
        facts.underscoreDeletionsTruncated = true;
        return;
      }
      start = comma;
      end = runEndOf[frame];
    } else {
      start = firstKey;
      if (successorKeyQuote == null) {
        end = runEndOf[frame];
      } else {
        const comma = findSeparatorComma(runEndOf[frame], successorKeyQuote);
        if (comma < 0) {
          facts.underscoreDeletionsTruncated = true;
          return;
        }
        end = comma + 1;
      }
    }
    const range = { start, end };
    if (facts.underscoreDeletionRanges.length > 0) {
      facts.underscoreDeletionRanges = facts.underscoreDeletionRanges.filter(
        (r) => !(r.start >= range.start && r.end <= range.end)
      );
    }
    facts.underscoreDeletionRanges.push(range);
  }

  const resetItemState = (): void => {
    itemTypeSeen = false;
    itemIsMessage = false;
    itemTypeIsString = false;
    itemTypeNonEmpty = false;
    contentSeen = false;
    contentIsString = false;
    contentStringRange = null;
    contentStringHasNonWs = false;
    contentPartRanges = [];
    contentHasNonWs = false;
  };

  const resetPartState = (): void => {
    partTextSeen = false;
    partTextRange = null;
    partTextHasNonWs = false;
  };

  const pushTextCandidate = (ranges: FingerprintTextRange[]): void => {
    fingerprintTexts.push(ranges);
    if (fingerprintTexts.length >= MAX_FINGERPRINT_TEXTS) collectFingerprint = false;
  };

  /** item 对象关闭：按 legacy 语义裁决是否把候选文本计入指纹；无条件复位状态。 */
  const finalizeItem = (): void => {
    // legacy: `if (itemType && itemType !== "message") continue;`——仅"非空字符串
    // 且 ≠ message"才跳过；type 为空串/非字符串均按无类型计入。
    const skipByType = itemTypeIsString && itemTypeNonEmpty && !itemIsMessage;
    const shouldPush = collectFingerprint && !skipByType;
    if (shouldPush) {
      if (contentIsString && contentStringRange) {
        // content 字符串：trim 非空才计入；计入的是未 trim 全文。
        if (contentStringHasNonWs) pushTextCandidate([contentStringRange]);
      } else if (contentSeen) {
        // parts.join("")：trim 非空 ⟺ 任一计入部分存在非空白码点。
        if (contentHasNonWs) pushTextCandidate(contentPartRanges);
      }
    }
    resetItemState();
    resetPartState();
  };

  /** content part 对象关闭：空串跳过、非空（含纯空白）计入 join；无条件复位。 */
  const finishPart = (): void => {
    if (collectFingerprint && partTextRange && partTextRange.end > partTextRange.start) {
      contentPartRanges.push(partTextRange);
      if (partTextHasNonWs) contentHasNonWs = true;
    }
    resetPartState();
  };

  /** 值完成钩子（父帧视角）。arrayItemCount 仅数组值携带。 */
  const onValueComplete = (
    parentFrame: number,
    valueStart: number,
    valueEnd: number,
    kind: ScannedField["kind"],
    arrayItemCount: number
  ): FastBodyAnomalyReason | null => {
    // 下划线删除游程：对象成员值完成点记账（供后续成员 memberStart 与游程末端）。
    if (parentFrame >= 0 && kindOf[parentFrame] === CONTAINER_OBJECT) {
      prevValueEndOf[parentFrame] = valueEnd;
      if (pendingKeyIsUnderscoreOf[parentFrame] === 1 && runOpenOf[parentFrame] === 1) {
        runEndOf[parentFrame] = valueEnd;
      }
      pendingKeyIsUnderscoreOf[parentFrame] = 0;
    }
    const parentRole = roleOf[parentFrame];
    const inObject = kindOf[parentFrame] === CONTAINER_OBJECT;
    const keyStart = inObject ? keyStartOf[parentFrame] : -1;
    const keyEnd = inObject ? keyEndOf[parentFrame] : -1;

    if (parentRole !== ROLE_TOP || !inObject) {
      // —— 非顶层：只服务指纹收集 ——
      if (!collectFingerprint) return null;
      if (parentRole === ROLE_ITEM_OBJ) {
        if (rangeEqualsAscii(bytes, keyStart, keyEnd, "type")) {
          if (itemTypeSeen) return "duplicate_fingerprint_key";
          itemTypeSeen = true;
          if (kind === "string") {
            itemTypeIsString = true;
            itemTypeNonEmpty = valueEnd - valueStart > 2;
            if (valueEnd - valueStart - 2 > TYPE_VALUE_LIMIT) {
              return "oversized_tracked_value";
            }
            // type 值短小：完整解码后与 "message" 精确比较——转义形式（如
            // "\u006dessage"）与 legacy 解码语义逐位等价，无需回退。
            const decoded = decodeJsonStringRange(valueStart + 1, valueEnd - 1);
            if (typeof decoded !== "string") return decoded;
            itemIsMessage = decoded === "message";
            if (itemOrdinal === 1 && !item0TypeRecorded) {
              facts.input0Type = decoded;
              item0TypeRecorded = true;
            }
          }
          return null;
        }
        if (rangeEqualsAscii(bytes, keyStart, keyEnd, "content")) {
          if (contentSeen) return "duplicate_fingerprint_key";
          contentSeen = true;
          if (kind === "string") {
            contentIsString = true;
            contentStringRange = { start: valueStart + 1, end: valueEnd - 1 };
            if (itemOrdinal === 1) {
              item1ContentInner = { start: valueStart + 1, end: valueEnd - 1 };
            }
          }
          return null;
        }
        return null;
      }
      if (parentRole === ROLE_PART_OBJ) {
        if (rangeEqualsAscii(bytes, keyStart, keyEnd, "text")) {
          if (partTextSeen) return "duplicate_fingerprint_key";
          partTextSeen = true;
          if (kind === "string") {
            partTextRange = { start: valueStart + 1, end: valueEnd - 1 };
          }
        }
        return null;
      }
      return null;
    }

    // —— 顶层受控键（重复即回退：legacy JSON.parse 取 last-wins，本扫描器不
    // 复刻多值覆盖语义——重复属病态输入，fallback 即 parity）——
    const seenKey = (name: string): FastBodyAnomalyReason | null => {
      if (seenTopKeys.has(name)) return "duplicate_tracked_key";
      seenTopKeys.add(name);
      return null;
    };
    if (rangeEqualsAscii(bytes, keyStart, keyEnd, "input")) {
      const dup = seenKey("input");
      if (dup) return dup;
      if (kind === "array") {
        facts.inputIsArray = true;
        facts.inputItemCount = arrayItemCount;
        facts.input0ProbeWord =
          arrayItemCount === 1 &&
          item1ContentInner !== null &&
          item1ContentInner.end - item1ContentInner.start <= 64
            ? isProbeWord(decodeJsonStringRange(item1ContentInner.start, item1ContentInner.end))
            : false;
      }
      return null;
    }
    if (rangeEqualsAscii(bytes, keyStart, keyEnd, "tools")) {
      const dup = seenKey("tools");
      if (dup) return dup;
      if (kind === "array") facts.toolCount = arrayItemCount;
      return null;
    }
    if (rangeEqualsAscii(bytes, keyStart, keyEnd, "instructions")) {
      const dup = seenKey("instructions");
      if (dup) return dup;
      // 非空字符串 ⟺ token 宽 > 2（"" 是唯一空串形式）。
      if (kind === "string" && valueEnd - valueStart > 2) facts.hasInstructions = true;
      return null;
    }
    if (rangeEqualsAscii(bytes, keyStart, keyEnd, "thinking")) {
      const dup = seenKey("thinking");
      if (dup) return dup;
      if (valueEnd - valueStart > SMALL_OBJECT_LIMIT) return "oversized_tracked_value";
      thinkingRange = { start: valueStart, end: valueEnd };
      return null;
    }
    if (rangeEqualsAscii(bytes, keyStart, keyEnd, "metadata")) {
      const dup = seenKey("metadata");
      if (dup) return dup;
      if (kind !== "object" && kind !== "array") return null; // 非对象照 legacy 得 null
      if (valueEnd - valueStart > SMALL_OBJECT_LIMIT) return "oversized_tracked_value";
      metadataRange = { start: valueStart, end: valueEnd };
      return null;
    }
    if (rangeEqualsAscii(bytes, keyStart, keyEnd, "client_metadata")) {
      const dup = seenKey("client_metadata");
      if (dup) return dup;
      if (kind !== "object" && kind !== "array") return null;
      if (valueEnd - valueStart > SMALL_OBJECT_LIMIT) return "oversized_tracked_value";
      clientMetadataRange = { start: valueStart, end: valueEnd };
      return null;
    }
    for (const name of TRACKED_FIELD_NAMES) {
      if (!rangeEqualsAscii(bytes, keyStart, keyEnd, name)) continue;
      const dup = seenKey(name);
      if (dup) return dup;
      const field: ScannedField = { start: valueStart, end: valueEnd, kind };
      if (kind === "string") {
        if (valueEnd - valueStart - 2 > STRING_VALUE_LIMIT) return "oversized_tracked_value";
        const decoded = decodeJsonStringRange(valueStart + 1, valueEnd - 1);
        if (typeof decoded !== "string") return decoded;
        field.value = decoded;
      } else if (kind === "number") {
        // 语法已验证；Number() 与 JSON.parse 对合法 JSON 数字取值一致（含 1e999→Infinity）。
        field.value = Number(RAW_DECODER.decode(bytes.subarray(valueStart, valueEnd)));
      } else if (kind === "boolean") {
        field.value = bytes[valueStart] === 0x74; // 't'rue
      }
      fields[name] = field;
      return null;
    }
    return null;
  };

  /** 小字符串区间的完整解码（raw 段已验证为合法 UTF-8；未配对代理保留码元）。 */
  function decodeJsonStringRange(
    innerStart: number,
    innerEnd: number
  ): string | FastBodyAnomalyReason {
    let out = "";
    let runStart = innerStart;
    let p = innerStart;
    while (p < innerEnd) {
      if (bytes[p] !== 0x5c) {
        p += 1;
        continue;
      }
      if (p > runStart) out += RAW_DECODER.decode(bytes.subarray(runStart, p));
      const e = bytes[p + 1];
      if (e === 0x75) {
        let code = 0;
        for (let h = 0; h < 4; h++) {
          const v = hexValue(bytes[p + 2 + h]);
          if (v < 0) return "invalid_json";
          code = code * 16 + v;
        }
        out += String.fromCharCode(code);
        p += 6;
      } else {
        switch (e) {
          case 0x22:
            out += '"';
            break;
          case 0x5c:
            out += "\\";
            break;
          case 0x2f:
            out += "/";
            break;
          case 0x62:
            out += "\b";
            break;
          case 0x66:
            out += "\f";
            break;
          case 0x6e:
            out += "\n";
            break;
          case 0x72:
            out += "\r";
            break;
          case 0x74:
            out += "\t";
            break;
          default:
            return "invalid_json";
        }
        p += 2;
      }
      runStart = p;
    }
    if (p > runStart) out += RAW_DECODER.decode(bytes.subarray(runStart, p));
    return out;
  }

  /**
   * 字符串扫描 + UTF-8 验证；onCodePoint 存在时逐码点上报（指纹空白判定）。
   * 返回闭合引号位置或异常原因。
   */
  function scanStringContent(
    openQuote: number,
    onCodePoint?: (codePoint: number) => void
  ): number | FastBodyAnomalyReason {
    let p = openQuote + 1;
    let utf8Remaining = 0;
    let utf8Min = 0x80;
    let utf8Max = 0xbf;
    let utf8CodePoint = 0;
    while (p < n) {
      const b = bytes[p];
      if (b === 0x22) return p;
      if (b === 0x5c) {
        const e = bytes[p + 1];
        if (e === 0x75) {
          let code = 0;
          for (let h = 0; h < 4; h++) {
            const v = hexValue(bytes[p + 2 + h]);
            if (v < 0) return "invalid_json";
            code = code * 16 + v;
          }
          if (onCodePoint) onCodePoint(code);
          p += 6;
          continue;
        }
        switch (e) {
          case 0x22:
            if (onCodePoint) onCodePoint(0x22);
            break;
          case 0x5c:
            if (onCodePoint) onCodePoint(0x5c);
            break;
          case 0x2f:
            if (onCodePoint) onCodePoint(0x2f);
            break;
          case 0x62:
            if (onCodePoint) onCodePoint(0x08);
            break;
          case 0x66:
            if (onCodePoint) onCodePoint(0x0c);
            break;
          case 0x6e:
            if (onCodePoint) onCodePoint(0x0a);
            break;
          case 0x72:
            if (onCodePoint) onCodePoint(0x0d);
            break;
          case 0x74:
            if (onCodePoint) onCodePoint(0x09);
            break;
          default:
            return "invalid_json";
        }
        p += 2;
        continue;
      }
      if (b < 0x20) return "invalid_json";
      if (b < 0x80) {
        if (onCodePoint) onCodePoint(b);
        p += 1;
        continue;
      }
      if (utf8Remaining === 0) {
        if (b >= 0xc2 && b <= 0xdf) {
          utf8Remaining = 1;
          utf8CodePoint = b & 0x1f;
        } else if (b === 0xe0) {
          utf8Remaining = 2;
          utf8Min = 0xa0;
          utf8Max = 0xbf;
          utf8CodePoint = 0;
        } else if ((b >= 0xe1 && b <= 0xec) || b === 0xee || b === 0xef) {
          utf8Remaining = 2;
          utf8CodePoint = b & 0x0f;
        } else if (b === 0xed) {
          utf8Remaining = 2;
          utf8Min = 0x80;
          utf8Max = 0x9f; // 排除 CESU 代理对编码
          utf8CodePoint = b & 0x0f;
        } else if (b === 0xf0) {
          utf8Remaining = 3;
          utf8Min = 0x90;
          utf8Max = 0xbf;
          utf8CodePoint = 0;
        } else if (b >= 0xf1 && b <= 0xf3) {
          utf8Remaining = 3;
          utf8CodePoint = b & 0x07;
        } else if (b === 0xf4) {
          utf8Remaining = 3;
          utf8Min = 0x80;
          utf8Max = 0x8f;
          utf8CodePoint = b & 0x07;
        } else {
          return "invalid_utf8";
        }
        p += 1;
        continue;
      }
      if (b < utf8Min || b > utf8Max) return "invalid_utf8";
      utf8CodePoint = (utf8CodePoint << 6) | (b & 0x3f);
      utf8Remaining -= 1;
      utf8Min = 0x80;
      utf8Max = 0xbf;
      if (utf8Remaining === 0 && onCodePoint) onCodePoint(utf8CodePoint);
      p += 1;
    }
    return "invalid_json"; // 未闭合字符串
  }

  function scanNumber(start: number): number | FastBodyAnomalyReason {
    let p = start;
    if (bytes[p] === 0x2d) p += 1; // '-'
    if (p >= n) return "invalid_json";
    if (bytes[p] === 0x30) {
      p += 1;
    } else if (bytes[p] >= 0x31 && bytes[p] <= 0x39) {
      while (p < n && bytes[p] >= 0x30 && bytes[p] <= 0x39) p += 1;
    } else {
      return "invalid_json";
    }
    if (p < n && bytes[p] === 0x2e) {
      p += 1;
      if (p >= n || bytes[p] < 0x30 || bytes[p] > 0x39) return "invalid_json";
      while (p < n && bytes[p] >= 0x30 && bytes[p] <= 0x39) p += 1;
    }
    if (p < n && (bytes[p] === 0x65 || bytes[p] === 0x45)) {
      p += 1;
      if (p < n && (bytes[p] === 0x2b || bytes[p] === 0x2d)) p += 1;
      if (p >= n || bytes[p] < 0x30 || bytes[p] > 0x39) return "invalid_json";
      while (p < n && bytes[p] >= 0x30 && bytes[p] <= 0x39) p += 1;
    }
    if (p < n) {
      const next = bytes[p];
      const isDelimiter =
        next === 0x2c || next === 0x7d || next === 0x5d || isAsciiWhitespace(next);
      if (!isDelimiter) return "invalid_json";
    }
    return p;
  }

  /** 值完成后推进拥有帧阶段（ownerFrame = 值所属容器帧；标量与容器关闭共用）。 */
  function advanceAfterValue(ownerFrame: number): void {
    phaseOf[ownerFrame] =
      kindOf[ownerFrame] === CONTAINER_OBJECT ? OBJ_WANT_COMMA_OR_END : ARR_WANT_COMMA_OR_END;
  }

  /** 解析一个值（标量内联完成；容器压帧）。返回异常原因或 null。 */
  function parseValue(parentFrame: number): FastBodyAnomalyReason | null {
    while (i < n && isAsciiWhitespace(bytes[i])) i += 1;
    if (i >= n) return "invalid_json";
    const v = bytes[i];

    if (v === 0x7b || v === 0x5b) {
      if (top + 1 > DEPTH_LIMIT) return "depth_limit_exceeded";
      // 计算新帧角色（只跟踪 input 血统与 tools 计数）。
      const parentRole = roleOf[parentFrame];
      const parentIsObject = kindOf[parentFrame] === CONTAINER_OBJECT;
      const keyStart = parentIsObject ? keyStartOf[parentFrame] : -1;
      const keyEnd = parentIsObject ? keyEndOf[parentFrame] : -1;
      let role = ROLE_OTHER;
      if (parentRole === ROLE_TOP && parentIsObject) {
        if (v === 0x5b && rangeEqualsAscii(bytes, keyStart, keyEnd, "input")) {
          role = ROLE_INPUT_ARRAY;
          collectFingerprint = true; // 激活指纹收集（item 扫描即刻开始）
        } else if (v === 0x5b && rangeEqualsAscii(bytes, keyStart, keyEnd, "tools")) {
          role = ROLE_TOOLS_ARRAY;
        }
      } else if (parentRole === ROLE_INPUT_ARRAY && v === 0x7b) {
        role = ROLE_ITEM_OBJ;
        itemOrdinal += 1;
        resetItemState();
      } else if (
        parentRole === ROLE_ITEM_OBJ &&
        parentIsObject &&
        v === 0x5b &&
        rangeEqualsAscii(bytes, keyStart, keyEnd, "content")
      ) {
        role = ROLE_CONTENT_ARRAY;
      } else if (parentRole === ROLE_CONTENT_ARRAY && v === 0x7b) {
        role = ROLE_PART_OBJ;
        resetPartState();
      }
      top += 1;
      kindOf[top] = v === 0x7b ? CONTAINER_OBJECT : CONTAINER_ARRAY;
      phaseOf[top] = v === 0x7b ? OBJ_WANT_KEY_OR_END : ARR_WANT_VALUE_OR_END;
      roleOf[top] = role;
      startOf[top] = i;
      itemCountOf[top] = 0;
      keyCountOf[top] = 0;
      runOpenOf[top] = 0;
      pendingKeyIsUnderscoreOf[top] = 0;
      prevValueEndOf[top] = -1;
      i += 1;
      return null;
    }

    const valueStart = i;
    if (v === 0x22) {
      // 字符串：按上下文决定是否做码点走查（指纹空白判定）。
      const parentRole = roleOf[parentFrame];
      const parentIsObject = kindOf[parentFrame] === CONTAINER_OBJECT;
      const keyStart = parentIsObject ? keyStartOf[parentFrame] : -1;
      const keyEnd = parentIsObject ? keyEndOf[parentFrame] : -1;
      let watchWhitespace = false;
      if (collectFingerprint && parentIsObject) {
        if (parentRole === ROLE_ITEM_OBJ && rangeEqualsAscii(bytes, keyStart, keyEnd, "content")) {
          watchWhitespace = true;
        } else if (
          parentRole === ROLE_PART_OBJ &&
          rangeEqualsAscii(bytes, keyStart, keyEnd, "text")
        ) {
          watchWhitespace = true;
        }
      }
      let hasNonWs = false;
      let close: number | FastBodyAnomalyReason;
      if (watchWhitespace) {
        close = scanStringContent(i, (codePoint) => {
          if (!isTrimWhitespace(codePoint)) hasNonWs = true;
        });
      } else {
        close = scanStringContent(i);
      }
      if (typeof close !== "number") return close;
      i = close + 1;
      if (watchWhitespace) {
        if (parentRole === ROLE_ITEM_OBJ) contentStringHasNonWs = hasNonWs;
        else if (parentRole === ROLE_PART_OBJ) partTextHasNonWs = hasNonWs;
      }
      const reason = onValueComplete(parentFrame, valueStart, i, "string", 0);
      if (reason) return reason;
      advanceAfterValue(parentFrame);
      return null;
    }

    if (v === 0x2d || (v >= 0x30 && v <= 0x39)) {
      const numberEnd = scanNumber(i);
      if (typeof numberEnd !== "number") return numberEnd;
      i = numberEnd;
      const reason = onValueComplete(parentFrame, valueStart, i, "number", 0);
      if (reason) return reason;
      advanceAfterValue(parentFrame);
      return null;
    }

    if (v === 0x74 && rangeEqualsAscii(bytes, i, i + 4, "true")) {
      i += 4;
      const reason = onValueComplete(parentFrame, valueStart, i, "boolean", 0);
      if (reason) return reason;
      advanceAfterValue(parentFrame);
      return null;
    }
    if (v === 0x66 && rangeEqualsAscii(bytes, i, i + 5, "false")) {
      i += 5;
      const reason = onValueComplete(parentFrame, valueStart, i, "boolean", 0);
      if (reason) return reason;
      advanceAfterValue(parentFrame);
      return null;
    }
    if (v === 0x6e && rangeEqualsAscii(bytes, i, i + 4, "null")) {
      i += 4;
      const reason = onValueComplete(parentFrame, valueStart, i, "null", 0);
      if (reason) return reason;
      advanceAfterValue(parentFrame);
      return null;
    }

    return "invalid_json";
  }

  // —— 主循环 ——
  while (i < n && isAsciiWhitespace(bytes[i])) i += 1;
  if (i >= n || bytes[i] !== 0x7b) return anomaly("top_level_not_object");

  top += 1;
  kindOf[top] = CONTAINER_OBJECT;
  phaseOf[top] = OBJ_WANT_KEY_OR_END;
  roleOf[top] = ROLE_TOP;
  startOf[top] = i;
  itemCountOf[top] = 0;
  keyCountOf[top] = 0;
  runOpenOf[top] = 0;
  pendingKeyIsUnderscoreOf[top] = 0;
  prevValueEndOf[top] = -1;
  i += 1;

  while (top >= 0) {
    const frame = top;
    while (i < n && isAsciiWhitespace(bytes[i])) i += 1;
    if (i >= n) return anomaly("invalid_json");
    const b = bytes[i];
    const isObject = kindOf[frame] === CONTAINER_OBJECT;

    if (isObject) {
      if (phaseOf[frame] === OBJ_WANT_KEY_OR_END || phaseOf[frame] === OBJ_WANT_KEY) {
        if (b === 0x7d) {
          if (phaseOf[frame] === OBJ_WANT_KEY) return anomaly("invalid_json"); // 尾随逗号
          i += 1;
          if (roleOf[frame] === ROLE_ITEM_OBJ) finalizeItem();
          if (roleOf[frame] === ROLE_PART_OBJ) finishPart();
          if (roleOf[frame] === ROLE_TOP) facts.topLevelHasKeys = keyCountOf[frame] > 0;
          if (runOpenOf[frame] === 1) {
            emitRun(frame, null);
            runOpenOf[frame] = 0;
          }
          const reason = onValueComplete(frame - 1, startOf[frame], i, "object", 0);
          if (reason) return anomaly(reason);
          top -= 1;
          if (frame > 0) advanceAfterValue(frame - 1);
          continue;
        }
        if (b !== 0x22) return anomaly("invalid_json");
        const keyQuote = i;
        const keyClose = scanStringContent(i);
        if (typeof keyClose !== "number") return anomaly(keyClose);
        const innerStart = i + 1;
        const innerEnd = keyClose;
        if (rangeHasBackslash(bytes, innerStart, innerEnd)) {
          return anomaly("escape_in_key");
        }
        if (innerEnd > innerStart && bytes[innerStart] === 0x5f) {
          facts.hasUnderscoreKeys = true;
          if (facts.underscoreKeyNames.length < MAX_UNDERSCORE_KEY_NAME_SAMPLES) {
            facts.underscoreKeyNames.push(
              RAW_DECODER.decode(bytes.subarray(innerStart, Math.min(innerEnd, innerStart + 64)))
            );
          }
          if (runOpenOf[frame] === 0) {
            runOpenOf[frame] = 1;
            runHasPredOf[frame] = keyCountOf[frame] > 0 ? 1 : 0;
            runStartKeyOf[frame] = keyQuote;
            runStartMemberOf[frame] = prevValueEndOf[frame];
          }
          pendingKeyIsUnderscoreOf[frame] = 1;
        } else {
          if (runOpenOf[frame] === 1) {
            emitRun(frame, keyQuote);
            runOpenOf[frame] = 0;
          }
          pendingKeyIsUnderscoreOf[frame] = 0;
        }
        keyStartOf[frame] = innerStart;
        keyEndOf[frame] = innerEnd;
        keyCountOf[frame] += 1;
        i = keyClose + 1;
        phaseOf[frame] = OBJ_WANT_COLON;
        continue;
      }
      if (phaseOf[frame] === OBJ_WANT_COLON) {
        if (b !== 0x3a) return anomaly("invalid_json");
        i += 1;
        phaseOf[frame] = OBJ_WANT_VALUE;
        continue;
      }
      if (phaseOf[frame] === OBJ_WANT_VALUE) {
        const reason = parseValue(frame);
        if (reason) return anomaly(reason);
        continue;
      }
      // OBJ_WANT_COMMA_OR_END
      if (b === 0x2c) {
        i += 1;
        phaseOf[frame] = OBJ_WANT_KEY;
        continue;
      }
      if (b === 0x7d) {
        phaseOf[frame] = OBJ_WANT_KEY_OR_END;
        continue;
      }
      return anomaly("invalid_json");
    }

    // 数组帧
    if (phaseOf[frame] === ARR_WANT_VALUE_OR_END || phaseOf[frame] === ARR_WANT_VALUE) {
      if (b === 0x5d) {
        if (phaseOf[frame] === ARR_WANT_VALUE) return anomaly("invalid_json"); // 尾随逗号
        i += 1;
        const reason = onValueComplete(frame - 1, startOf[frame], i, "array", itemCountOf[frame]);
        if (reason) return anomaly(reason);
        if (roleOf[frame] === ROLE_INPUT_ARRAY) collectFingerprint = false;
        top -= 1;
        if (frame > 0) advanceAfterValue(frame - 1);
        continue;
      }
      itemCountOf[frame] += 1;
      const reason = parseValue(frame);
      if (reason) return anomaly(reason);
      continue;
    }
    // ARR_WANT_COMMA_OR_END
    if (b === 0x2c) {
      i += 1;
      phaseOf[frame] = ARR_WANT_VALUE;
      continue;
    }
    if (b === 0x5d) {
      phaseOf[frame] = ARR_WANT_VALUE_OR_END;
      continue;
    }
    return anomaly("invalid_json");
  }

  // 尾部只允许 JSON 空白。
  while (i < n) {
    if (!isAsciiWhitespace(bytes[i])) return anomaly("invalid_json");
    i += 1;
  }

  // —— 小对象解码（区间已由扫描器验证为合法 JSON）——
  let thinkingValue: Record<string, unknown> | null = null;
  const thinkingToken = thinkingRange as ByteRange | null;
  if (thinkingToken) {
    const parsed = JSON.parse(
      RAW_DECODER.decode(bytes.subarray(thinkingToken.start, thinkingToken.end))
    ) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return anomaly("invalid_json");
    }
    thinkingValue = parsed as Record<string, unknown>;
  }
  let clientMetadataValue: Record<string, unknown> | null = null;
  const clientMetadataToken = clientMetadataRange as ByteRange | null;
  if (clientMetadataToken) {
    const parsed = JSON.parse(
      RAW_DECODER.decode(bytes.subarray(clientMetadataToken.start, clientMetadataToken.end))
    ) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      clientMetadataValue = parsed as Record<string, unknown>;
    }
  }
  let metadataValue: Record<string, unknown> | null = null;
  const metadataToken = metadataRange as ByteRange | null;
  if (metadataToken) {
    const parsed = JSON.parse(
      RAW_DECODER.decode(bytes.subarray(metadataToken.start, metadataToken.end))
    ) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadataValue = parsed as Record<string, unknown>;
    }
    // 非对象 metadata：legacy 读取侧（parseMetadata）同样得 null，语义等价。
  }

  const fingerprintHash = computeFingerprintHash(bytes, fingerprintTexts);

  return {
    ok: true,
    bytes,
    fields,
    thinkingRange,
    thinkingValue,
    metadataValue,
    clientMetadataValue,
    facts,
    fingerprintHash,
  };
}

/** isProbeRequest 的词判定：trim + lower 后精确匹配 "foo"/"count"。 */
function isProbeWord(decoded: string | FastBodyAnomalyReason): boolean {
  if (typeof decoded !== "string") return false;
  if (decoded.length > 40) return false; // 目标词 ≤5 字符；超长直接排除
  const trimmed = decoded.trim().toLowerCase();
  return trimmed === "foo" || trimmed === "count";
}

/**
 * 与 legacy extractInitialMessageTextHash bit-exact 的指纹计算：
 * texts.join("|") 的 UTF-8 字节 → sha256 → hex 前 16 位。
 * 原始段零拷贝；转义段按码点重编码（未配对代理 → U+FFFD，与 Node 的
 * Buffer.from(str, "utf8") 语义一致）。
 */
function computeFingerprintHash(bytes: Uint8Array, texts: FingerprintTextRange[][]): string | null {
  if (texts.length === 0) return null;
  const hash = createHash("sha256");
  const escapeBuffer = new Uint8Array(512);
  let escapeLength = 0;
  let pendingHighSurrogate: number | null = null;

  const flushEscapes = (): void => {
    if (escapeLength > 0) {
      hash.update(escapeBuffer.subarray(0, escapeLength));
      escapeLength = 0;
    }
  };

  /** 悬挂的高代理折算 U+FFFD（未等到低代理即遇到其他字节/结束）。 */
  const resolvePendingSurrogate = (): void => {
    if (pendingHighSurrogate !== null) {
      pendingHighSurrogate = null;
      feedUtf8(0xfffd);
    }
  };

  /** raw 段直喂前必须先落盘悬挂代理与已累积转义——否则字节顺序错乱。 */
  const flushRaw = (chunk: Uint8Array): void => {
    resolvePendingSurrogate();
    flushEscapes();
    hash.update(chunk);
  };

  const feedUtf8 = (codePoint: number): void => {
    if (codePoint < 0x80) {
      escapeBuffer[escapeLength] = codePoint;
      escapeLength += 1;
    } else if (codePoint < 0x800) {
      escapeBuffer[escapeLength] = 0xc0 | (codePoint >> 6);
      escapeBuffer[escapeLength + 1] = 0x80 | (codePoint & 0x3f);
      escapeLength += 2;
    } else if (codePoint < 0x10000) {
      escapeBuffer[escapeLength] = 0xe0 | (codePoint >> 12);
      escapeBuffer[escapeLength + 1] = 0x80 | ((codePoint >> 6) & 0x3f);
      escapeBuffer[escapeLength + 2] = 0x80 | (codePoint & 0x3f);
      escapeLength += 3;
    } else {
      escapeBuffer[escapeLength] = 0xf0 | (codePoint >> 18);
      escapeBuffer[escapeLength + 1] = 0x80 | ((codePoint >> 12) & 0x3f);
      escapeBuffer[escapeLength + 2] = 0x80 | ((codePoint >> 6) & 0x3f);
      escapeBuffer[escapeLength + 3] = 0x80 | (codePoint & 0x3f);
      escapeLength += 4;
    }
    if (escapeLength >= 256) flushEscapes();
  };

  const feedCodePoint = (codeUnit: number): void => {
    // 代理对组合：高代理等待低代理；未配对折算 U+FFFD（Node UTF-8 编码语义）。
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      pendingHighSurrogate = codeUnit;
      return;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      if (pendingHighSurrogate !== null) {
        const combined = 0x10000 + ((pendingHighSurrogate - 0xd800) << 10) + (codeUnit - 0xdc00);
        pendingHighSurrogate = null;
        feedUtf8(combined);
        return;
      }
      feedUtf8(0xfffd);
      return;
    }
    if (pendingHighSurrogate !== null) {
      pendingHighSurrogate = null;
      feedUtf8(0xfffd);
    }
    feedUtf8(codeUnit);
  };

  const feedRange = (range: FingerprintTextRange): void => {
    let runStart = range.start;
    let p = range.start;
    while (p < range.end) {
      if (bytes[p] !== 0x5c) {
        p += 1;
        continue;
      }
      if (p > runStart) {
        flushRaw(bytes.subarray(runStart, p));
      }
      const e = bytes[p + 1];
      if (e === 0x75) {
        let code = 0;
        for (let h = 0; h < 4; h++) {
          code = code * 16 + hexValue(bytes[p + 2 + h]);
        }
        feedCodePoint(code);
        p += 6;
      } else {
        switch (e) {
          case 0x22:
            feedCodePoint(0x22);
            break;
          case 0x5c:
            feedCodePoint(0x5c);
            break;
          case 0x2f:
            feedCodePoint(0x2f);
            break;
          case 0x62:
            feedCodePoint(0x08);
            break;
          case 0x66:
            feedCodePoint(0x0c);
            break;
          case 0x6e:
            feedCodePoint(0x0a);
            break;
          case 0x72:
            feedCodePoint(0x0d);
            break;
          case 0x74:
            feedCodePoint(0x09);
            break;
        }
        p += 2;
      }
      runStart = p;
    }
    if (p > runStart) {
      flushRaw(bytes.subarray(runStart, p));
    }
  };

  for (let t = 0; t < texts.length; t++) {
    if (t > 0) feedCodePoint(0x7c); // "|"
    for (const range of texts[t]) feedRange(range);
  }
  // 文本末尾悬挂的高代理（未等到低代理）折算 U+FFFD——与 Node 对字符串做
  // UTF-8 编码的语义一致。
  resolvePendingSurrogate();
  flushEscapes();
  return hash.digest("hex").substring(0, 16);
}
