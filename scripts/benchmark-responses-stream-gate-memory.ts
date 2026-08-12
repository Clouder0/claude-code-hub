/**
 * Measure the Responses semantic gate at its default retained-prefix caps.
 *
 * Bundle for the production Node/V8 runtime, then run one isolated scenario:
 *
 *   bun build scripts/benchmark-responses-stream-gate-memory.ts \
 *     --target=node --outfile=/tmp/responses-stream-gate-memory.mjs
 *   node --expose-gc /tmp/responses-stream-gate-memory.mjs 3 4
 *
 * Arguments are simultaneous hedge attempts per request, concurrent requests,
 * and an optional fixture (`complete` or `partial`). The output is one JSON
 * object in bytes.
 */
import {
  DEFAULT_RESPONSES_STREAM_GATE_CAPS,
  runResponsesStreamContentGate,
  type ResponsesStreamGateResult,
} from "../src/app/v1/_lib/proxy/stream-gate/responses-content-gate";

declare global {
  var gc: (() => void) | undefined;
}

type MemorySnapshot = Pick<
  NodeJS.MemoryUsage,
  "rss" | "heapUsed" | "external" | "arrayBuffers"
>;

const attemptsPerRequest = parsePositiveInteger(process.argv[2], "attemptsPerRequest");
const concurrentRequests = parsePositiveInteger(process.argv[3], "concurrentRequests");
const fixture = process.argv[4] ?? "complete";
if (fixture !== "complete" && fixture !== "partial") {
  throw new RangeError("fixture must be complete or partial");
}
const gateCount = attemptsPerRequest * concurrentRequests;
if (!Number.isSafeInteger(gateCount)) throw new RangeError("gateCount must be a safe integer");

const encoder = new TextEncoder();
const caps = DEFAULT_RESPONSES_STREAM_GATE_CAPS;

function parsePositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function frame(type: string, payload: Record<string, unknown>): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

function memory(): MemorySnapshot {
  const value = process.memoryUsage();
  return {
    rss: value.rss,
    heapUsed: value.heapUsed,
    external: value.external,
    arrayBuffers: value.arrayBuffers,
  };
}

function subtract(after: MemorySnapshot, before: MemorySnapshot): MemorySnapshot {
  return {
    rss: after.rss - before.rss,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  };
}

function forceGc(): void {
  for (let index = 0; index < 4; index += 1) globalThis.gc?.();
}

async function warmUp(): Promise<void> {
  const reader = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(frame("response.created", { response: { id: "warmup" } }));
      controller.enqueue(frame("response.output_text.delta", { delta: "ok" }));
      controller.close();
    },
  }).getReader();
  const result = await runResponsesStreamContentGate(reader, {
    prebufferEventCap: 4,
    prebufferByteCap: 4096,
    requestEchoByteCap: 4096,
  });
  if (!result.committed) throw new Error("memory benchmark warmup did not commit");
}

function assertOverloadResults(results: readonly ResponsesStreamGateResult[]): void {
  for (const result of results) {
    if (result.committed || result.reason !== "gate_error") {
      throw new Error("memory benchmark fixture did not end with precommit overload");
    }
  }
}

await warmUp();
forceGc();
const baseline = memory();
const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
const releaseChunks: Uint8Array[][] = [];
const prefixBytesPerGate: number[] = [];
let prefixesConsumed = 0;
let resolveAllPrefixes: (() => void) | null = null;
const allPrefixes = new Promise<void>((resolve) => {
  resolveAllPrefixes = resolve;
});

let gatePromises: Promise<ResponsesStreamGateResult>[] | null = Array.from(
  { length: gateCount },
  (_, index) => {
    const heldChunks =
      fixture === "complete"
        ? [
            frame("response.created", {
              response: {
                id: `response_${index}`,
                instructions: "e".repeat(caps.requestEchoByteCap - 2048),
                error: null,
              },
            }),
            frame("response.metadata", {
              metadata: {
                trace: `gate_${index}`,
                pad: "n".repeat(caps.prebufferByteCap - 2048),
              },
            }),
          ]
        : [
            encoder.encode(
              `data: {"type":"response.created","response":{"id":"response_${index}",` +
                `"instructions":"${"e".repeat(
                  caps.prebufferByteCap + caps.requestEchoByteCap - 4096
                )}`
            ),
          ];
    const release =
      fixture === "complete"
        ? []
        : [encoder.encode('","error":null}}\n\n')];
    release.push(
      frame("response.failed", {
        response: { error: { code: "server_is_overloaded", message: "overloaded" } },
      })
    );
    releaseChunks.push(release);
    prefixBytesPerGate.push(
      heldChunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    );
    let chunksSeen = 0;
    const reader = new ReadableStream<Uint8Array>({
      start(controller) {
        controllers.push(controller);
        for (const chunk of heldChunks) controller.enqueue(chunk);
      },
    }).getReader();

    return runResponsesStreamContentGate(reader, {
      ...caps,
      onChunk() {
        chunksSeen += 1;
        if (chunksSeen !== heldChunks.length) return;
        prefixesConsumed += 1;
        if (prefixesConsumed === gateCount) resolveAllPrefixes?.();
      },
    });
  }
);

await allPrefixes;
await new Promise<void>((resolve) => setImmediate(resolve));
forceGc();
const held = memory();

for (const [index, controller] of controllers.entries()) {
  for (const chunk of releaseChunks[index] ?? []) controller.enqueue(chunk);
  controller.close();
}

let results: ResponsesStreamGateResult[] | null = await Promise.all(gatePromises);
assertOverloadResults(results);
gatePromises = null;
results = null;
controllers.length = 0;
await new Promise<void>((resolve) => setImmediate(resolve));
forceGc();
const released = memory();

process.stdout.write(
  `${JSON.stringify({
    attemptsPerRequest,
    concurrentRequests,
    fixture,
    gateCount,
    configuredRawPrefixBytesPerAttempt: caps.prebufferByteCap + caps.requestEchoByteCap,
    heldRawPrefixBytes: prefixBytesPerGate.reduce((total, value) => total + value, 0),
    maximumHeldRawPrefixBytesPerAttempt: Math.max(...prefixBytesPerGate),
    baseline,
    held,
    released,
    heldDelta: subtract(held, baseline),
    releasedDelta: subtract(released, baseline),
  })}\n`
);
