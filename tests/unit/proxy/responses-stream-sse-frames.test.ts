import { describe, expect, it } from "vitest";
import {
  parseSseBody,
  SseFrameBufferLimitError,
  SseFrameParser,
} from "@/app/v1/_lib/proxy/stream-gate/sse-frames";

function collect(parser: SseFrameParser, chunks: Uint8Array[]) {
  const frames = chunks.flatMap((chunk) => parser.push(chunk));
  return [...frames, ...parser.finish()];
}

describe("SseFrameParser", () => {
  it("parses comments, CRLF, multiline data, and an unterminated tail", () => {
    expect(
      parseSseBody(
        ': keepalive\r\nevent: response.metadata\r\ndata: {"type":"response.metadata",\r\ndata: "ok":true}\r\n\r\n' +
          'data: {"type":"response.completed"}'
      )
    ).toEqual([
      {
        eventName: "response.metadata",
        data: '{"type":"response.metadata",\n"ok":true}',
      },
      { eventName: null, data: '{"type":"response.completed"}' },
    ]);
  });

  it("is invariant to UTF-8 and CRLF chunk boundaries", () => {
    const body =
      'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"中文"}\r\n\r\n' +
      'data: {"type":"response.completed"}\n\n';
    const bytes = new TextEncoder().encode(body);
    const expected = parseSseBody(body);
    for (let split = 1; split < bytes.length; split += 1) {
      expect(collect(new SseFrameParser(), [bytes.slice(0, split), bytes.slice(split)])).toEqual(
        expected
      );
    }
  });

  it("parses newline-delimited raw JSON frames", () => {
    expect(parseSseBody('{"type":"response.created"}\n{"type":"response.failed"}\n')).toEqual([
      { eventName: null, data: '{"type":"response.created"}' },
      { eventName: null, data: '{"type":"response.failed"}' },
    ]);
  });

  it("bounds an incomplete frame and reports frames completed earlier in the chunk", () => {
    const parser = new SseFrameParser({ maxBufferedCharacters: 32 });
    try {
      parser.push(
        new TextEncoder().encode(`data: {"type":"response.created"}\n\ndata: ${"x".repeat(64)}`)
      );
      throw new Error("expected parser overflow");
    } catch (error) {
      expect(error).toBeInstanceOf(SseFrameBufferLimitError);
      expect((error as SseFrameBufferLimitError).completedFrames).toEqual([
        { eventName: null, data: '{"type":"response.created"}' },
      ]);
    }
  });

  it("rejects invalid UTF-8 instead of manufacturing replacement content", () => {
    const parser = new SseFrameParser();
    expect(() => parser.push(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});
