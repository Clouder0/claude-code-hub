import { detectUpstreamErrorFromSseOrJsonText } from "@/lib/utils/upstream-error-detection";

export const DEFAULT_STREAMING_RESPONSE_PREFIX_LIMIT_BYTES = 32 * 1024;

export type StreamingResponsePrefixInspection =
  | { kind: "pass"; response: Response }
  | {
      kind: "fake_200";
      code: string;
      detail?: string;
      rawText: string;
      rawBodyTruncated: boolean;
    };

type InspectStreamingResponsePrefixOptions = {
  maxBytes?: number;
};

type PrefixDecision =
  | { kind: "need_more" }
  | { kind: "pass" }
  | { kind: "fake_200"; code: string; detail?: string };

function findSseEventBoundary(text: string, start: number): { end: number; next: number } | null {
  const match = /\r\n\r\n|\n\r\n|\r\n\n|\n\n|\r\r/gu.exec(text.slice(start));
  if (!match || match.index === undefined) return null;
  const end = start + match.index;
  return { end, next: end + match[0].length };
}

function hasSseDataLine(eventText: string): boolean {
  return eventText.split(/\r\n|\n|\r/u).some((line) => line.startsWith("data:"));
}

function inspectCompletePayload(text: string, eof: boolean): PrefixDecision {
  let trimmed = text.trimStart();
  if (trimmed.charCodeAt(0) === 0xfeff) {
    trimmed = trimmed.slice(1).trimStart();
  }

  if (trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
    } catch {
      return eof ? { kind: "pass" } : { kind: "need_more" };
    }

    const detected = detectUpstreamErrorFromSseOrJsonText(trimmed);
    return detected.isError
      ? { kind: "fake_200", code: detected.code, detail: detected.detail }
      : { kind: "pass" };
  }

  let eventStart = 0;
  while (true) {
    const boundary = findSseEventBoundary(text, eventStart);
    if (!boundary) break;
    const eventText = text.slice(eventStart, boundary.end);
    eventStart = boundary.next;
    if (!hasSseDataLine(eventText)) continue;

    const detected = detectUpstreamErrorFromSseOrJsonText(eventText);
    return detected.isError
      ? { kind: "fake_200", code: detected.code, detail: detected.detail }
      : { kind: "pass" };
  }

  if (eof) {
    const remaining = text.slice(eventStart);
    if (hasSseDataLine(remaining)) {
      const detected = detectUpstreamErrorFromSseOrJsonText(remaining);
      return detected.isError
        ? { kind: "fake_200", code: detected.code, detail: detected.detail }
        : { kind: "pass" };
    }
    return { kind: "pass" };
  }

  return { kind: "need_more" };
}

function replayResponse(
  response: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefixChunks: Uint8Array[]
): Response {
  let prefixIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefixChunks.length) {
        controller.enqueue(prefixChunks[prefixIndex]);
        prefixIndex += 1;
        return;
      }

      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function inspectStreamingResponsePrefix(
  response: Response,
  options: InspectStreamingResponsePrefixOptions = {}
): Promise<StreamingResponsePrefixInspection> {
  if (!response.body) {
    return { kind: "pass", response };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_STREAMING_RESPONSE_PREFIX_LIMIT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const reader = response.body.getReader();
  const prefixChunks: Uint8Array[] = [];
  let bufferedBytes = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) {
      const rawText = new TextDecoder().decode(concatChunks(prefixChunks, bufferedBytes));
      const decision = inspectCompletePayload(rawText, true);
      if (decision.kind === "fake_200") {
        return {
          ...decision,
          rawText,
          rawBodyTruncated: false,
        };
      }
      return { kind: "pass", response: replayResponse(response, reader, prefixChunks) };
    }

    const chunk = next.value.slice();
    prefixChunks.push(chunk);
    bufferedBytes += chunk.byteLength;

    const inspectedBytes = concatChunks(prefixChunks, Math.min(bufferedBytes, maxBytes));
    const rawText = new TextDecoder().decode(inspectedBytes);
    const decision = inspectCompletePayload(rawText, false);
    if (decision.kind === "fake_200") {
      await reader.cancel("fake_200").catch(() => undefined);
      return {
        ...decision,
        rawText,
        rawBodyTruncated: true,
      };
    }
    if (decision.kind === "pass" || bufferedBytes >= maxBytes) {
      return { kind: "pass", response: replayResponse(response, reader, prefixChunks) };
    }
  }
}

function concatChunks(chunks: Uint8Array[], maxBytes: number): Uint8Array {
  const output = new Uint8Array(maxBytes);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= maxBytes) break;
    const remaining = maxBytes - offset;
    const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    output.set(slice, offset);
    offset += slice.byteLength;
  }
  return offset === output.byteLength ? output : output.slice(0, offset);
}
