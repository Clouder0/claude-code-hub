/**
 * Measure the CCH review projection, identity-encoded handoff, and optional live Rust ingress.
 * Run one scenario per process so retained-memory deltas are comparable:
 *
 *   bun build scripts/benchmark-cyber-check-admission.ts \
 *     --target=node --outfile=/tmp/cyber-check-admission-bench.mjs
 *   node --expose-gc /tmp/cyber-check-admission-bench.mjs history-1m
 *
 * Set CYBER_CHECK_BENCH_URL and CYBER_CHECK_BENCH_TOKEN to include unique fast-path
 * submissions to a running service configured with async sampling disabled. The output is
 * one JSON object; it contains no request content.
 */
import { zstdCompressSync } from "node:zlib";
import { submitReview } from "../src/lib/cyber-check/client";
import { projectFinalResponsesRequest } from "../src/lib/cyber-check/projection";
import type { ReviewRequestEnvelope } from "../src/lib/cyber-check/types";

const KIB = 1024;
const MIB = 1024 * KIB;

const scenarioSpecs = {
  "text-1k": { kind: "history", contentBytes: 1 * KIB, defaultIterations: 250 },
  "history-100k": { kind: "history", contentBytes: 100 * KIB, defaultIterations: 100 },
  "history-1m": { kind: "history", contentBytes: 1 * MIB, defaultIterations: 30 },
  "history-7_5m": { kind: "history", contentBytes: 7.5 * MIB, defaultIterations: 5 },
  "inline-image-1m": { kind: "image", contentBytes: 1 * MIB, defaultIterations: 20 },
} as const;

type ScenarioName = keyof typeof scenarioSpecs;
type MemorySnapshot = Pick<
  NodeJS.MemoryUsage,
  "rss" | "heapUsed" | "external" | "arrayBuffers"
>;

const scenario = parseScenario(process.argv[2]);
const spec = scenarioSpecs[scenario];
const iterations = process.argv[3]
  ? parsePositiveInteger(process.argv[3], "iterations")
  : spec.defaultIterations;
const serviceUrl = process.env.CYBER_CHECK_BENCH_URL;
const serviceToken = process.env.CYBER_CHECK_BENCH_TOKEN;
if (Boolean(serviceUrl) !== Boolean(serviceToken)) {
  throw new Error("CYBER_CHECK_BENCH_URL and CYBER_CHECK_BENCH_TOKEN must be set together");
}

const message =
  spec.kind === "history"
    ? historyMessage(spec.contentBytes)
    : inlineImageMessage(spec.contentBytes);
const bodyString = JSON.stringify(message);
const identity = {
  gateway: "cch-admission-benchmark",
  requestId: `warmup-${scenario}`,
  principalId: "benchmark-principal",
  credentialId: "benchmark-credential",
  sessionId: `benchmark-session-${scenario}`,
  sequence: 1,
};

for (let index = 0; index < Math.min(iterations, 5); index += 1) {
  const packet = projectFinalResponsesRequest({ identity, message, bodyString });
  JSON.stringify(packet);
}
forceGc();
const baseline = memory();

let heldPacket: ReviewRequestEnvelope | null = null;
let heldPacketJson = "";
const projectionMilliseconds: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  heldPacket = projectFinalResponsesRequest({ identity, message, bodyString });
  heldPacketJson = JSON.stringify(heldPacket);
  projectionMilliseconds.push(performance.now() - started);
}
forceGc();
const projectionHeld = memory();

let heldCompressed = Buffer.alloc(0);
const compressionMilliseconds: number[] = [];
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  heldCompressed = zstdCompressSync(heldPacketJson);
  compressionMilliseconds.push(performance.now() - started);
}
forceGc();
const compressionHeld = memory();

