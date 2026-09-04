import { createHash } from "node:crypto";
import type {
  ReviewCapability,
  ReviewContentPart,
  ReviewContextItem,
  ReviewCoverageNotice,
  ReviewRequestEnvelope,
} from "./types";

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "background",
  "client_metadata",
  "context_management",
  "conversation",
  "generate",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "modalities",
  "model",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning",
  "safety_identifier",
  "service_tier",
  "store",
  "stream",
  "stream_options",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_logprobs",
  "top_p",
  "truncation",
  "type",
  "user",
]);

const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);

export interface ReviewProjectionIdentity {
  requestId: string;
  principalId: string;
  sessionId: string;
  sequence: number;
}

export interface ReviewProjectionInput {
  identity: ReviewProjectionIdentity;
  /** legacy 调用方传入的最终树；快速路径可缺省（从 bodyBytes 惰性解析）。 */
  message?: Record<string, unknown> | null;
  /** legacy 调用方传入的最终序列化串。 */
  bodyString?: string | null;
  /** 快速路径：最终出站字节。存在时 sha256/byteLength 直接计量，message 惰性解析。 */
  bodyBytes?: Uint8Array | null;
}

export class ReviewProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewProjectionError";
  }
}

interface ProjectionState {
  items: ReviewContextItem[];
  capabilities: ReviewCapability[];
  notices: ReviewCoverageNotice[];
  noticeKeys: Set<string>;
}

const PROJECTION_DECODER = new TextDecoder();

export function projectFinalResponsesRequest({
  identity,
  message: messageInput,
  bodyString,
  bodyBytes,
}: ReviewProjectionInput): ReviewRequestEnvelope {
  // 快速路径：字节直供（零额外字符串物化），树按需惰性解析——解析发生在
  // 投影序章（本函数）内，返回后即不可达，与既有作用域纪律一致。
  let message = messageInput ?? null;
  if (message === null && bodyBytes != null && bodyBytes.byteLength > 0) {
    try {
      message = JSON.parse(PROJECTION_DECODER.decode(bodyBytes)) as Record<string, unknown>;
    } catch {
      throw new ReviewProjectionError("final Responses request body is not valid JSON");
    }
  }
  const hasBody = (bodyBytes != null && bodyBytes.byteLength > 0) || !!bodyString;
  if (!message || typeof message !== "object") {
    throw new ReviewProjectionError("final Responses request has no parsable body");
  }
  const model = asNonEmptyString(message.model);
  if (!model) {
    throw new ReviewProjectionError("final Responses request has no model");
  }
  if (!hasBody) {
    throw new ReviewProjectionError("final Responses request body is empty");
  }
  if (!Number.isSafeInteger(identity.sequence) || identity.sequence <= 0) {
    throw new ReviewProjectionError("request sequence is unavailable");
  }

  for (const [name, value] of Object.entries({
    requestId: identity.requestId,
    principalId: identity.principalId,
    sessionId: identity.sessionId,
  })) {
    if (!value) {
      throw new ReviewProjectionError(`${name} is unavailable`);
    }
  }

  const state: ProjectionState = {
    items: [],
    capabilities: [],
    notices: [],
    noticeKeys: new Set(),
  };

  const instructions = [];
  if (typeof message.instructions === "string") {
    instructions.push({
      origin: "developer" as const,
      content: [textPart(message.instructions)],
    });
  } else if (message.instructions !== undefined && message.instructions !== null) {
    addNotice(state, "unsupported_top_level_field", undefined, "instructions");
  }

  projectInput(message.input, state);
  projectTopLevelTools(message.tools, state);

  for (const field of Object.keys(message)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(field)) {
      addNotice(state, "unsupported_top_level_field", undefined, field);
    }
  }

  const references: Array<"previous_response" | "conversation" | "prompt_template"> = [];
  if (asNonEmptyString(message.previous_response_id)) references.push("previous_response");
  if (message.conversation !== undefined && message.conversation !== null) {
    references.push("conversation");
  }
  if (message.prompt !== undefined && message.prompt !== null) references.push("prompt_template");

  const bodySha256 =
    bodyBytes != null
      ? createHash("sha256").update(bodyBytes).digest("hex")
      : createHash("sha256")
          .update(bodyString ?? "")
          .digest("hex");
  const clientInstanceId = extractClientInstanceId(message.client_metadata);
  return {
    schema_version: "cyber-check.request-review.v1",
    identity: {
      request_id: `${identity.requestId}:${bodySha256}`,
      principal_id: identity.principalId,
      ...(clientInstanceId ? { client_instance_id: clientInstanceId } : {}),
      session_id: identity.sessionId,
      sequence: identity.sequence,
    },
    source: {
      protocol: "openai.responses",
      profile: "codex-http-sse",
      model,
      context_state:
        references.length === 0 ? { type: "self_contained" } : { type: "referenced", references },
      body_sha256: bodySha256,
      body_bytes: bodyBytes != null ? bodyBytes.byteLength : Buffer.byteLength(bodyString ?? ""),
    },
    instructions,
    items: state.items,
    capabilities: state.capabilities,
    coverage: { notices: state.notices },
  };
}

