import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";

const traceProxyRequest = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/langfuse/trace-proxy-request", () => ({ traceProxyRequest }));

import { emitProxyLangfuseTrace } from "@/lib/langfuse/emit-proxy-trace";

describe("emitProxyLangfuseTrace", () => {
  const originalPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const originalSecretKey = process.env.LANGFUSE_SECRET_KEY;

  beforeEach(() => {
    traceProxyRequest.mockClear();
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
  });

  afterEach(() => {
    if (originalPublicKey === undefined) delete process.env.LANGFUSE_PUBLIC_KEY;
    else process.env.LANGFUSE_PUBLIC_KEY = originalPublicKey;
    if (originalSecretKey === undefined) delete process.env.LANGFUSE_SECRET_KEY;
    else process.env.LANGFUSE_SECRET_KEY = originalSecretKey;
  });

  test("freezes the final forwarded model into the async trace snapshot", async () => {
    const finalRequest = {
      model: "gpt-5.6-terra",
      input: [{ role: "user", content: "hello" }],
      stream: true,
    };
    const session = {
      startTime: Date.now(),
      method: "POST",
      headers: new Headers(),
      request: {
        message: { model: "gpt-5.6-sol", input: finalRequest.input, stream: true },
        log: "",
        model: "gpt-5.6-sol",
      },
      userAgent: "codex-test",
      provider: { id: 1, name: "openai", providerType: "openai-compatible" },
      messageContext: null,
      ttfbMs: 10,
      forwardStartTime: Date.now(),
      forwardedRequestBody: JSON.stringify(finalRequest),
      sessionId: "langfuse-final-model",
      originalFormat: "openai",
      getProviderChain: () => [],
      getSpecialSettings: () => null,
      getCacheTtlResolved: () => null,
      getContext1mApplied: () => false,
      getCurrentModel: () => "gpt-5.6-sol",
      getBillingModel: () => "gpt-5.6-terra",
      getBillingRequestMessage: () => finalRequest,
      getOriginalModel: () => "gpt-5.6-sol",
      isModelRedirected: () => false,
      getEndpoint: () => "/v1/responses",
      getRequestSequence: () => 1,
      getMessagesLength: () => 1,
    } as unknown as ProxySession;

    emitProxyLangfuseTrace(session, {
      responseHeaders: new Headers(),
      responseText: '{"ok":true}',
      usageMetrics: null,
      costUsd: "0.01",
      statusCode: 200,
      durationMs: 20,
      isStreaming: true,
      sseEventCount: 1,
    });

    await vi.waitFor(() => expect(traceProxyRequest).toHaveBeenCalledTimes(1));
    const snapshot = traceProxyRequest.mock.calls[0]?.[0].session;
    expect(snapshot.request.model).toBe("gpt-5.6-terra");
    expect(snapshot.request.message.model).toBe("gpt-5.6-terra");
    expect(snapshot.getCurrentModel()).toBe("gpt-5.6-terra");
    expect(snapshot.getBillingModel()).toBe("gpt-5.6-terra");
    expect(snapshot.isModelRedirected()).toBe(true);
  });
});