let serviceMilliseconds: number[] | null = null;
if (serviceUrl && serviceToken && heldPacket) {
  const basePacket = heldPacket;
  const config = {
    mode: "shadow" as const,
    baseUrl: new URL(serviceUrl),
    gatewayToken: serviceToken,
    gatewayId: "cch-admission-benchmark",
  };
  const submit = async (index: number): Promise<void> => {
    const packet: ReviewRequestEnvelope = {
      ...basePacket,
      identity: {
        ...basePacket.identity,
        request_id: `bench-${scenario}-${index}:${basePacket.source.body_sha256}`,
        sequence: index + 3,
      },
    };
    const result = await submitReview(config, packet);
    if (
      result.status !== "completed" ||
      result.decision !== "allow" ||
      result.reason !== "fast_path"
    ) {
      throw new Error(`live service did not take the fast path: ${JSON.stringify(result)}`);
    }
  };

  for (let index = -2; index < 0; index += 1) await submit(index);
  serviceMilliseconds = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await submit(index);
    serviceMilliseconds.push(performance.now() - started);
  }
}

process.stdout.write(
  `${JSON.stringify({
    scenario,
    iterations,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    sourceBodyBytes: Buffer.byteLength(bodyString),
    reviewPacketBytes: Buffer.byteLength(heldPacketJson),
    identityEncodedZstdBytes: heldCompressed.byteLength,
    zstdRatio: heldCompressed.byteLength / Buffer.byteLength(heldPacketJson),
    projectionAndSerializationMs: distribution(projectionMilliseconds),
    zstdCompressionMs: distribution(compressionMilliseconds),
    liveIdentityIngressMs: serviceMilliseconds ? distribution(serviceMilliseconds) : null,
    memory: {
      baseline,
      projectionHeld,
      compressionHeld,
      projectionHeldDelta: subtract(projectionHeld, baseline),
      compressionHeldDelta: subtract(compressionHeld, projectionHeld),
      note: "retained snapshots after forced GC; not transient peak RSS",
    },
  })}\n`
);

function parseScenario(value: string | undefined): ScenarioName {
  if (value && Object.hasOwn(scenarioSpecs, value)) return value as ScenarioName;
  throw new RangeError(`scenario must be one of: ${Object.keys(scenarioSpecs).join(", ")}`);
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function historyMessage(contentBytes: number): Record<string, unknown> {
  const chunkBytes = 512 * KIB;
  const input: Array<Record<string, unknown>> = [];
  let remaining = contentBytes;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, chunkBytes);
    const text = sourceLikeText(size, index);
    if (index % 2 === 0) {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      });
    } else {
      input.push({
        type: "function_call_output",
        call_id: `benchmark_call_${index}`,
        output: text,
      });
    }
    remaining -= size;
    index += 1;
  }
  return {
    model: "gpt-5.6-sol",
    instructions: "Work only in the controlled repository and preserve its test contracts.",
    input,
    stream: true,
    store: false,
  };
}

function inlineImageMessage(decodedBytes: number): Record<string, unknown> {
  const bytes = pseudoRandomBytes(decodedBytes);
  return {
    model: "gpt-5.6-sol",
    instructions: "Describe the attached local test fixture.",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this generated image fixture." },
          {
            type: "input_image",
            image_url: `data:image/png;base64,${bytes.toString("base64")}`,
            detail: "high",
          },
        ],
      },
    ],
    stream: true,
    store: false,
  };
}

function sourceLikeText(byteLength: number, seed: number): string {
  const buffer = Buffer.allocUnsafe(byteLength);
  let offset = 0;
  let line = seed * 10_000;
  while (offset < buffer.length) {
    const source = Buffer.from(
      `// src/module_${line % 997}/parser_${line % 89}.rs\n` +
        `let parsed_${line % 251} = parse_fixture(input_${line % 127})?; ` +
        `assert_eq!(parsed_${line % 251}.items.len(), ${(line % 31) + 1});\n`
    );
    const count = Math.min(source.length, buffer.length - offset);
    source.copy(buffer, offset, 0, count);
    offset += count;
    line += 1;
  }
  return buffer.toString("utf8");
}

function pseudoRandomBytes(byteLength: number): Buffer {
  const bytes = Buffer.allocUnsafe(byteLength);
  let state = 0x6d2b79f5;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
  };
}

function percentile(sorted: number[], quantile: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
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
