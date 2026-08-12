export type SseFrame = {
  eventName: string | null;
  data: string;
};

export type SseFrameParserOptions = {
  maxBufferedCharacters?: number;
  bufferLimitExemption?: {
    maxBufferedCharacters: number;
    matches: (eventName: string | null, dataHead: string) => boolean;
  };
};

const DATA_HEAD_MAX_CHARACTERS = 128;
const LINE_HEAD_MAX_CHARACTERS = DATA_HEAD_MAX_CHARACTERS + "data: ".length;

export class SseFrameBufferLimitError extends Error {
  readonly completedFrames: readonly SseFrame[];

  constructor(maxBufferedCharacters: number, completedFrames: readonly SseFrame[] = []) {
    super(`SSE parser buffered data exceeded ${maxBufferedCharacters} characters`);
    this.name = "SseFrameBufferLimitError";
    this.completedFrames = completedFrames;
  }
}

export class SseFrameParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private lineParts: string[] = [];
  private lineCharacters = 0;
  private lineHead = "";
  private skipLeadingLf = false;
  private currentEvent: string | null = null;
  private dataLines: string[] = [];
  private dataCharacters = 0;
  private dataHead = "";

  constructor(private readonly options: SseFrameParserOptions = {}) {}

  push(chunk: Uint8Array): SseFrame[] {
    let decoded: string;
    try {
      decoded = this.decoder.decode(chunk, { stream: true });
    } catch (error) {
      this.resetRetainedState();
      throw error;
    }
    return this.consume(decoded);
  }

  pushText(text: string): SseFrame[] {
    return this.consume(text);
  }

  finish(): SseFrame[] {
    let tail: string;
    try {
      tail = this.decoder.decode();
    } catch (error) {
      this.resetRetainedState();
      throw error;
    }
    const frames = this.consume(tail);
    this.skipLeadingLf = false;
    if (this.lineCharacters > 0) {
      const frame = this.handleLine(this.takeLine());
      if (frame) frames.push(frame);
    }
    const last = this.flush();
    if (last) frames.push(last);
    return frames;
  }

  isCurrentBufferExempt(): boolean {
    const exemption = this.options.bufferLimitExemption;
    return exemption?.matches(this.currentEvent, this.currentDataHead()) ?? false;
  }

  private consume(text: string): SseFrame[] {
    const frames: SseFrame[] = [];
    let start = 0;
    try {
      if (this.skipLeadingLf) {
        if (text.length === 0) return frames;
        if (text.charCodeAt(0) === 10) start = 1;
        this.skipLeadingLf = false;
      }

      for (let index = start; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code !== 10 && code !== 13) continue;

        this.appendLinePart(text.slice(start, index));
        const frame = this.handleLine(this.takeLine());
        if (frame) frames.push(frame);

        if (code === 13) {
          if (index + 1 < text.length && text.charCodeAt(index + 1) === 10) {
            index += 1;
          } else if (index === text.length - 1) {
            this.skipLeadingLf = true;
          }
        }
        start = index + 1;
      }

      this.appendLinePart(text.slice(start));
      this.assertBufferLimit();
      return frames;
    } catch (error) {
      if (error instanceof SseFrameBufferLimitError && frames.length > 0) {
        throw new SseFrameBufferLimitError(this.options.maxBufferedCharacters ?? 0, frames);
      }
      throw error;
    }
  }

  private appendLinePart(part: string): void {
    if (part.length === 0) return;
    this.lineParts.push(part);
    this.lineCharacters += part.length;
    if (this.lineHead.length < LINE_HEAD_MAX_CHARACTERS) {
      this.lineHead += part.slice(0, LINE_HEAD_MAX_CHARACTERS - this.lineHead.length);
    }
  }

  private takeLine(): string {
    const line = this.lineParts.length === 1 ? this.lineParts[0] : this.lineParts.join("");
    this.lineParts = [];
    this.lineCharacters = 0;
    this.lineHead = "";
    return line ?? "";
  }

  private handleLine(line: string): SseFrame | null {
    if (line.length === 0) return this.flush();
    if (line.startsWith(":")) return null;
    if (line.startsWith("event:")) {
      this.currentEvent = line.slice(6).trim();
      this.assertBufferLimit();
      return null;
    }
    if (line.startsWith("data:")) {
      const data = line.slice(5).replace(/^\s/u, "");
      if (this.dataLines.length > 0) this.dataCharacters += 1;
      this.dataCharacters += data.length;
      this.dataLines.push(data);
      this.appendDataHead(data);
      this.assertBufferLimit();
      return null;
    }

    const candidate = line.trim();
    if (
      this.currentEvent === null &&
      this.dataLines.length === 0 &&
      (candidate.startsWith("{") || candidate.startsWith("["))
    ) {
      return { eventName: null, data: candidate };
    }
    return null;
  }

  private flush(): SseFrame | null {
    const eventName = this.currentEvent;
    this.currentEvent = null;
    if (this.dataLines.length === 0) {
      this.dataHead = "";
      return null;
    }
    const data = this.dataLines.join("\n");
    this.dataLines = [];
    this.dataCharacters = 0;
    this.dataHead = "";
    return { eventName, data };
  }

  private appendDataHead(data: string): void {
    if (this.dataHead.length >= DATA_HEAD_MAX_CHARACTERS) return;
    if (this.dataLines.length > 1) this.dataHead += "\n";
    this.dataHead += data.slice(0, DATA_HEAD_MAX_CHARACTERS - this.dataHead.length);
  }

  private currentDataHead(): string {
    if (this.dataHead.length >= DATA_HEAD_MAX_CHARACTERS) return this.dataHead;
    if (!this.lineHead.startsWith("data:")) return this.dataHead;

    const tailData = this.lineHead.slice(5).replace(/^\s/u, "");
    const separator = this.dataLines.length > 0 && this.dataHead.length > 0 ? "\n" : "";
    return `${this.dataHead}${separator}${tailData}`.slice(0, DATA_HEAD_MAX_CHARACTERS);
  }

  private resetRetainedState(): void {
    this.lineParts = [];
    this.lineCharacters = 0;
    this.lineHead = "";
    this.currentEvent = null;
    this.dataLines = [];
    this.dataCharacters = 0;
    this.dataHead = "";
    this.skipLeadingLf = false;
  }

  private assertBufferLimit(): void {
    const maxBufferedCharacters = this.options.maxBufferedCharacters;
    if (maxBufferedCharacters === undefined) return;

    const bufferedCharacters =
      this.lineCharacters + (this.currentEvent?.length ?? 0) + this.dataCharacters;
    if (bufferedCharacters <= maxBufferedCharacters) return;

    const exemption = this.options.bufferLimitExemption;
    if (
      exemption &&
      bufferedCharacters <= exemption.maxBufferedCharacters &&
      exemption.matches(this.currentEvent, this.currentDataHead())
    ) {
      return;
    }
    this.resetRetainedState();
    throw new SseFrameBufferLimitError(maxBufferedCharacters);
  }
}

export function parseSseBody(body: string): SseFrame[] {
  const parser = new SseFrameParser();
  return [...parser.pushText(body), ...parser.finish()];
}