function extractClientInstanceId(clientMetadata: unknown): string | undefined {
  const value = asRecord(clientMetadata)?.["x-codex-installation-id"];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\r") ||
    value.includes("\n") ||
    Buffer.byteLength(value) > 256
  ) {
    return undefined;
  }
  return value;
}

function projectInput(input: unknown, state: ProjectionState): void {
  if (typeof input === "string") {
    state.items.push({
      source_type: "message",
      origin: "user",
      content: [textPart(input)],
    });
    return;
  }
  if (!Array.isArray(input)) {
    if (input !== undefined && input !== null) {
      addNotice(state, "unsupported_top_level_field", undefined, "input");
    }
    return;
  }

  for (const rawItem of input) {
    const itemIndex = state.items.length;
    const item = projectItem(rawItem, itemIndex, state);
    state.items.push(item);
  }
}

function projectItem(
  rawItem: unknown,
  itemIndex: number,
  state: ProjectionState
): ReviewContextItem {
  if (typeof rawItem === "string") {
    return { source_type: "message", origin: "user", content: [textPart(rawItem)] };
  }
  const item = asRecord(rawItem);
  if (!item) {
    addNotice(state, "unsupported_item_type", itemIndex);
    return unsupportedItem("non_object", "user");
  }

  const type = typeof item.type === "string" ? item.type : undefined;
  if (type === "message" || (!type && typeof item.role === "string")) {
    return projectMessage(item, itemIndex, state);
  }

  switch (type) {
    case "additional_tools":
      return projectAdditionalTools(item, itemIndex, state);
    case "reasoning":
      return projectReasoning(item, itemIndex, state);
    case "function_call":
      return projectCall("function_call", item, itemIndex, state);
    case "function_call_output":
      return projectCallOutput("function_call_output", item, itemIndex, state);
    case "custom_tool_call":
      return projectCall("custom_tool_call", item, itemIndex, state);
    case "custom_tool_call_output":
      return projectCallOutput("custom_tool_call_output", item, itemIndex, state);
    case "mcp_call":
    case "mcp_tool_call":
      return projectCall("mcp_tool_call", item, itemIndex, state);
    case "mcp_call_output":
    case "mcp_tool_call_output":
      return projectCallOutput("mcp_tool_call_output", item, itemIndex, state);
    case "tool_search_call":
      return projectGenericCall("tool_search_call", item);
    case "tool_search_output":
      return projectGenericOutput("tool_search_output", item);
    case "local_shell_call":
      return projectGenericCall("local_shell_call", item);
    case "web_search_call":
      return projectGenericCall("web_search_call", item);
    case "image_generation_call":
      return projectGenericCall("image_generation_call", item);
    case "compaction":
      return projectCompaction("compaction", item, itemIndex, state);
    case "context_compaction":
      return projectCompaction("context_compaction", item, itemIndex, state);
    default:
      addNotice(state, "unsupported_item_type", itemIndex);
      return unsupportedItem(safeTypeLabel(type), inferOrigin(item.role));
  }
}

