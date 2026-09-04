/**
 * fast-body 对拍语料生成器：随机 codex 形状 AST + 可控序列化器
 * （随机转义形式 + 随机 token 间空白）。被 body-scanner 差分测试与调试探针共用。
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHORT_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "/": "\\/",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

export function serializeStringForFuzz(value: string, rng: Rng): string {
  let out = '"';
  for (let k = 0; k < value.length; k++) {
    const ch = value[k];
    const code = value.charCodeAt(k);
    if (SHORT_ESCAPES[ch] && rng() < 0.7) {
      out += SHORT_ESCAPES[ch];
    } else if (code < 0x20) {
      out +=
        rng() < 0.5 && SHORT_ESCAPES[ch]
          ? SHORT_ESCAPES[ch]
          : `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (code >= 0x20 && code < 0x7f && ch !== '"' && ch !== "\\" && rng() < 0.12) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function serializeWs(rng: Rng): string {
  if (rng() < 0.6) return "";
  const choices = [" ", "  ", "\n", "\t", "\r\n", "\t "];
  return choices[Math.floor(rng() * choices.length)];
}

export function serializeValueForFuzz(value: unknown, rng: Rng): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return serializeStringForFuzz(value, rng);
  if (Array.isArray(value)) {
    let out = "[";
    for (let k = 0; k < value.length; k++) {
      if (k > 0) out += `,${serializeWs(rng)}`;
      out += serializeWs(rng) + serializeValueForFuzz(value[k], rng) + serializeWs(rng);
    }
    return out + serializeWs(rng) + "]";
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    let out = "{";
    for (let k = 0; k < entries.length; k++) {
      if (k > 0) out += `,${serializeWs(rng)}`;
      // 键不做 \uXXXX 转义：真实客户端（JSON.stringify）不转义键内字母数字，
      // 而扫描器按设计对"键内转义"回退（legacy JSON.parse 会把 "\u006d" 当 'm'，
      // 字节比较不等价——回退即 parity，语料不应生成这种形态）。
      out +=
        serializeWs(rng) +
        JSON.stringify(entries[k][0]) +
        serializeWs(rng) +
        ":" +
        serializeWs(rng) +
        serializeValueForFuzz(entries[k][1], rng) +
        serializeWs(rng);
    }
    return out + serializeWs(rng) + "}";
  }
  throw new Error(`unsupported generator value: ${typeof value}`);
}

const TEXT_SAMPLES = [
  "hello world",
  "line1\nline2\ttabbed",
  'quotes " and backslash \\ inside',
  "中文混合 english 文本",
  "emoji 😀🚀 astral",
  "lone surrogate \ud800 here",
  "surrogate pair \ud83d\ude00 pair",
  "   \t\n  ",
  "",
  "nbsp\u00a0and\u3000ideo\u2028space",
  "escaped nbsp \u00a0",
  "control \u0001\u001f chars",
  "/slash/ and //",
  "del \u007f char",
];

export function randomText(rng: Rng): string {
  const pick = Math.floor(rng() * 4);
  if (pick === 0) return TEXT_SAMPLES[Math.floor(rng() * TEXT_SAMPLES.length)];
  if (pick === 1) {
    const length = Math.floor(rng() * 12);
    let out = "";
    for (let k = 0; k < length; k++) {
      out += TEXT_SAMPLES[Math.floor(rng() * TEXT_SAMPLES.length)];
    }
    return out;
  }
  if (pick === 2) return `code ${Math.floor(rng() * 1000)}`;
  return "x".repeat(Math.floor(rng() * 50));
}

const ITEM_TYPES = [
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "local_shell_call",
  "web_search_call",
  "",
];

function randomContentParts(rng: Rng): unknown[] {
  const count = Math.floor(rng() * 4);
  const parts: unknown[] = [];
  for (let k = 0; k < count; k++) {
    const roll = rng();
    if (roll < 0.55) {
      parts.push({ type: "input_text", text: randomText(rng) });
    } else if (roll < 0.7) {
      parts.push({ type: "output_text", text: randomText(rng) });
    } else if (roll < 0.8) {
      parts.push({ type: "input_image", image_url: "data:image/png;base64,AAAA" });
    } else if (roll < 0.9) {
      parts.push({ text: randomText(rng) });
    } else {
      parts.push({ type: "input_text" });
    }
  }
  return parts;
}

export function randomItem(rng: Rng): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  const roll = rng();
  if (roll < 0.8) {
    const typeRoll = rng();
    if (typeRoll < 0.7) item.type = ITEM_TYPES[Math.floor(rng() * ITEM_TYPES.length)];
    else if (typeRoll < 0.85) item.type = Math.floor(rng() * 100);
  }
  if (rng() < 0.85) {
    const contentRoll = rng();
    if (contentRoll < 0.5) item.content = randomText(rng);
    else if (contentRoll < 0.9) item.content = randomContentParts(rng);
    else item.content = rng() < 0.5 ? null : 42;
  }
  if (rng() < 0.3) item.role = "user";
  if (rng() < 0.2) item.id = `item_${Math.floor(rng() * 1000)}`;
  return item;
}

export function randomCodexBody(rng: Rng): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  body.model = rng() < 0.9 ? `gpt-5.${Math.floor(rng() * 9)}-codex` : 42;
  if (rng() < 0.9) body.stream = rng() < 0.8;
  if (rng() < 0.3) body.instructions = randomText(rng);
  if (rng() < 0.2) body.service_tier = rng() < 0.5 ? "priority" : "auto";
  if (rng() < 0.4)
    body.prompt_cache_key = `11111111-2222-4333-8444-55555555555${Math.floor(rng() * 10)}`;
  if (rng() < 0.3) body.max_tokens = Math.floor(rng() * 100000);
  if (rng() < 0.2) body.temperature = rng() * 2;
  if (rng() < 0.2) body.top_p = rng();
  if (rng() < 0.25) body.reasoning_effort = "medium";
  if (rng() < 0.2) body.previous_response_id = `resp_${Math.floor(rng() * 1e9)}`;
  if (rng() < 0.15) body.thinking = { type: "enabled", budget_tokens: 32000 };
  if (rng() < 0.15)
    body.metadata = { session_id: `22222222-3333-4444-8555-66666666666${Math.floor(rng() * 10)}` };
  const inputCount = Math.floor(rng() * 7);
  const input: unknown[] = [];
  for (let k = 0; k < inputCount; k++) {
    const roll = rng();
    if (roll < 0.85) input.push(randomItem(rng));
    else if (roll < 0.95) input.push(randomText(rng));
    else input.push(rng() < 0.5 ? null : Math.floor(rng() * 100));
  }
  body.input = input;
  if (rng() < 0.3) {
    body.tools = [{ type: "function", name: "demo", parameters: { type: "object" } }];
  }
  if (rng() < 0.2) body.store = false;
  return body;
}

export function mutateText(text: string, rng: Rng): string {
  const mutations = 1 + Math.floor(rng() * 2);
  let out = text;
  for (let k = 0; k < mutations; k++) {
    const position = Math.floor(rng() * out.length);
    const roll = rng();
    if (roll < 0.25) {
      out = out.slice(0, position);
    } else if (roll < 0.45) {
      out = out.slice(0, position) + out.slice(position + 1);
    } else if (roll < 0.7) {
      const junk = ["x", ",", "}", "]", '"', ":", " ", "\\", " ", "}\n\n"][Math.floor(rng() * 10)];
      out = out.slice(0, position) + junk + out.slice(position);
    } else {
      if (position + 1 < out.length) {
        out = out.slice(0, position) + out[position + 1] + out[position] + out.slice(position + 2);
      }
    }
  }
  return out;
}
