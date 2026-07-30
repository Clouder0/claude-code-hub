import type { Context } from "hono";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/repository/model-price", () => ({
  findLatestPriceByModel: vi.fn(),
}));

vi.mock("@/repository/system-config", () => ({
  getSystemSettings: vi.fn(),
}));

import { ProxySession } from "@/app/v1/_lib/proxy/session";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Minimal Hono Context stub covering the surface `ProxySession.fromContext`
 * touches: method, url, header() (all + by-name), and raw Request.
 */
function makeContext(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array | string
): Context {
  const req = new Request(url, { method: "POST", headers, body });
  return {
    req: {
      method: "POST",
      url,
      raw: req,
      header: (name?: string) => {
        if (name === undefined) {
          const all: Record<string, string> = {};
          req.headers.forEach((value, key) => {
            all[key] = value;
          });
          return all;
        }
        return req.headers.get(name) ?? undefined;
      },
    },
  } as unknown as Context;
}

describe("ProxySession.fromContext request body decompression", () => {
  it("decompresses a high-concurrency zstd Codex SSE body without retaining its buffer", async () => {
    const payload = JSON.stringify({
      model: "gpt-5-codex",
      stream: true,
      input: [{ role: "user", content: "ping" }],
    });
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json", "content-encoding": "zstd" },
      zstdCompressSync(encoder.encode(payload))
    );

    const session = await ProxySession.fromContext(ctx, {
      highConcurrencyModeEnabled: true,
    });

    expect(session.request.message.model).toBe("gpt-5-codex");
    expect(session.request.message.stream).toBe(true);
    expect(session.request.buffer).toBeUndefined();
    expect(session.request.log).toContain("high_concurrency_codex_request_body_omitted");
    expect(ctx.req.raw.bodyUsed).toBe(true);
    // Upstream must not be told the (now plaintext) body is still zstd-encoded.
    expect(session.headers.get("content-encoding")).toBeNull();
  });

  it("decompresses a gzip /v1/messages body", async () => {
    const payload = JSON.stringify({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    const ctx = makeContext(
      "https://hub.test/v1/messages",
      { "content-type": "application/json", "content-encoding": "gzip" },
      gzipSync(encoder.encode(payload))
    );

    const session = await ProxySession.fromContext(ctx, {
      highConcurrencyModeEnabled: true,
    });

    expect(session.request.message.model).toBe("claude-sonnet-4-5");
    expect(decoder.decode(session.request.buffer)).toBe(payload);
    expect(session.headers.get("content-encoding")).toBeNull();
  });

  it("retains normal-mode Codex diagnostics and decoded buffer", async () => {
    const sentinel = "normal-mode-request-content";
    const payload = JSON.stringify({
      model: "gpt-5-codex",
      stream: true,
      input: [{ role: "user", content: sentinel }],
    });
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json" },
      encoder.encode(payload)
    );

    const session = await ProxySession.fromContext(ctx);

    expect(decoder.decode(session.request.buffer)).toBe(payload);
    expect(session.request.log).toContain(sentinel);
    expect(session.request.note).toBeUndefined();
    expect(ctx.req.raw.bodyUsed).toBe(false);
  });

  it("bounds high-concurrency Codex SSE diagnostics independently of input size", async () => {
    const sentinel = "sensitive-request-content".repeat(50_000);
    const payload = JSON.stringify({
      model: `gpt-5-codex-${"m".repeat(1_000)}`,
      stream: true,
      service_tier: `priority-${"t".repeat(1_000)}`,
      instructions: sentinel,
      input: [{ role: "user", content: sentinel }],
      tools: [{ type: "function", name: "example" }],
      prompt_cache_key: sentinel,
    });
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json" },
      encoder.encode(payload)
    );

    const session = await ProxySession.fromContext(ctx, {
      highConcurrencyModeEnabled: true,
    });
    const summary = JSON.parse(session.request.log);

    expect(session.request.buffer).toBeUndefined();
    expect(session.request.log.length).toBeLessThan(1_024);
    expect(session.request.log).not.toContain("sensitive-request-content");
    expect(summary).toMatchObject({
      diagnostic: "high_concurrency_codex_request_body_omitted",
      stream: true,
      inputItemCount: 1,
      toolCount: 1,
      hasInstructions: true,
      hasPromptCacheKey: true,
      receivedBodyBytes: payload.length,
      decodedBodyBytes: payload.length,
    });
    expect(summary.model).toHaveLength(256);
    expect(summary.serviceTier).toHaveLength(256);
  });

  it("keeps the buffer for non-streaming responses even in high-concurrency mode", async () => {
    const payload = JSON.stringify({
      model: "gpt-5-codex",
      stream: false,
      input: "non-streaming",
    });
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json" },
      encoder.encode(payload)
    );

    const session = await ProxySession.fromContext(ctx, {
      highConcurrencyModeEnabled: true,
    });

    expect(decoder.decode(session.request.buffer)).toBe(payload);
    expect(session.request.log).toContain("non-streaming");
  });

  it("decompresses for the raw-passthrough /v1/responses/compact endpoint", async () => {
    const payload = JSON.stringify({ model: "gpt-5-codex", input: "compact me" });
    const ctx = makeContext(
      "https://hub.test/v1/responses/compact",
      { "content-type": "application/json", "content-encoding": "zstd" },
      zstdCompressSync(encoder.encode(payload))
    );

    const session = await ProxySession.fromContext(ctx, {
      highConcurrencyModeEnabled: true,
    });

    // Raw passthrough forwards session.request.buffer verbatim -> must be plaintext.
    expect(decoder.decode(session.request.buffer)).toBe(payload);
    expect(session.headers.get("content-encoding")).toBeNull();
    expect(ctx.req.raw.bodyUsed).toBe(false);
  });

  it("leaves uncompressed requests untouched", async () => {
    const payload = JSON.stringify({ model: "gpt-5-codex", input: "plain" });
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json" },
      encoder.encode(payload)
    );

    const session = await ProxySession.fromContext(ctx);

    expect(session.request.message.model).toBe("gpt-5-codex");
    expect(decoder.decode(session.request.buffer)).toBe(payload);
    expect(session.headers.get("content-encoding")).toBeNull();
  });

  it("surfaces a ProxyError(415) for unsupported content encodings", async () => {
    const payload = JSON.stringify({ model: "gpt-5-codex", input: "exotic" });
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json", "content-encoding": "snappy" },
      encoder.encode(payload)
    );

    await expect(ProxySession.fromContext(ctx)).rejects.toMatchObject({
      statusCode: 415,
      message: "Unsupported content-encoding: snappy.",
    });
  });

  it("surfaces a ProxyError(400) when a declared-compressed body is corrupt", async () => {
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json", "content-encoding": "gzip" },
      encoder.encode("this is not a valid gzip stream")
    );

    await expect(ProxySession.fromContext(ctx)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("surfaces a ProxyError(400) when the content-encoding chain has too many layers", async () => {
    const payload = JSON.stringify({ model: "gpt-5-codex", input: "x" });
    const ctx = makeContext(
      "https://hub.test/v1/responses",
      { "content-type": "application/json", "content-encoding": "gzip, gzip, gzip, gzip" },
      gzipSync(encoder.encode(payload))
    );

    await expect(ProxySession.fromContext(ctx)).rejects.toMatchObject({ statusCode: 400 });
  });
});