function projectMessage(
  item: Record<string, unknown>,
  itemIndex: number,
  state: ProjectionState
): ReviewContextItem {
  const origin = inferOrigin(item.role);
  if (origin === "tool" || !isMessageRole(item.role)) {
    addNotice(state, "unsupported_item_type", itemIndex);
    return unsupportedItem("message_with_unsupported_role", origin);
  }
  const content = projectContent(item.content, itemIndex, state);
  const itemId = asNonEmptyString(item.id);
  return {
    source_type: origin === "assistant" ? "assistant_message" : "message",
    origin,
    ...(itemId ? { linkage: { item_id: itemId } } : {}),
    content,
  };
}

function projectAdditionalTools(
  item: Record<string, unknown>,
  itemIndex: number,
  state: ProjectionState
): ReviewContextItem {
  if (Array.isArray(item.tools)) {
    for (const definition of item.tools) {
      const record = asRecord(definition);
      if (record) {
        state.capabilities.push({ source: "additional_tools", definition: record });
      } else {
        addNotice(state, "unsupported_content_type", itemIndex);
      }
    }
  } else {
    addNotice(state, "unsupported_content_type", itemIndex);
  }
  return { source_type: "additional_tools", origin: "developer", content: [] };
}

function projectReasoning(
  item: Record<string, unknown>,
  itemIndex: number,
  state: ProjectionState
): ReviewContextItem {
  const content: ReviewContentPart[] = [];
  const summary = Array.isArray(item.summary) ? item.summary : [];
  for (const part of summary) {
    const record = asRecord(part);
    if (record && typeof record.text === "string") content.push(textPart(record.text));
  }

  if (typeof item.encrypted_content === "string") {
    content.push({ type: "opaque", kind: "encrypted_reasoning" });
    addNotice(state, "encrypted_reasoning_omitted", itemIndex);
  } else {
    content.push({ type: "opaque", kind: "plaintext_reasoning_omitted" });
    addNotice(state, "plaintext_reasoning_omitted", itemIndex);
  }

  const itemId = asNonEmptyString(item.id);
  return {
    source_type: "reasoning",
    origin: "assistant",
    ...(itemId ? { linkage: { item_id: itemId } } : {}),
    content,
  };
}

function projectCall(
  sourceType: "function_call" | "custom_tool_call" | "mcp_tool_call",
  item: Record<string, unknown>,
  itemIndex: number,
  state: ProjectionState
): ReviewContextItem {
  const callId = asNonEmptyString(item.call_id);
  const name =
    asNonEmptyString(item.name) ?? asNonEmptyString(asRecord(item.function)?.name) ?? undefined;
  if (!callId || !name) {
    addNotice(state, "unsupported_item_type", itemIndex);
    return unsupportedItem(safeTypeLabel(item.type), "assistant");
  }

  const argumentsValue =
    item.arguments ?? item.input ?? asRecord(item.function)?.arguments ?? item.action;
  return {
    source_type: sourceType,
    origin: "assistant",
    linkage: {
      ...(asNonEmptyString(item.id) ? { item_id: asNonEmptyString(item.id) } : {}),
      call_id: callId,
      name,
      ...(asNonEmptyString(item.namespace) ? { namespace: asNonEmptyString(item.namespace) } : {}),
    },
    content: valueParts(argumentsValue, true),
  };
}

function projectCallOutput(
  sourceType: "function_call_output" | "custom_tool_call_output" | "mcp_tool_call_output",
  item: Record<string, unknown>,
  itemIndex: number,
  state: ProjectionState
): ReviewContextItem {
  const callId = asNonEmptyString(item.call_id);
  if (!callId) {
    addNotice(state, "unsupported_item_type", itemIndex);
    return unsupportedItem(safeTypeLabel(item.type), "tool");
  }
  return {
    source_type: sourceType,
    origin: "tool",
    linkage: {
      ...(asNonEmptyString(item.id) ? { item_id: asNonEmptyString(item.id) } : {}),
      call_id: callId,
    },
    content: valueParts(item.output, false),
  };
}

