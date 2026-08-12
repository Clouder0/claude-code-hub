export type ResponsesFrameVerdict = "content" | "error" | "malformed" | "terminal" | "neutral";

export type ResponsesFrameClassification = {
  verdict: ResponsesFrameVerdict;
  eventType: string | null;
};

const REQUEST_ECHO_EVENTS = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
]);

const ERROR_EVENTS = new Set(["error", "response.error", "response.failed"]);
const TERMINAL_EVENTS = new Set(["response.completed", "response.incomplete", "response.done"]);

const DELTA_CONTENT_EVENTS = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
  "response.audio.delta",
  "response.audio.transcript.delta",
  "response.function_call_arguments.delta",
  "response.custom_tool_call_input.delta",
  "response.code_interpreter_call_code.delta",
  "response.mcp_call_arguments.delta",
]);

const TEXT_DONE_EVENTS = new Set([
  "response.output_text.done",
  "response.reasoning_text.done",
  "response.reasoning_summary_text.done",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number" || value === true) return true;
  if (Array.isArray(value)) return value.some(isNonEmptyValue);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function resolveSegments(node: unknown, segments: string[], index: number): unknown {
  if (index === segments.length) return node;

  const segment = segments[index];
  if (segment === "#") {
    if (!Array.isArray(node)) return undefined;
    const collected: unknown[] = [];
    for (const item of node) {
      const resolved = resolveSegments(item, segments, index + 1);
      if (resolved === undefined) continue;
      if (Array.isArray(resolved) && segments.slice(index + 1).includes("#")) {
        collected.push(...resolved);
      } else {
        collected.push(resolved);
      }
    }
    return collected;
  }

  if (!isRecord(node)) return undefined;
  const child = node[segment];
  if (child === undefined) return undefined;
  return resolveSegments(child, segments, index + 1);
}

function hasAnyNonEmptyPath(parsed: unknown, paths: readonly string[]): boolean {
  return paths.some((path) => isNonEmptyValue(resolveSegments(parsed, path.split("."), 0)));
}

function effectiveEventType(
  eventName: string | null,
  parsed: Record<string, unknown> | unknown[]
): string | null {
  if (!Array.isArray(parsed) && typeof parsed.type === "string" && parsed.type.trim()) {
    return parsed.type.trim();
  }
  const fallback = eventName?.trim() ?? "";
  return fallback || null;
}

function isNonEmptyCompactionItem(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.type === "compaction" &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  );
}

function hasCompactionContent(eventType: string | null, parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (eventType === "response.output_item.done") {
    return isNonEmptyCompactionItem(parsed.item);
  }
  if (eventType !== "response.completed" || !isRecord(parsed.response)) return false;
  const output = parsed.response.output;
  return Array.isArray(output) && output.some(isNonEmptyCompactionItem);
}

function hasContent(eventType: string | null, parsed: unknown): boolean {
  if (!eventType) return false;

  if (DELTA_CONTENT_EVENTS.has(eventType)) {
    return hasAnyNonEmptyPath(parsed, ["delta"]);
  }
  if (eventType === "response.image_generation_call.partial_image") {
    return hasAnyNonEmptyPath(parsed, ["partial_image_b64"]);
  }
  if (TEXT_DONE_EVENTS.has(eventType)) {
    return hasAnyNonEmptyPath(parsed, ["text"]);
  }
  if (eventType === "response.audio.transcript.done") {
    return hasAnyNonEmptyPath(parsed, ["transcript", "text"]);
  }
  if (eventType === "response.refusal.done") {
    return hasAnyNonEmptyPath(parsed, ["refusal"]);
  }
  if (
    eventType === "response.function_call_arguments.done" ||
    eventType === "response.mcp_call_arguments.done"
  ) {
    return hasAnyNonEmptyPath(parsed, ["arguments"]);
  }
  if (eventType === "response.custom_tool_call_input.done") {
    return hasAnyNonEmptyPath(parsed, ["input"]);
  }
  if (eventType === "response.code_interpreter_call_code.done") {
    return hasAnyNonEmptyPath(parsed, ["code"]);
  }
  if (eventType === "response.content_part.added" || eventType === "response.content_part.done") {
    return hasAnyNonEmptyPath(parsed, [
      "part.text",
      "part.refusal",
      "part.audio.data",
      "part.audio.transcript",
    ]);
  }
  if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
    return hasAnyNonEmptyPath(parsed, [
      "item.content.#.text",
      "item.content.#.refusal",
      "item.summary.#.text",
      "item.arguments",
      "item.input",
      "item.action",
      "item.queries",
      "item.query",
      "item.code",
      "item.command",
      "item.operation",
      "item.result",
    ]);
  }
  return false;
}

/**
 * Classify one complete OpenAI Responses SSE frame by payload semantics.
 * The JSON payload type is authoritative over a conflicting SSE event field.
 */
export function classifyResponsesFrame(
  eventName: string | null,
  data: string
): ResponsesFrameClassification {
  const trimmed = data.trim();
  if (trimmed === "[DONE]") return { verdict: "terminal", eventType: null };
  if (trimmed.length === 0) return { verdict: "neutral", eventType: null };
  if (trimmed[0] !== "{" && trimmed[0] !== "[") {
    return { verdict: "malformed", eventType: eventName?.trim() || null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { verdict: "malformed", eventType: eventName?.trim() || null };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { verdict: "malformed", eventType: eventName?.trim() || null };
  }

  const eventType = effectiveEventType(eventName, parsed as Record<string, unknown> | unknown[]);
  if (
    (eventType !== null && ERROR_EVENTS.has(eventType)) ||
    (isRecord(parsed) &&
      (isNonEmptyValue(parsed.error) ||
        (isRecord(parsed.response) && isNonEmptyValue(parsed.response.error))))
  ) {
    return { verdict: "error", eventType };
  }
  if (hasCompactionContent(eventType, parsed) || hasContent(eventType, parsed)) {
    return { verdict: "content", eventType };
  }
  if (eventType !== null && TERMINAL_EVENTS.has(eventType)) {
    return { verdict: "terminal", eventType };
  }
  return { verdict: "neutral", eventType };
}

/**
 * Request lifecycle frames may echo the full request. This bounded prefix check
 * is also usable while a frame is incomplete, before JSON parsing is possible.
 */
export function isResponsesRequestEchoFrame(eventName: string | null, dataHead: string): boolean {
  const typeMatch = /"type"\s*:\s*"([^"]+)"/u.exec(dataHead);
  const eventType = typeMatch?.[1]?.trim() || eventName?.trim() || "";
  return REQUEST_ECHO_EVENTS.has(eventType);
}

export function isLegacyResponsesLifecycleEvent(eventType: string | null): boolean {
  return eventType !== null && REQUEST_ECHO_EVENTS.has(eventType);
}