function projectGenericCall(
  sourceType: "tool_search_call" | "local_shell_call" | "web_search_call" | "image_generation_call",
  item: Record<string, unknown>
): ReviewContextItem {
  const itemId = asNonEmptyString(item.id);
  const callId = asNonEmptyString(item.call_id);
  const name = asNonEmptyString(item.name);
  const payload = item.arguments ?? item.input ?? item.action ?? item.query;
  return {
    source_type: sourceType,
    origin: "assistant",
    ...(itemId || callId || name
      ? {
          linkage: {
            ...(itemId ? { item_id: itemId } : {}),
            ...(callId ? { call_id: callId } : {}),
            ...(name ? { name } : {}),
          },
        }
      : {}),
    content: valueParts(payload, true),
  };
}

function projectGenericOutput(
  sourceType: "tool_search_output",
  item: Record<string, unknown>
): ReviewContextItem {
  const itemId = asNonEmptyString(item.id);
  const callId = asNonEmptyString(item.call_id);
  return {
    source_type: sourceType,
    origin: "tool",
    ...(itemId || callId
      ? {
          linkage: {
            ...(itemId ? { item_id: itemId } : {}),
            ...(callId ? { call_id: callId } : {}),
          },
        }
      : {}),
    content: valueParts(item.output, false),
  };
}

function projectCompaction(
  sourceType: "compaction" | "context_compaction",
  item: Record<string, unknown>,
  itemIndex: number,
  state: ProjectionState
): ReviewContextItem {
  const itemId = asNonEmptyString(item.id);
  const encrypted = typeof item.encrypted_content === "string";
  if (!encrypted) addNotice(state, "unsupported_content_type", itemIndex);
  return {
    source_type: sourceType,
    origin: "assistant",
    ...(itemId ? { linkage: { item_id: itemId } } : {}),
    content: encrypted ? [{ type: "opaque", kind: "encrypted_compaction" }] : [],
  };
}

function projectTopLevelTools(tools: unknown, state: ProjectionState): void {
  if (tools === undefined || tools === null) return;
  if (!Array.isArray(tools)) {
    addNotice(state, "unsupported_top_level_field", undefined, "tools");
    return;
  }
  for (const definition of tools) {
    const record = asRecord(definition);
    if (record) {
      state.capabilities.push({ source: "top_level_tools", definition: record });
    } else {
      addNotice(state, "unsupported_top_level_field", undefined, "tools");
    }
  }
}

function projectContent(
  content: unknown,
  itemIndex: number,
  state: ProjectionState
): ReviewContentPart[] {
  if (typeof content === "string") return [textPart(content)];
  if (!Array.isArray(content)) {
    if (content !== undefined && content !== null) {
      addNotice(state, "unsupported_content_type", itemIndex);
    }
    return [];
  }

  const parts: ReviewContentPart[] = [];
  for (const rawPart of content) {
    const part = asRecord(rawPart);
    if (!part) {
      addNotice(state, "unsupported_content_type", itemIndex);
      continue;
    }
    const type = typeof part.type === "string" ? part.type : undefined;
    if (
      (type === "input_text" || type === "output_text" || type === "text") &&
      typeof part.text === "string"
    ) {
      parts.push(textPart(part.text));
      continue;
    }
    if ((type === "input_json" || type === "json") && part.value !== undefined) {
      parts.push({ type: "json", value: part.value });
      continue;
    }
    if (type === "input_image") {
      const media = projectImage(part);
      if (media) parts.push(media);
      else addNotice(state, "unsupported_content_type", itemIndex);
      continue;
    }
    if (type === "input_audio") {
      const media = projectAudio(part);
      if (media) parts.push(media);
      else addNotice(state, "unsupported_content_type", itemIndex);
      continue;
    }
    addNotice(state, "unsupported_content_type", itemIndex);
  }
  return parts;
}

function projectImage(part: Record<string, unknown>): ReviewContentPart | null {
  const imageUrl = asNonEmptyString(part.image_url);
  const fileId = asNonEmptyString(part.file_id);
  const detail =
    typeof part.detail === "string" && IMAGE_DETAILS.has(part.detail) ? part.detail : null;

  if (imageUrl?.startsWith("data:")) {
    const data = parseDataUrl(imageUrl, "image/");
    if (!data) return null;
    return {
      type: "inline_media",
      modality: "image",
      mime_type: data.mimeType,
      data_base64: data.dataBase64,
      ...(detail ? { detail: detail as "auto" | "low" | "high" | "original" } : {}),
    };
  }
  if (imageUrl) {
    return { type: "unresolved_media", modality: "image", reference_type: "remote_url" };
  }
  if (fileId) {
    return { type: "unresolved_media", modality: "image", reference_type: "file_id" };
  }
  return null;
}

function projectAudio(part: Record<string, unknown>): ReviewContentPart | null {
  const inputAudio = asRecord(part.input_audio);
  const dataBase64 =
    asNonEmptyString(part.data) ?? (inputAudio ? asNonEmptyString(inputAudio.data) : undefined);
  const format =
    asNonEmptyString(part.format) ?? (inputAudio ? asNonEmptyString(inputAudio.format) : undefined);
  if (dataBase64 && format) {
    const normalizedFormat = format.toLowerCase();
    const mimeType = normalizedFormat.includes("/")
      ? normalizedFormat
      : `audio/${normalizedFormat}`;
    return {
      type: "inline_media",
      modality: "audio",
      mime_type: mimeType,
      data_base64: dataBase64,
    };
  }
  if (asNonEmptyString(part.file_id)) {
    return { type: "unresolved_media", modality: "audio", reference_type: "file_id" };
  }
  return null;
}

function parseDataUrl(
  value: string,
  expectedMimePrefix: string
): { mimeType: string; dataBase64: string } | null {
  const separator = value.indexOf(",");
  if (separator <= 5) return null;
  const metadata = value.slice(5, separator);
  const segments = metadata.split(";");
  const mimeType = segments[0]?.toLowerCase();
  if (!mimeType?.startsWith(expectedMimePrefix) || !segments.includes("base64")) return null;
  const dataBase64 = value.slice(separator + 1);
  if (!dataBase64) return null;
  return { mimeType, dataBase64 };
}

function valueParts(value: unknown, jsonString: boolean): ReviewContentPart[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [textPart(value, jsonString ? "json" : "plain")];
  return [{ type: "json", value }];
}

function textPart(text: string, format: "plain" | "json" = "plain"): ReviewContentPart {
  return { type: "text", text, format };
}

function unsupportedItem(
  sourceType: string,
  origin: ReviewContextItem["origin"]
): ReviewContextItem {
  return {
    source_type: "unsupported",
    unsupported_source_type: sourceType,
    origin,
    content: [],
  };
}

function inferOrigin(role: unknown): ReviewContextItem["origin"] {
  switch (role) {
    case "system":
    case "developer":
    case "user":
    case "assistant":
    case "tool":
      return role;
    default:
      return "user";
  }
}

function isMessageRole(role: unknown): role is "system" | "developer" | "user" | "assistant" {
  return role === "system" || role === "developer" || role === "user" || role === "assistant";
}

function safeTypeLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\r\n]/.test(value)
  ) {
    return "unknown";
  }
  return value;
}

function addNotice(
  state: ProjectionState,
  code: ReviewCoverageNotice["code"],
  itemIndex?: number,
  field?: string
): void {
  const key = `${code}:${itemIndex ?? "top"}:${field ?? ""}`;
  if (state.noticeKeys.has(key)) return;
  state.noticeKeys.add(key);
  state.notices.push({
    code,
    ...(itemIndex === undefined ? {} : { item_index: itemIndex }),
    ...(field === undefined ? {} : { field }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
